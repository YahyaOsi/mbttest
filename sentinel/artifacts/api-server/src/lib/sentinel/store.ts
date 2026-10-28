import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import type { State, Settings, Activity, Position } from "./types";
import { moonbagPreset, launchpadExitPreset } from "./exit-policy";
import { syncRpcConfig } from "./rpc-config";
import { currentCandidateWarnings } from "./cost-policy";
import { reconcilePipeline } from "./pipeline-state";
import { rpcPool } from "./rpc-pool";
import { metric, flushMetrics, metricsSaved } from "./telemetry";

export class TradingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const now = () => new Date().toISOString();
export const day = () => now().slice(0, 10);
export const defaults: Settings = {
  pumpHuntEnabled: false,
  readFailoverEnabled: true, jitoEnabled: false, jitoMaxTipPct: 0.25, jitoMaxTipLamports: 100000,
  snipePriorityMultiplier: 2, confidenceThreshold: 80, normalEquityPct: 8, snipeEquityPct: 15,
  dailyLossEquityPct: 20, retainedTokenPct: 0.1,
  earlyTakeProfitPct: 60, earlySellPct: 20,
  copyTradingEnabled: false, trackFomoHandles: false, copyTargets: [],
  riskMode: "conservative", crazyStrategy: "all", crazyEquityPct: 20,
  crazyMinLiquidityUsd: 1000, crazyMinVolumeUsd: 0, crazyMaxPositions: 3, crazySlippageBps: 1000,
  crazyTop10Pct: 25, crazyWalletAllocationPct: 20, crazyAcknowledged: false,
  mode: "paper", paperBalanceUsd: 10, positionSizeUsd: 5.5, maxPositions: 1, maxEntriesPerDay: 3,
  dailyLossLimitUsd: 2, minLiquidityUsd: 10000, minVolumeUsd: 100000,
  minAgeMinutes: 120, maxTopHolderPct: 15, maxPriceImpactPct: 1,
  slippageBps: 100, emergencySlippageBps: 300, emergencyMaxPriceImpactPct: 5,
  stopLossPct: 10, ...launchpadExitPreset, secondSellPct: 20, adaptiveExitsEnabled: true,
  minAiScore: 85, maxAiCallsPerDay: 100,
  scanIntervalMinutes: 2, aiIntervalMinutes: 60, aiCacheMinutes: 60, solReserve: 0.005,
  maxHoldMinutes: 120, acknowledgeRisk: false,
  // Owner requested pre-migration launchpad trading; curves get their own floors.
  launchpadCurvesEnabled: true, curveMinLiquidityUsd: 10000, curveMinAgeMinutes: 10,
};
export function event(s: State, category: string, message: string, level: Activity["level"] = "info", mint: string | null = null) {
  if (["scanner", "entry-summary", "execution", "entry-blocked", "watch-fallback", "ai-sweep", "worker-warning", "crazy-gate"].includes(category))
    metric(s, category, mint, { level, message });
  s.activity.unshift({ id: randomUUID(), time: now(), category, message, level, mint });
  s.activity = s.activity.slice(0, 500);
}
export function initialState(): State {
  const s: State = {
    version: 2, scanCadenceVersion: 1, pipelineVersion: 1, watchlist: {}, crazyLiquidityFloorVersion: 1, launchStrategyVersion: 1, exitPlanVersion: 1, entryEvidenceVersion: 1, crazyPolicyVersion: 1, settings: { ...defaults }, running: false, cashUsd: 10,
    cashSol: null, solPriceUsd: null, liveCashSol: 0, walletBinding: null,
    positions: [], candidates: [], activity: [], equity: [{ time: now(), valueUsd: 10 }],
    lastScanAt: null, heartbeatAt: null, lastError: null, sourceStatus: "Not scanned",
    scanned: 0, aiDay: day(), aiCalls: 0, dailyStartEquity: 10, liveCashUsd: 0,
    pending: null, cooldowns: {}, lastAiAt: null, assessments: {},
  };
  event(s, "system", "Sentinel initialized in paper mode. Two-minute discovery; advisory paid AI: 10-minute discovery / 5-minute watchlist, default 100 requests/day, then deterministic fallback. Equity-aware daily loss protection remains. Mainnet is locked.");
  return s;
}
export async function ensureAccount(userId: string) {
  await pool.query("INSERT INTO trading_accounts (user_id, state) VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING", [userId, JSON.stringify(initialState())]);
}
export async function readState(userId: string): Promise<State> {
  await ensureAccount(userId);
  const r = await pool.query("SELECT state FROM trading_accounts WHERE user_id=$1", [userId]);
  const s = normalize(r.rows[0].state);
  syncRpcConfig(s.rpcConnection, userId);
  rpcPool.setReadFailover(s.settings.readFailoverEnabled ?? true);
  return s;
}
export async function flags(userId: string) {
  const r = await pool.query("SELECT halted, emergency_requested FROM trading_accounts WHERE user_id=$1", [userId]);
  return { halted: r.rows[0]?.halted !== false, emergency: r.rows[0]?.emergency_requested === true };
}
export async function latch(userId: string, halted: boolean, emergency?: boolean) {
  await ensureAccount(userId);
  await pool.query("UPDATE trading_accounts SET halted=$2, emergency_requested=COALESCE($3::boolean,emergency_requested) WHERE user_id=$1", [userId, halted, emergency ?? null]);
}
/** Protective liquidation must not overwrite an owner's Start/Stop choice. */
export async function protectiveExit(userId: string, requested: boolean) {
  await pool.query(requested
    ? "UPDATE trading_accounts SET emergency_requested=true WHERE user_id=$1"
    : "UPDATE trading_accounts SET emergency_requested=false WHERE user_id=$1 AND halted=false",
  [userId]);
}
export const scanningUsers = new Set<string>();
export async function withState<T>(userId: string, work: (s: State, save: () => Promise<void>) => Promise<T>): Promise<T> {
  await ensureAccount(userId);
  const c = await pool.connect();
  let acquired = false;
  try {
    const lock = await c.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [`sentinel:${userId}`]);
    acquired = lock.rows[0].acquired;
    if (!acquired) throw new TradingError("Bot is processing an operation. Stop requests are latched immediately; retry other actions shortly.", 409);
    const result = await c.query("SELECT state FROM trading_accounts WHERE user_id=$1", [userId]);
    const s = normalize(result.rows[0].state);
    syncRpcConfig(s.rpcConnection, userId);
    rpcPool.setReadFailover(s.settings.readFailoverEnabled ?? true);
    const save = async () => {
      reconcilePipeline(s);
      await c.query("BEGIN");
      try {
        await c.query("UPDATE trading_accounts SET state=$2::jsonb, updated_at=now() WHERE user_id=$1", [userId, JSON.stringify(s)]);
        await flushMetrics(s, userId, (sql, values) => c.query(sql, values));
        await c.query("COMMIT");
        metricsSaved(s);
      } catch (e) { await c.query("ROLLBACK"); throw e; }
      syncRpcConfig(s.rpcConnection, userId);
    };
    try {
      const output = await work(s, save);
      await save();
      return output;
    } catch (e) {
      s.lastError = e instanceof TradingError ? e.message : "Provider operation failed. Trading did not proceed; retry or review connections.";
      event(s, "error", s.lastError, "error");
      await save();
      throw e;
    }
  } finally {
    if (acquired) await c.query("SELECT pg_advisory_unlock(hashtext($1))", [`sentinel:${userId}`]);
    c.release();
  }
}
export function currentPositions(s: State) { return s.positions.filter(p => p.mode === s.settings.mode && (p.mode === "paper" || p.walletAddress === s.walletBinding)); }
export function equity(s: State) {
  return cashUsd(s) +
    currentPositions(s).filter(p => ["open", "pending", "retained"].includes(p.status)).reduce((v, p) => v + p.remainingCostUsd + p.unrealizedPnlUsd, 0);
}
export function cashUsd(s: State) {
  if (!s.solPriceUsd) return s.settings.mode === "paper" ? s.cashUsd : s.liveCashUsd;
  const sol = s.settings.mode === "paper" ? s.cashSol : s.liveCashSol;
  return sol === null ? s.cashUsd : sol * s.solPriceUsd;
}
export function normalize(raw: any): State {
  if (raw.version === 2) {
    const migrate = raw.exitPlanVersion !== 1;
    const old = { ...defaults, ...raw.settings };
    const updateEvidence = raw.entryEvidenceVersion !== 1;
    const updateCrazy = raw.crazyPolicyVersion !== 1;
    return reconcilePipeline({ ...raw, reliabilityPolicyVersion: 1, pipelineVersion: 1, watchlist: raw.watchlist ?? {}, crazyLiquidityFloorVersion: 1, launchStrategyVersion: 1, exitPlanVersion: 1, entryEvidenceVersion: 1, crazyPolicyVersion: 1,
      running: raw.running,
      ...(raw.scanCadenceVersion !== 1 ? { nextWorkerScanAt: 0 } : {}),
      lastError: raw.lastError,
      candidates: (raw.candidates ?? []).map((c: State["candidates"][number]) => currentCandidateWarnings(c, true)),
      // One-time owner-requested entry floors. Future saved choices are preserved.
      settings: { ...old, ...(raw.scanCadenceVersion !== 1 ? { scanIntervalMinutes: 2 } : {}), ...(migrate ? moonbagPreset : {}),
        ...(raw.launchStrategyVersion !== 1 ? launchpadExitPreset : {}),
        crazyTop10Pct: Math.min(old.crazyTop10Pct ?? 25, old.pumpHuntEnabled && old.riskMode === "crazy" ? 40 : 25),
        ...(updateEvidence ? { minLiquidityUsd: 10000, curveMinLiquidityUsd: 10000, minVolumeUsd: 100000 } : {}),
        ...(updateCrazy ? { crazyEquityPct: 20, crazyMinLiquidityUsd: 1000, crazyMinVolumeUsd: 0, crazyMaxPositions: 3, crazySlippageBps: 1000 } : {}),
        ...(raw.crazyLiquidityFloorVersion !== 1 ? { crazyMinLiquidityUsd: 1000 } : {}),
        ...(raw.pipelineVersion !== 1 ? { maxAiCallsPerDay: 1440, ...launchpadExitPreset } : {}),
        // Owner-authorized one-time safer policy for NEW entries only.
        ...(raw.reliabilityPolicyVersion !== 1 ? { maxAiCallsPerDay: 100, secondSellPct: 20 } : {}) },
      scanCadenceVersion: 1,
      // Old assessments were based on ambiguous null authority evidence.
      assessments: updateEvidence ? {} : (raw.assessments ?? {}),
      walletBinding: raw.walletBinding ?? null,
      positions: raw.positions.map((p: Position) => ({ ...p, walletAddress: p.walletAddress ?? null,
        ...(!p.exitPlan && !p.legacyExitSettings && ["open", "pending"].includes(p.status)
          ? { legacyExitSettings: { takeProfitPct: old.takeProfitPct, secondTakeProfitPct: old.secondTakeProfitPct,
            firstSellPct: old.firstSellPct, trailingStopPct: old.trailingStopPct } } : {}) })) } as State);
  }
  // Never reinterpret an old USDC position or in-flight signature as SOL.
  if (raw.pending || raw.positions?.some((p: Position) => ["open", "pending"].includes(p.status))) {
    throw new TradingError("Legacy USDC exposure requires manual reconciliation before SOL migration. No automatic conversion or trading is allowed.", 409);
  }
  const next = {
    ...raw, version: 2, crazyLiquidityFloorVersion: 1, launchStrategyVersion: 1, settings: { ...defaults, ...raw.settings,
      ...(raw.launchStrategyVersion !== 1 ? launchpadExitPreset : {}),
      ...(raw.crazyLiquidityFloorVersion !== 1 ? { crazyMinLiquidityUsd: 1000 } : {}),
      crazyTop10Pct: Math.min(raw.settings?.crazyTop10Pct ?? 25, raw.settings?.pumpHuntEnabled ? 40 : 25),
      maxAiCallsPerDay: Math.min(raw.settings?.maxAiCallsPerDay ?? 12, 12),
      scanIntervalMinutes: 2, aiIntervalMinutes: 60, aiCacheMinutes: 60, solReserve: 0.005 },
    running: false, cashSol: null, solPriceUsd: null, liveCashSol: 0,
    lastAiAt: null, assessments: {}, walletBinding: null,
    positions: (raw.positions ?? []).map((p: Position) => ({ ...p, walletAddress: null, originalCostSol: 0, remainingCostSol: 0, realizedPnlSol: 0 })),
  } as State;
  event(next, "system", "Migrated to SOL settlement and low-cost AI defaults. Bot paused for review; no wallet funds converted.");
  return next;
}
export function dailyLoss(s: State) { return Math.max(0, s.dailyStartEquity - equity(s)); }
export function dailyLossLimit(s: State) {
  // Use the smaller current/start equity so drawdowns cannot increase the cap.
  const current = equity(s);
  const base = Math.max(0, Math.min(s.dailyStartEquity > 0 ? s.dailyStartEquity : current, current));
  return Math.min(s.settings.dailyLossLimitUsd, base * (s.settings.dailyLossEquityPct ?? 20) / 100);
}
export function rollDay(s: State) {
  if (s.aiDay !== day()) {
    s.aiDay = day(); s.aiCalls = 0; s.dailyStartEquity = equity(s);
    event(s, "system", "UTC day changed. AI budget and daily loss baseline reset.");
  }
}
