import type { Candidate, CopySignal, CrazyObservation, CrazyState, Settings, State } from "./types";
import { confidence } from "./confidence";
import { huntActivity, huntLiquidityFloor, pumpHunt, marketFreshnessMs } from "./pump-hunt-policy";

export const MAX_COPY_CHASE_PCT = 15;
export const MAX_COPY_LAG_MS = 30000;
export const FOMO_SOURCE = "Independent Fomo Api · Fomo-reported daily leaderboard";
import { DISCOVERY_INTERVAL_MS } from "./scan-schedule";
export const scanMinutes = (s: Settings) => s.riskMode === "crazy" ? DISCOVERY_INTERVAL_MS / 60000 : s.scanIntervalMinutes;
export const entryCooldownMs = (s: Settings) => s.riskMode === "crazy" ? 30000 : 3600000;
export const positionLimit = (s: Settings) => s.riskMode === "crazy" ? Math.min(s.crazyMaxPositions ?? 3, pumpHunt(s) ? 4 : 5) : s.maxPositions;
/** Per-mode execution policy. Never expands the owner-selected slippage cap. */
export function executionSettings(s: Settings, c?: Candidate): Settings {
  if (s.riskMode !== "crazy") return s;
  const cap = s.crazySlippageBps ?? 1000;
  const slippageBps = c ? Math.min(cap, c.ageMinutes <= 5 || Math.abs(c.change5mPct) >= 10 ? 1500 : 1000) : cap;
  return { ...s, slippageBps, emergencySlippageBps: Math.max(s.emergencySlippageBps, cap),
    maxPriceImpactPct: Math.max(s.maxPriceImpactPct, 5), stopLossPct: 20, trailingStopPct: 15 };
}
export function crazyState(s: State): CrazyState {
  return s.crazy ??= { observations: {}, leaders: [], cursors: {}, signals: [], consumed: [],
    lastRefreshAt: 0, lastPollAt: 0, sourceAt: null, status: "Not fetched; enabled only for Whale Tail or existing copies." };
}
/** Owner-approved percentage sizing; no dollar cap and no trade-result multiplier. */
export function positionBudget(settings: Settings, bookUsd: number, candidate?: Candidate, strategy?: string) {
  if (settings.riskMode !== "crazy") return settings.positionSizeUsd;
  if (!Number.isFinite(bookUsd) || bookUsd <= 0) return 0;
  const pct = candidate && strategy === "sniper" && confidence(candidate, settings).high
    ? settings.snipeEquityPct ?? 15 : settings.normalEquityPct ?? 8;
  if (!Number.isFinite(pct) || pct <= 0 || pct > (pumpHunt(settings) ? strategy === "sniper" && candidate && confidence(candidate, settings).high ? 12 : 8 : 15)) return 0;
  return Math.floor(bookUsd * pct / 100 * 100) / 100;
}
export function crazyMarketFilters(c: Candidate, settings: Settings, verifiedCopy = false): string[] {
  const r: string[] = [];
  if (!settings.crazyAcknowledged) r.push("High-risk mode requires explicit acknowledgement");
  if (c.flaggedSuspicious) r.push("Jupiter has flagged this mint as suspicious");
  const stamp = Date.parse(c.updatedAt);
  if (!Number.isFinite(stamp) || Date.now() - stamp > marketFreshnessMs(settings) || stamp > Date.now() + 5000) r.push("Market data is stale");
  if (!Number.isFinite(c.priceUsd) || c.priceUsd <= 0) r.push("No valid token price");
  const liquidityFloor = pumpHunt(settings) ? huntLiquidityFloor(c, settings) : Math.max(1000, settings.crazyMinLiquidityUsd ?? 1000);
  if (!Number.isFinite(c.liquidityUsd) || c.liquidityUsd < liquidityFloor) r.push(`Liquidity below Crazy Mode limit${pumpHunt(settings) ? ` ($${liquidityFloor}; $400 hard floor, $600 preferred)` : ""}`);
  const volumeFloor = settings.crazyMinVolumeUsd ?? 0;
  if (volumeFloor > 0 && (!Number.isFinite(c.volume24hUsd) || c.volume24hUsd < volumeFloor)) r.push("24h volume below Crazy Mode limit");
  if (!verifiedCopy && (pumpHunt(settings) ? !huntActivity(c) : !Number.isFinite(c.buys5m) || c.buys5m < 3))
    r.push(c.missingMarketData?.includes("activity") ? "Missing live/indexed activity evidence; no observed recent buys" : "Insufficient recent buy activity");
  return r;
}
export function observeCrazy(s: State, list: Candidate[], at = Date.now()) {
  const state = crazyState(s);
  for (const c of list) {
    if (!(c.priceUsd > 0)) continue;
    const history = (state.observations[c.mint] ?? []).filter(o => at - o.at <= 15 * 60000);
    if (!history.length || at - history.at(-1)!.at >= 15000) {
      history.push({ at, price: c.priceUsd, activity: c.volume5mUsd ?? 0 });
    }
    state.observations[c.mint] = history.slice(-30);
  }
  state.observations = Object.fromEntries(Object.entries(state.observations)
    .filter(([, h]) => h.length && at - h.at(-1)!.at <= 15 * 60000).slice(-240));
}
export function momentumSignal(c: Candidate, history: CrazyObservation[], at = Date.now()) {
  // First-observation path uses reported USD volume and transactions, not a
  // made-up local baseline or an AI probability. Avoid chasing a vertical spike.
  if (Number.isFinite(c.volume5mUsd) && c.volume5mUsd! >= 500 &&
      c.buys5m >= 10 && c.buys5m >= Math.max(1, c.sells5m) * 1.3 &&
      c.change5mPct >= 2 && c.change5mPct <= 40) return true;
  const baseline = history.filter(o => at - o.at >= 60000 && at - o.at <= 5 * 60000);
  if (baseline.length < 2 || baseline.at(-1)!.at - baseline[0].at < 30000) return false;
  const average = baseline.reduce((n, o) => n + o.activity, 0) / baseline.length;
  return average > 0 && c.volume5mUsd != null && c.volume5mUsd >= average * 1.3 &&
    c.buys5m > c.sells5m && c.change5mPct > 0;
}
export function dipSignal(c: Candidate, history: CrazyObservation[], at = Date.now()) {
  const points = history.filter(o => at - o.at <= 15 * 60000 && o.at < at);
  if (points.length < 3) return false;
  let high = 0, dipped = false, low = Infinity;
  for (const p of points) {
    high = Math.max(high, p.price);
    if (p.price <= high * 0.7) { dipped = true; low = Math.min(low, p.price); }
  }
  return dipped && c.priceUsd >= low * 1.05 && c.priceUsd <= low * 1.15 &&
    c.buys5m > c.sells5m;
}
export function copyGuard(signal: CopySignal, quotePriceSol: number, at = Date.now()) {
  const lagMs = at - signal.at;
  if (!Number.isFinite(lagMs) || lagMs < 0 || lagMs > MAX_COPY_LAG_MS) return "Leader trade is stale or future-dated";
  if (!(signal.priceSol > 0) || !Number.isFinite(quotePriceSol) || quotePriceSol <= 0) return "Leader/copy entry price unavailable";
  if (quotePriceSol > signal.priceSol * (1 + MAX_COPY_CHASE_PCT / 100)) return "Copy quote exceeds 15% maximum chase";
  return null;
}
export function recordCopyLosses(s: State) {
  const state = crazyState(s);
  for (const p of s.positions) {
    if (!p.leaderWallet || !["closed", "retained"].includes(p.status) || p.copyLossRecorded) continue;
    const leader = state.leaders.find(l => l.wallet === p.leaderWallet);
    if (leader) {
      leader.losingCopies = p.realizedPnlSol < 0 ? leader.losingCopies + 1 : 0;
      if (leader.losingCopies >= 3) leader.demoted = true;
    }
    p.copyLossRecorded = true;
  }
}
