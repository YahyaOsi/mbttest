import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "../logger";
import { assess, entryFilters } from "./analysis";
import { checkSafety, requireLive, walletAddress, walletBalances, verifyEntryLiquidity, verifyQuoteLiquidity } from "./chain";
import { executeLive, impact, reconcile } from "./execution";
import { discover, getMarkets, quote, SOL, solUsd, marketHealth } from "./market";
import {
  currentPositions, dailyLoss, dailyLossLimit, equity, event, flags, now, rollDay,
  scanningUsers, TradingError, withState, protectiveExit, readState,
} from "./store";
import type { Candidate, CopySignal, Position, State } from "./types";
import { solReturnPct } from "./native-accounting";
import { ownerId, passwordConfigured } from "../owner-auth";
import { entryBudgetAvailable } from "./entry-policy";
import { snapshotExitPlan, tierAmount, markExitFill, moonbagDecision, liquidityDrop, moonbagPreset, launchpadExitPreset } from "./exit-policy";
import { volatilityStop } from "./volatility-risk";
import { decisionMetric } from "./telemetry";
import { isPump, marketFreshnessMs, pumpHunt, sniperAgeSeconds } from "./pump-hunt-policy";
import { drainRiskAlerts, syncRiskStreams } from "./risk-stream";
import { preMigration, type CurveStatus } from "./curve-policy";
import { assessmentQueue, recordCandidateCheck, scanFilterSummary } from "./scan-policy";
import { copyGuard, crazyState, observeCrazy, positionBudget, recordCopyLosses, scanMinutes, entryCooldownMs, positionLimit, executionSettings } from "./crazy-policy";
import { entryRestrictions, workerWarning } from "./worker-policy";
import { crazyProof } from "./crazy-proof";
import { latestCopy } from "./crazy-assessment";
import { pollFomo } from "./fomo";
import { onCopyActivity } from "./copy-stream";
import { freshPumpSignal, curveProgressAllowed } from "./pump-sniping";
import { onPumpActivity, recentPumpCreations, pumpActivity } from "./pump-observations";
import { pumpMarket } from "./pump-market";
import { checkLivePumpMints, livePumpHint, livePumpRecord, livePumpStatus, startLivePumpFeed, livePumpActivity } from "./pump-live-feed";

import { venueName } from "./launchpad-policy";
import { protectedTokens, sellableTokens, updateRetention } from "./retention-policy";
import { refreshWalletHoldings } from "./wallet-reconciliation";
import { verifyTokenCandidate as verifyLaunchCandidate, verifyTokenEntry as verifyLaunchpadEntry } from "./token-entry";
import { mergeCandidates, stageCandidate } from "./watchlist";
import { scheduleAiSweeps } from "./ai-sweeps";
import { evaluateBudgetWatches } from "./watch-budget";
import { withRpcMission } from "./rpc-context";
import { DISCOVERY_INTERVAL_MS } from "./scan-schedule";
import { pumpPanic, pumpCreatorCheckpoint, setPumpCreatorBaseline } from "./pump-observations";
import { seedPumpCreatorMonitor } from "./crazy-safety";
import { pumpSnapshot } from "./pump-snapshot";
import { registerMoonitOrigins, moonitOrigin } from "./moonit-state";
import { checkRuntimeGoal } from "./runtime-goal";

const PAPER_EXIT_COST_USD = 0.03;
/** Window after verified curve completion during which a missing sell route is treated as migration, not a failed exit. */
const MIGRATION_ROUTE_GRACE_MS = 30 * 60000;
class AwaitingMigration extends Error {}
export function awaitingMigrationRoute(p: Position, at = Date.now()) {
  return !!p.curveMigratedAt && at - Date.parse(p.curveMigratedAt) < MIGRATION_ROUTE_GRACE_MS;
}
const PAPER_ACCOUNT_RENT_SOL = 0.00204;
export async function refreshSolPrice(s: State) {
  s.solPriceUsd = await solUsd();
  if (s.cashSol === null) s.cashSol = s.cashUsd / s.solPriceUsd;
  s.cashUsd = s.cashSol * s.solPriceUsd;
  s.liveCashUsd = s.liveCashSol * s.solPriceUsd;
  return s.solPriceUsd;
}
export async function openPosition(userId: string, s: State, c: Candidate, decimals: number, staged: boolean, save: () => Promise<void>, curve?: CurveStatus, copy?: CopySignal, strategy?: Position["crazyStrategy"]) {
  return withRpcMission("priority", () => openPositionPriority(userId, s, c, decimals, staged, save, curve, copy, strategy));
}
async function openPositionPriority(userId: string, s: State, c: Candidate, decimals: number, staged: boolean, save: () => Promise<void>, curve?: CurveStatus, copy?: CopySignal, strategy?: Position["crazyStrategy"]) {
  stageCandidate(c, s);
  if (s.watchlist?.[c.mint] && Date.now() >= Date.parse(s.watchlist[c.mint].expiresAt)) return;
  const control = await flags(userId);
  if (control.halted || control.emergency || !s.running || s.entryBlocks?.length || entryRestrictions(s).length) return;
  if (s.pending || c.status !== "eligible" || dailyLoss(s) >= dailyLossLimit(s)) return;
  decisionMetric(s, c, "primary-check-started");
  await verifyLaunchCandidate(c, true);
  const launch = await verifyLaunchpadEntry(c.mint);
  const progress = c.curveProgressPct;
  if (launch.phase !== "pool" && !s.settings.launchpadCurvesEnabled) throw new TradingError("Launchpad entries are disabled in Strategy.");
  if (launch.phase === "active" && !curveProgressAllowed(c, s.settings, progress, !!copy && latestCopy(s, c.mint)?.id === copy.id))
    throw new TradingError("Active curve progress requires 15–40%, or live early Pump burst evidence before 95%.");
  if (s.solPriceUsd) c.liquidityUsd = Number(launch.phase === "active" ? launch.curve.realQuoteReserves.toString() : launch.quote.amount) / 1e9 * s.solPriceUsd;
  if (entryFilters(c, s, launch.phase === "active", !!copy && latestCopy(s, c.mint)?.id === copy.id).length) throw new TradingError("Fresh launchpad market/reserve evidence failed entry filters. No buy authorized.");
  if (!entryBudgetAvailable(s)) return;
  if (Date.now() - Date.parse(c.updatedAt) > marketFreshnessMs(s.settings)) throw new TradingError("Assessment is stale. Entry skipped.");
  if (s.positions.some(p => p.mint === c.mint && ["open", "pending"].includes(p.status))) return;
  if (s.cooldowns[c.mint] && Date.now() - Date.parse(s.cooldowns[c.mint]) < entryCooldownMs(s.settings)) return;
  const open = currentPositions(s).filter(p => ["open", "pending"].includes(p.status));
  if (open.length >= positionLimit(s.settings)) return;
  const limits = executionSettings(s.settings, c);
  if (s.settings.riskMode !== "crazy") await crazyProof(c, s.settings);
  await verifyEntryLiquidity(c);
  const solPrice = await refreshSolPrice(s);
  if (s.settings.mode === "live") {
    requireLive(userId, s);
    const balance = await walletBalances();
    s.liveCashSol = balance.sol; s.liveCashUsd = balance.sol * solPrice;
  }
  const cost = positionBudget(s.settings, equity(s), c, strategy);
  if (cost < 0.5) throw new TradingError("Fractional position budget is below $0.50; do not round up risk.");
  if (copy) {
    if (strategy !== "whale" || latestCopy(s, c.mint)?.id !== copy.id)
      throw new TradingError("Fresh verified leader signal required.");
    if (s.settings.riskMode !== "crazy" &&
        !crazyState(s).leaders.some(l => l.wallet === copy.wallet && ["target", "username"].includes(l.origin ?? "")))
      throw new TradingError("Owner-enabled copy target required in this risk mode.");
    const exposure = currentPositions(s).filter(p => p.leaderWallet === copy.wallet && ["open", "pending"].includes(p.status))
      .reduce((n, p) => n + p.remainingCostUsd + Math.max(0, p.unrealizedPnlUsd), 0);
    if (exposure + cost > equity(s) * (s.settings.crazyWalletAllocationPct ?? 20) / 100)
      throw new TradingError("Per-leader allocation cap would be exceeded.");
  }
  if (s.settings.riskMode === "crazy") {
    if (!s.settings.crazyAcknowledged) throw new TradingError("High-risk acknowledgement required.");
    const aiWatch = s.watchlist?.[c.mint];
    const aiApproved = aiWatch?.aiDecision === "BUY" && !aiWatch.rejectedAt &&
      Date.now() < Date.parse(aiWatch.expiresAt) && Date.now() - (aiWatch.aiDecisionAt ?? 0) < 5 * 60000;
    if ((!strategy && !aiApproved) || (strategy === "whale") !== !!copy) throw new TradingError("A qualified strategy or fresh watchlist AI BUY is required.");
    const proof = await crazyProof(c, s.settings);
    if (strategy === "sniper" && Date.now() / 1000 - proof.openTime > sniperAgeSeconds(s.settings)) throw new TradingError("SNIPER entry window expired.");
    if (strategy === "whale") {
      if (!copy || latestCopy(s, c.mint)?.id !== copy.id) throw new TradingError("Fresh verified leader signal required.");
      const exposure = currentPositions(s).filter(p => p.leaderWallet === copy.wallet && ["open", "pending"].includes(p.status))
        .reduce((n, p) => n + p.remainingCostUsd + Math.max(0, p.unrealizedPnlUsd), 0);
      if (exposure + cost > equity(s) * (s.settings.crazyWalletAllocationPct ?? 20) / 100) {
        throw new TradingError("Per-leader allocation cap would be exceeded.");
      }
    }
  }
  const cash = s.settings.mode === "paper" ? s.cashSol! : s.liveCashSol;
  const amount = String(Math.floor(cost / solPrice * 1e9));
  const costSol = Number(amount) / 1e9;
  const entryOverheadSol = PAPER_EXIT_COST_USD / solPrice + PAPER_ACCOUNT_RENT_SOL;
  if (cash < costSol + s.settings.solReserve + entryOverheadSol) throw new TradingError("Insufficient spendable SOL after preserving the fee reserve and estimated account rent.");
  const q = await quote(SOL, c.mint, amount, limits.slippageBps, s.settings.mode === "live" ? walletAddress()! : undefined, limits.maxPriceImpactPct);
  await verifyQuoteLiquidity(c.mint, q);
  if (["pump", "dbc"].includes(q.router) && !s.settings.launchpadCurvesEnabled) throw new TradingError("Native curve entries are disabled in Strategy.");
  impact(q, limits.maxPriceImpactPct);
  const out = BigInt(q.outAmount) * BigInt(10000 - limits.slippageBps) / 10000n;
  if (out <= 0n) throw new TradingError("Quoted output is too small.");
  // Prove an exit route exists before entering; this does not guarantee it
  // will remain available. For live, acquire a fresh signed quote afterward.
  const reverse = await quote(c.mint, SOL, out.toString(), limits.slippageBps, undefined, limits.maxPriceImpactPct);
  impact(reverse, limits.maxPriceImpactPct);
  const roundTripSol = Number(reverse.outAmount) / 1e9;
  const roundTrip = roundTripSol * solPrice;
  const maxRoundTripLossPct = s.settings.riskMode === "crazy" ? limits.slippageBps / 100 + 3 : 5;
  if (roundTrip < cost * (1 - maxRoundTripLossPct / 100)) throw new TradingError(`Estimated round-trip trading cost exceeds ${maxRoundTripLossPct}% before network costs.`);
  // Reverse quote already uses the slippage-reduced buy quantity. Crazy Mode
  // does not charge a second hypothetical sell haircut before owning the token.
  const projectedNetSol = roundTripSol * (s.settings.riskMode === "crazy" ? 1 : 1 - limits.slippageBps / 10000) - PAPER_EXIT_COST_USD / solPrice;
  if (solReturnPct(costSol + entryOverheadSol, projectedNetSol) <= -limits.stopLossPct) {
    throw new TradingError("Estimated fees, account rent and slippage would already breach the stop loss at this small position size. Entry skipped.");
  }
  const latestControl = await flags(userId);
  if (latestControl.halted || latestControl.emergency) return;
  stageCandidate(c, s);
  if (c.status !== "eligible") return;
  if (copy) {
    const problem = copyGuard(copy, costSol / (Number(out) / 10 ** decimals));
    event(s, "copy-check", `${copy.handle}: wallet ${copy.wallet}; lag ${Date.now() - copy.at}ms; ${problem ?? "chase within 15% cap"}.`, problem ? "warning" : "info", c.mint);
    if (problem) throw new TradingError(problem);
    crazyState(s).consumed.push(copy.id);
    await save();
  }
  const p: Position = {
    id: randomUUID(), mint: c.mint, symbol: c.symbol, mode: s.settings.mode, status: "open",
    walletAddress: s.settings.mode === "live" ? walletAddress() : null,
    entryPriceUsd: cost / (Number(out) / 10 ** decimals), currentPriceUsd: c.priceUsd,
    originalCostUsd: (costSol + (s.settings.mode === "paper" ? entryOverheadSol : 0)) * solPrice,
    remainingCostUsd: (costSol + (s.settings.mode === "paper" ? entryOverheadSol : 0)) * solPrice,
    originalCostSol: costSol + (s.settings.mode === "paper" ? entryOverheadSol : 0),
    remainingCostSol: costSol + (s.settings.mode === "paper" ? entryOverheadSol : 0), realizedPnlSol: 0,
    quantity: Number(out) / 10 ** decimals, rawRemaining: out.toString(), rawInitial: out.toString(), decimals,
    realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlPct: 0, openedAt: now(), closedAt: null, stage: 0,
    exitReason: null, txSignature: null, highWaterPriceUsd: c.priceUsd, highWaterPriceSol: c.priceUsd / solPrice, entryLiquidityUsd: c.liquidityUsd,
    stagedExit: s.settings.exitStrategy === "staged" || (s.settings.exitStrategy === "adaptive" && staged),
    lastValuedAt: now(),
    riskMode: s.settings.riskMode ?? "conservative",
    authorizedBuyLamports: amount,
    fastCrazyExit: s.settings.riskMode === "crazy",
    pumpHuntEntry: pumpHunt(s.settings), maxHoldMinutes: pumpHunt(s.settings) && strategy === "sniper" ? Math.min(45, s.settings.maxHoldMinutes) : s.settings.maxHoldMinutes,
    lastSafetyAt: Date.now(),
    crazyStrategy: copy ? "whale" : s.settings.riskMode === "crazy" ? strategy : undefined,
    ...(copy ? { leaderWallet: copy.wallet, leaderHandle: copy.handle, leaderEntryPriceSol: copy.priceSol, copySignalId: copy.id } : {}),
    launchExitVersion: 1, retentionPct: s.settings.retainedTokenPct ?? 0.1, entryTokenAgeMinutes: c.ageMinutes,
    pumpCreator: pumpCreatorCheckpoint(c.mint),
    launchOrigin: moonitOrigin(c.mint) ? structuredClone(moonitOrigin(c.mint)) : undefined,
    exitPlan: snapshotExitPlan(s.settings), firstTierDone: false, secondTierDone: false,
    lastLiquidityUsd: c.liquidityUsd, riskPoolIds: c.poolAddress ? [c.poolAddress] : [],
    curveKind: launch.phase === "active" ? "math" in launch ? "Moonit bonding curve" : "Pump.fun bonding curve" : undefined,
  };
  s.positions.unshift(p);
  if (p.mode === "live") {
    // Previous quote may have expired during exit-route checks.
    try {
      // Reuse a young wallet-bound build; refresh only when the reverse-route
      // check consumed most of its lifetime. executeLive still simulates it.
      const fresh = Date.now() - q.quotedAt < 10000 ? q
        : await quote(SOL, c.mint, amount, limits.slippageBps, walletAddress()!, limits.maxPriceImpactPct);
      if (s.settings.riskMode === "crazy") {
        const proof = await crazyProof(c, s.settings);
        if (strategy === "sniper" && Date.now() / 1000 - proof.openTime > sniperAgeSeconds(s.settings)) throw new TradingError("SNIPER entry window expired.");
        if (copy) {
          const minOut = Number(BigInt(fresh.outAmount) * BigInt(10000 - limits.slippageBps) / 10000n) / 10 ** decimals;
          const problem = copyGuard(copy, costSol / minOut);
          if (problem || crazyState(s).signals.some(e => e.wallet === copy.wallet && e.mint === copy.mint && e.side === "sell" && e.at >= copy.at)) {
            throw new TradingError(problem ?? "Leader has already sold; copy cancelled.");
          }
        }
      }
      await executeLive(userId, s, p, fresh, "buy", 1, strategy ? `${strategy.toUpperCase()} qualified entry` : "AI-qualified entry", save, limits);
    }
    catch (e) { if (!s.pending) p.status = "error"; throw e; }
  } else {
    protectedTokens(p); updateRetention(p);
    s.cashSol! -= costSol + entryOverheadSol; s.cashUsd = s.cashSol! * solPrice;
    p.unrealizedPnlUsd = projectedNetSol * solPrice - p.remainingCostUsd;
    p.pnlPct = solReturnPct(p.remainingCostSol, projectedNetSol);
    p.executionVenue = `${venueName(q.router)} · paper`;
    event(s, "paper", `${c.symbol}: simulated SOL→token buy ${costSol.toFixed(9)} SOL (~$${cost.toFixed(2)}) using a real ${p.executionVenue} quote. Slippage cushion, $0.03 estimated fee and ${PAPER_ACCOUNT_RENT_SOL} SOL account-rent allowance applied. Not a mainnet trade.`, "success", c.mint);
  }
  s.cooldowns[c.mint] = now();
}
export async function sell(userId: string, s: State, p: Position, fraction: number, reason: string, save: () => Promise<void>, options: { rawAmount?: bigint; emergency?: boolean } = {}) {
  if (p.status !== "open" || s.pending) throw new TradingError("Position is not available to close while an order is pending.", 409);
  if (p.mode === "live") {
    await refreshWalletHoldings(s, p.mint);
    await save();
    if (p.status !== "open") return;
  }
  const raw = BigInt(p.rawRemaining);
  const sellable = sellableTokens(p);
  if (sellable === 0n) { updateRetention(p); await save(); return; }
  const requested = options.rawAmount ?? (fraction >= 1 ? raw : raw * BigInt(Math.floor(fraction * 10000)) / 10000n);
  if (requested <= 0n || requested > raw) throw new TradingError("Invalid or below-minimum sell amount.");
  const amount = requested < sellable ? requested : sellable;
  const baseLimits = executionSettings(p.fastCrazyExit ? { ...s.settings, riskMode: "crazy" } : s.settings);
  const limits = options.emergency ? { slippageBps: baseLimits.emergencySlippageBps, maxPriceImpactPct: baseLimits.emergencyMaxPriceImpactPct } : baseLimits;
  let solPrice = s.solPriceUsd;
  try { solPrice = await refreshSolPrice(s); }
  catch { event(s, "risk", "USD price reference unavailable during exit. Native SOL settlement continues; USD reporting uses the last reference and is approximate.", "warning", p.mint); }
  if (!solPrice) throw new TradingError("No SOL/USD reference has ever been established. Manual position review required.");
  const q = await quote(p.mint, SOL, amount.toString(), limits.slippageBps, p.mode === "live" ? walletAddress()! : undefined, limits.maxPriceImpactPct);
  impact(q, limits.maxPriceImpactPct);
  if (p.mode === "live") {
    await executeLive(userId, s, p, q, "sell", Number(amount) / Number(raw), reason, save, limits);
  } else {
    const actualFraction = Number(amount) / Number(raw);
    const proceedsSol = Math.max(0, Number(q.outAmount) / 1e9 * (1 - limits.slippageBps / 10000) - PAPER_EXIT_COST_USD / solPrice);
    const proceeds = proceedsSol * solPrice;
    const basis = p.remainingCostUsd * actualFraction;
    p.realizedPnlUsd += proceeds - basis;
    const basisSol = p.remainingCostSol * actualFraction;
    p.realizedPnlSol += proceedsSol - basisSol; p.remainingCostSol -= basisSol;
    p.remainingCostUsd -= basis;
    p.rawRemaining = (raw - amount).toString();
    p.quantity = Number(BigInt(p.rawRemaining)) / 10 ** p.decimals;
    p.unrealizedPnlUsd *= (1 - actualFraction);
    p.stage++; p.exitReason = reason; s.cashSol! += proceedsSol; s.cashUsd = s.cashSol! * solPrice;
    markExitFill(p);
    updateRetention(p);
    if (BigInt(p.rawRemaining) <= 0n) {
      p.status = "closed"; p.closedAt = now(); p.remainingCostUsd = 0; p.remainingCostSol = 0; p.unrealizedPnlUsd = 0;
      p.pnlPct = p.originalCostSol > 0 ? p.realizedPnlSol / p.originalCostSol * 100 : 0;
      s.cooldowns[p.mint] = now();
    }
    event(s, "paper", `${p.symbol}: simulated ${(actualFraction * 100).toFixed(0)}% token→SOL exit — ${reason}. Proceeds ${proceedsSol.toFixed(9)} SOL (~$${proceeds.toFixed(4)}) after estimated fee.`, "success", p.mint);
  }
}
export async function monitor(userId: string, s: State, save: () => Promise<void>, emergency: boolean) {
  return withRpcMission("priority", () => monitorPriority(userId, s, save, emergency));
}
async function monitorPriority(userId: string, s: State, save: () => Promise<void>, emergency: boolean) {
  const positions = s.positions.filter(p => ["open", "retained"].includes(p.status));
  registerMoonitOrigins([...(s.launchDiscovery?.records ?? []), ...positions.flatMap(p => p.launchOrigin ? [p.launchOrigin] : [])]);
  for (const p of positions.filter(p => p.status === "open" && ["Pump.fun bonding curve", "Moonit bonding curve"].includes(p.curveKind ?? ""))) {
    if (p.pumpCreator) {
      if (!pumpCreatorCheckpoint(p.mint)) setPumpCreatorBaseline(p.mint, p.pumpCreator.address, BigInt(p.pumpCreator.balanceRaw), p.pumpCreator.slot);
    }
    else {
      try { p.pumpCreator = await seedPumpCreatorMonitor(p.mint); } catch { /* Retry baseline recovery; never stop exits/scanning. */ }
    }
    p.pumpCreator = pumpCreatorCheckpoint(p.mint) ?? p.pumpCreator;
  }
  const markets = new Map<string, Candidate>();
  if (!emergency && positions.length) {
    await Promise.all(positions.filter(p => p.curveKind === "Pump.fun bonding curve").map(p => pumpSnapshot(p.mint).catch(() => undefined)));
    try { for (const c of await getMarkets(positions.map(p => p.mint))) markets.set(c.mint, c); }
    catch { /* Each position retains the existing defensive-exit path below. */ }
  }
  for (const p of positions) {
    if (p.status === "retained") {
      const market = markets.get(p.mint);
      if (market && market.priceUsd > 0) {
        p.currentPriceUsd = market.priceUsd;
        p.unrealizedPnlUsd = p.quantity * market.priceUsd - p.remainingCostUsd;
        p.lastValuedAt = now();
      }
      continue; // Retained tokens are valuation-only, never an exit target.
    }
    const limits = p.fastCrazyExit ? executionSettings({ ...s.settings, riskMode: "crazy" }) : s.settings;
    let urgent = emergency;
    try {
      if (p.leaderWallet && (p.copyExitUncertain || crazyState(s).signals.some(signal =>
        signal.wallet === p.leaderWallet && signal.mint === p.mint && signal.side === "sell" &&
        signal.at >= Date.parse(p.openedAt) - 1000))) {
        await sell(userId, s, p, 1, p.copyExitUncertain ? "Leader monitoring gap — defensive full copy exit" :
          `Mirror leader ${p.leaderHandle ?? p.leaderWallet} sell — full remaining copy exit`, save, { emergency: true });
        recordCopyLosses(s);
        await save();
        if (s.pending) break;
        continue;
      }
      // Existing position snapshots are immutable; new defaults never rewrite exposure.
      let exitReason: string | null = emergency ? "Emergency stop / confirmed chain-risk alert" : p.exitRetryReason ?? pumpPanic(p.mint);
      if (exitReason) urgent = true;
      if (p.exitRetryReason) urgent = true;
      let tier: 0 | 1 | 2 | undefined;
      if (!exitReason) {
        let market: Candidate | undefined;
        market = markets.get(p.mint);
        if (!market) { exitReason ??= "Market disappeared — defensive exit attempt"; urgent = true; }
        else {
          let migrating = false;
          if (p.curveKind) {
            // Curve liquidity comes from verified on-chain state while bonding;
            // completion resets the baseline instead of reading as a liquidity crash.
            try {
              const safety = await checkSafety(market, s.settings);
              if (preMigration(safety.curve)) {
                if (safety.curve!.liquiditySol != null && s.solPriceUsd) market.liquidityUsd = safety.curve!.liquiditySol * s.solPriceUsd;
              } else if (!p.curveMigratedAt) {
                migrating = true; p.curveMigratedAt = now();
                event(s, "risk", `${p.symbol}: ${p.curveKind} completed/migrating. Liquidity baseline resets on the post-migration pool; profit, stop-loss and red-flag exits continue once a route is available.`, "warning", p.mint);
              }
            } catch { exitReason = "Token safety check failed or unavailable"; urgent = true; }
          }
          p.currentPriceUsd = market.priceUsd;
          p.highWaterPriceUsd = Math.max(p.highWaterPriceUsd, market.priceUsd);
          const liquidityFloor = p.fastCrazyExit ? (s.settings.crazyMinLiquidityUsd ?? 1000)
            : p.curveKind ? s.settings.curveMinLiquidityUsd : s.settings.minLiquidityUsd;
          if (migrating || awaitingMigrationRoute(p)) {
            // Provider pool data is unreliable mid-migration; track a fresh baseline. Price, sell-pressure and stop-loss checks still apply.
            p.entryLiquidityUsd = market.liquidityUsd;
          } else if (liquidityDrop(p.lastLiquidityUsd ?? p.entryLiquidityUsd, market.liquidityUsd, p.fastCrazyExit ? 25 : 30) ||
              p.pumpHuntEntry && liquidityDrop(p.entryLiquidityUsd, market.liquidityUsd, 30)) {
            exitReason ??= `Liquidity fell at least ${p.fastCrazyExit ? 25 : 30}% since the previous observation (not a single-block claim)`; urgent = true;
          } else if (market.liquidityUsd < Math.max(liquidityFloor, p.entryLiquidityUsd * 0.7)) {
            exitReason ??= "Liquidity floor / entry-relative drawdown red flag"; urgent = true;
          }
          p.lastLiquidityUsd = market.liquidityUsd;
          if (market.flaggedSuspicious || (p.crazyStrategy !== "dip" && market.change5mPct < -12) || (market.sells5m > market.buys5m * 3 && market.sells5m > 20)) {
            exitReason ??= "Provider risk flag / excessive sell pressure"; urgent = true;
          }
          try {
            if (!exitReason && !p.curveKind && (!p.fastCrazyExit || Date.now() - (p.lastSafetyAt ?? 0) >= 60000)) {
              await checkSafety(market, s.settings); p.lastSafetyAt = Date.now();
            }
          }
          catch { exitReason ??= "Token safety check failed or unavailable"; urgent = true; }
          // A red flag goes straight to the sell path. A failed valuation must
          // never prevent the independently routed emergency exit attempt.
          if (!exitReason) {
          let q: any;
          try { q = await quote(p.mint, SOL, p.rawRemaining, limits.slippageBps, undefined, limits.maxPriceImpactPct); }
          catch (e) { if (awaitingMigrationRoute(p)) throw new AwaitingMigration(); throw e; }
          const netSol = Number(q.outAmount) / 1e9 * (1 - limits.slippageBps / 10000) - PAPER_EXIT_COST_USD / s.solPriceUsd!;
          const priceSol = Number(q.outAmount) / 1e9 / p.quantity;
          p.lastExitPriceSol = priceSol;
          p.highWaterPriceSol = Math.max(p.highWaterPriceSol, priceSol);
          const net = netSol * s.solPriceUsd!;
          p.unrealizedPnlUsd = net - p.remainingCostUsd;
          p.pnlPct = solReturnPct(p.remainingCostSol, netSol);
          p.lastValuedAt = now();
          const activeStop = volatilityStop(p, priceSol, limits.stopLossPct);
          if (p.pnlPct <= -activeStop) { exitReason = `Stop loss (${activeStop.toFixed(1)}%; bounded volatility rule)`; urgent = true; }
          if (!p.fastCrazyExit && (p.crazyStrategy === "momentum" || p.crazyStrategy === "dip")) {
            if (p.pnlPct > 0) p.crazyTrailActive = true;
            if (!exitReason && p.crazyTrailActive && priceSol <= p.highWaterPriceSol * (1 - (p.exitPlan?.trailingStopPct ?? 8) / 100)) {
              exitReason = p.crazyStrategy === "dip" ? "Dip bounce trailing exit" : "Momentum trailing exit";
            }
          }
          if (!exitReason && (p.pumpHuntEntry || !(p.exitPlan && p.secondTierDone)) &&
              Date.now() - Date.parse(p.openedAt) > (p.maxHoldMinutes ?? s.settings.maxHoldMinutes) * 60000) exitReason = "Maximum holding time";
          if (!exitReason && p.exitPlan) {
            const decision = p.fastCrazyExit && !p.launchExitVersion && !p.pumpHuntEntry
              ? !p.firstTierDone && p.pnlPct >= p.exitPlan.firstTargetPct ? { tier: 1 as const }
                : p.firstTierDone && priceSol <= p.highWaterPriceSol * 0.85 ? { full: "Crazy remainder 15% trailing stop" } : null
              : moonbagDecision(p, p.pnlPct, priceSol);
            tier = decision?.tier;
            exitReason = decision?.full ?? null;
          }
          const exits = p.legacyExitSettings ?? s.settings;
          if (!p.exitPlan && !exitReason && p.stage > 0 && priceSol <= p.highWaterPriceSol * (1 - exits.trailingStopPct / 100)) exitReason = "Trailing stop";
          if (!p.exitPlan && !exitReason && p.stage > 0 && p.pnlPct >= exits.secondTakeProfitPct) exitReason = "Second profit target";
          if (!p.exitPlan && !exitReason && p.stage === 0 && p.pnlPct >= exits.takeProfitPct) {
            const sustained = market.buys5m > market.sells5m && market.change5mPct >= 0 && market.liquidityUsd >= p.entryLiquidityUsd * 0.9;
            await sell(userId, s, p, p.stagedExit && sustained ? exits.firstSellPct / 100 : 1,
              p.stagedExit && sustained ? "First profit target — keep remainder under trailing stop" : "Full profit target", save);
          }
          }
        }
      }
      if (dailyLoss(s) >= dailyLossLimit(s)) {
        exitReason = "Daily loss circuit breaker"; urgent = true;
      }
      // A stream alert may have arrived while quotes/safety checks were pending.
      if ((await flags(userId)).emergency) { exitReason = "Emergency stop / confirmed chain-risk alert"; urgent = true; }
      if (exitReason && p.status === "open") await sell(userId, s, p, 1, exitReason, save, { emergency: urgent });
      else if (tier !== undefined && p.status === "open") {
        const amount = tierAmount(p, tier);
        if (amount > 0n) await sell(userId, s, p, Number(amount) / Number(BigInt(p.rawRemaining)),
          tier === 0 ? `Early tier — sell ${p.exitPlan!.earlySellPct}% original at +${p.exitPlan!.earlyTargetPct}% SOL gain`
          : tier === 1 ? `Tier 1 — sell ${p.exitPlan!.firstSellPct}% original at +${p.exitPlan!.firstTargetPct}% SOL gain` : `Tier 2 — cumulative original-token target at +${p.exitPlan!.secondTargetPct}% SOL gain; keep moon bag`,
          save, { rawAmount: amount });
        else markExitFill(p);
      }
    } catch (e) {
      if (e instanceof AwaitingMigration) {
        // Route gap right after curve completion: keep entries and the worker running; retry next cycle.
        if (!p.migrationNoticeAt || Date.now() - Date.parse(p.migrationNoticeAt) > 600000) {
          p.migrationNoticeAt = now();
          event(s, "risk", `${p.symbol}: waiting for a post-migration sell route. Exit checks retry every cycle; the position remains exposed.`, "warning", p.mint);
        }
        await save(); continue;
      }
      p.exitRetryReason = p.exitRetryReason ?? (e instanceof TradingError
        ? `Retry protective exit: ${e.message}` : "Retry protective exit after a monitoring/provider failure");
      s.lastError = `${p.symbol}: monitoring or exit failed. Position may still be exposed. ${p.exitRetryReason}. Bot and scanner remain on; new buys wait for recovery.`;
      if (workerWarning(s, s.lastError)) event(s, "worker-warning", s.lastError, "error", p.mint);
    }
    recordCopyLosses(s);
    await save();
    if (s.pending) break;
  }
}
/** Called after an AI result is persisted and on recovery ticks. No new order
 * may replace a pending signature or outlive its original watch window. */
export async function processAiBuys(userId: string, s: State, save: () => Promise<void>) {
  return withRpcMission("priority", () => processAiBuysPriority(userId, s, save));
}
async function processAiBuysPriority(userId: string, s: State, save: () => Promise<void>) {
  if (!s.running || s.pending || s.entryBlocks?.length || entryRestrictions(s).length ||
      dailyLoss(s) >= dailyLossLimit(s)) return;
  const deadline = Date.now() + 10000;
  for (const [mint, row] of Object.entries(s.watchlist ?? {})) {
    if (Date.now() >= deadline || s.pending || !s.running) break;
    if (row.aiDecision !== "BUY" || row.rejectedAt || Date.now() >= Date.parse(row.expiresAt) ||
        Date.now() - (row.aiDecisionAt ?? 0) >= 5 * 60000 || Date.now() < (row.nextAttemptAt ?? 0) ||
        s.positions.some(p => p.mint === mint && ["open", "pending", "retained"].includes(p.status))) continue;
    if (currentPositions(s).filter(p => ["open", "pending"].includes(p.status)).length >= positionLimit(s.settings)) break;
    row.nextAttemptAt = Date.now() + 15000;
    const c = s.candidates.find(c => c.mint === mint);
    if (!c) continue;
    try {
      const fresh = (await getMarkets([mint]))[0];
      if (!fresh) throw new TradingError("Fresh market evidence unavailable.");
      Object.assign(c, fresh); stageCandidate(c, s);
      if (c.permanentlyRejectedAt) continue;
      const a = await assess(c, s, save, row.decisionSource === "deterministic" ? "fast" : "ai");
      if (a.candidate.status === "eligible") {
        event(s, "ai-entry", `${c.symbol}: watchlist BUY passed fresh guards; attempting one serialized entry.`, "info", mint);
        await openPosition(userId, s, c, a.decimals, a.staged, save, a.curve, a.copy, a.strategy);
      }
      stageCandidate(c, s);
    } catch (e) {
      c.status = "watching";
      c.reasoning = e instanceof TradingError ? e.message : "AI BUY deferred: provider unavailable; fresh guards remain mandatory.";
      stageCandidate(c, s);
      event(s, "ai-entry", `${c.symbol}: ${c.reasoning}`, "warning", mint);
    }
    await save();
  }
}
const watchWorkDue = (s: State) => Date.now() - (s.lastWatchScanAt ?? 0) >= DISCOVERY_INTERVAL_MS &&
  s.candidates.some(c => c.watchExpiresAt && !c.permanentlyRejectedAt && Date.now() < Date.parse(c.watchExpiresAt));
const scanWorkDue = (s: State) => !s.lastScanAt || Date.now() - Date.parse(s.lastScanAt) >= scanMinutes(s.settings) * 60000 || watchWorkDue(s);
export async function scan(userId: string, s: State, save: () => Promise<void>, allowEntry: boolean, marketOnly = false) {
  return withRpcMission("background", () => scanBackground(userId, s, save, allowEntry, marketOnly));
}
async function scanBackground(userId: string, s: State, save: () => Promise<void>, allowEntry: boolean, marketOnly = false) {
  rollDay(s);
  const crazy = s.settings.riskMode === "crazy";
  const copyMints = crazy ? [...new Set(crazyState(s).signals.filter(e => latestCopy(s, e.mint)?.id === e.id).map(e => e.mint))] : [];
  const marketDue = !s.lastScanAt || Date.now() - Date.parse(s.lastScanAt) >= scanMinutes(s.settings) * 60000;
  if (!copyMints.length && !marketDue && !watchWorkDue(s)) throw new TradingError(`Next market scan is due after ${scanMinutes(s.settings)} minute(s).`, 429);
  scanningUsers.add(userId);
  try {
    // Whale signals supplement discovery instead of disabling the other three
    // strategies. Extra copy checks never postpone the regular market scan.
    const [marketList, copies] = await Promise.all([
      marketDue ? discover(s, save) : Promise.resolve([] as Candidate[]),
      copyMints.length ? (async () => {
        const approvedMints: string[] = [];
        for (const mint of copyMints.slice(0, 3)) {
          try { await verifyLaunchpadEntry(mint); approvedMints.push(mint); } catch { /* Do not scan unapproved copy tokens. */ }
        }
        return getMarkets(approvedMints);
      })().then(async rows => {
        const approved: Candidate[] = [];
        for (const c of rows) { try { approved.push(await verifyLaunchCandidate(c)); } catch { /* Copy cannot bypass launchpad-only scope. */ } }
        return approved;
      }).catch(e => {
        event(s, "copy-check", `Leader market lookup unavailable: ${e instanceof Error ? e.message : "provider error"}. Regular discovery remains active.`, "warning");
        return [] as Candidate[];
      }) : Promise.resolve([] as Candidate[]),
    ]);
    // Refresh every active watch independently of discovery nominations.
    const watched = s.candidates.filter(c => c.watchExpiresAt && !c.permanentlyRejectedAt &&
      Date.now() < Date.parse(c.watchExpiresAt)).map(c => c.mint);
    const watchCursor = watched.length ? (s.watchRefreshCursor ?? 0) % watched.length : 0;
    const orderedWatches = [...watched.slice(watchCursor), ...watched.slice(0, watchCursor)];
    const watchRows: Candidate[] = [], watchDeadline = Date.now() + 5000;
    let refreshedWatches = 0;
    for (let i = 0; i < orderedWatches.length && Date.now() < watchDeadline; i += 30) {
      const page = orderedWatches.slice(i, i + 30);
      watchRows.push(...await getMarkets(page).catch(() => [] as Candidate[])); refreshedWatches += page.length;
    }
    s.watchRefreshCursor = watched.length ? (watchCursor + refreshedWatches) % watched.length : 0;
    if (watched.length) s.lastWatchScanAt = Date.now();
    const list = [...new Map([...copies, ...marketList, ...watchRows].map(c => [c.mint, c])).values()];
    if (s.settings.riskMode === "crazy") observeCrazy(s, list);
    mergeCandidates(s, list); s.scanned += list.length;
    if (marketDue) s.lastScanAt = now();
    s.sourceStatus = marketHealth;
    const freshMints = new Set(list.map(c => c.mint));
    for (const c of s.candidates) {
      const reasons = entryFilters(c, s);
      if (reasons.length) { c.status = c.marketDataStatus === "awaiting_market_data" ? "watching" : "rejected"; c.reasoning = reasons.join(". "); c.risks = [...new Set([...c.risks, ...reasons])]; }
      stageCandidate(c, s);
      if (freshMints.has(c.mint)) decisionMetric(s, c, reasons.length ? "market-filtered" : "market-passed");
    }
    event(s, "scanner", `Checked ${list.length} Solana tokens; ${s.candidates.length} retained in the discovery universe. ${list.filter(c => !entryFilters(c, s).length).length} passed market filters. ${s.candidates.filter(c => c.status === "watching").length} watching for 15 minutes. Discovery/watchlist AI sweeps run every 10/5 minutes within the shared daily budget; AI never overrides entry safety. RPC pacing and serialized orders remain. Source coverage is not exhaustive.`);
    const fallbackMints = evaluateBudgetWatches(s);
    await save();
    if (marketOnly) {
      event(s, "entry-summary", `Market scan completed. Bot remains running; new buys are temporarily blocked: ${(s.entryBlocks ?? []).join(" ")}`);
      return;
    }
    if (allowEntry) {
      if (!entryBudgetAvailable(s)) {
        event(s, "risk", `Daily entry-attempt cap (${s.settings.maxEntriesPerDay}/UTC day) reached. Market-only scan; no paid AI or new buy. Exits remain monitored.`);
        return;
      }
      const balanceSol = s.settings.mode === "paper" ? (s.cashSol ?? 0) : s.liveCashSol;
      if (currentPositions(s).filter(p => ["open", "pending"].includes(p.status)).length >= positionLimit(s.settings) ||
          !s.solPriceUsd || balanceSol < s.settings.solReserve + positionBudget(s.settings, equity(s)) / s.solPriceUsd + PAPER_ACCOUNT_RENT_SOL) {
        event(s, "cost-control", "Market-only scan: no free position slot or insufficient spendable SOL. No paid AI request.", "info");
        return;
      }
    }
    if (fallbackMints.size && allowEntry) await processAiBuys(userId, s, save);
    // Parallel reads only. All orders still use one ledger and one pending
    // signature; a bad mint/failed route never prevents another candidate.
    const queue = assessmentQueue(s);
    const ordered = crazy ? [
      ...queue.filter(c => copyMints.includes(c.mint)),
      ...queue.filter(c => !copyMints.includes(c.mint)),
    ] : queue;
    if (pumpHunt(s.settings)) ordered.sort((a, b) =>
      Number(isPump(b) && b.launchpadVerification?.phase === "active") -
      Number(isPump(a) && a.launchpadVerification?.phase === "active") || a.ageMinutes - b.ageMinutes);
    const candidates = ordered.filter(c => !fallbackMints.has(c.mint) && !c.permanentlyRejectedAt && !entryFilters(c, s).length);
    const callsBefore = s.aiCalls;
    const startedAt = Date.now();
    let eligible = 0, attempts = 0, opened = 0;
    for (let offset = 0; offset < candidates.length; offset += crazy ? 2 : 1) {
      if (crazy && Date.now() - startedAt > 10000) break;
      const batch = candidates.slice(offset, offset + (crazy ? 2 : 1));
      const screened = await Promise.allSettled(batch.map(async chosen => {
        recordCandidateCheck(s, chosen.mint);
        if (Date.now() - Date.parse(chosen.updatedAt) > 15000) {
          const refreshed = (await getMarkets([chosen.mint]))[0];
          if (!refreshed) throw new TradingError("Fresh market data unavailable.");
          Object.assign(chosen, refreshed);
        }
        return withRpcMission("priority", () => assess(chosen, s, save, "fast"));
      }));
      for (let i = 0; i < screened.length; i++) {
        const result = screened[i], chosen = batch[i];
        if (result.status === "rejected") {
          chosen.status = "watching"; chosen.reasoning = "Screening provider unavailable; retrying in a later scan.";
          event(s, "entry-blocked", `${chosen.symbol}: ${chosen.reasoning}`, "warning", chosen.mint);
          stageCandidate(chosen, s);
          continue;
        }
        const a = result.value;
        stageCandidate(chosen, s);
        if (a.candidate.status !== "eligible") continue;
        eligible++;
        if (!allowEntry) continue;
        if (s.pending || !s.running || dailyLoss(s) >= dailyLossLimit(s) ||
            currentPositions(s).filter(p => ["open", "pending"].includes(p.status)).length >= positionLimit(s.settings)) break;
        const before = s.positions.filter(p => ["open", "pending"].includes(p.status)).length;
        attempts++;
        try {
          await openPosition(userId, s, chosen, a.decimals, a.staged, save, a.curve, a.copy, a.strategy);
          opened += Math.max(0, s.positions.filter(p => ["open", "pending"].includes(p.status)).length - before);
        } catch (e) {
          chosen.status = "watching";
          chosen.reasoning = e instanceof TradingError ? e.message : "Entry provider failed before completion; review pending status.";
          event(s, "entry-blocked", `${chosen.symbol}: ${chosen.reasoning}`, "warning", chosen.mint);
          stageCandidate(chosen, s);
        }
      }
      if (s.pending ||
          (allowEntry && currentPositions(s).filter(p => ["open", "pending"].includes(p.status)).length >= positionLimit(s.settings))) break;
    }
    event(s, "entry-summary", `Screened ${candidates.filter(c => Date.parse(s.candidateCheckedAt?.[c.mint] ?? "") >= startedAt).length}; signal+safety eligible ${eligible}; entry attempts ${attempts}; opened/pending ${opened}. ${crazy ? "No daily trade-count cap. Daily loss stop remains active." : "Conservative entry limits remain active."}`);
  } finally { scanningUsers.delete(userId); }
}
export async function tick(userId: string) {
  await withState(userId, async (s, save) => {
    s.heartbeatAt = now(); rollDay(s);
    for (const c of s.candidates) stageCandidate(c, s);
    for (const message of drainRiskAlerts(userId)) event(s, "chain-risk", message, "error");
    const stageErrors: string[] = [];
    const attempt = async (message: string, work: () => Promise<unknown>, blocksEntry = true) => {
      try { await work(); return true; }
      catch {
        if (blocksEntry) { stageErrors.push(message); s.lastError = message; }
        if (workerWarning(s, message)) event(s, "worker-warning", message, "warning");
        return false;
      }
    };
    await attempt("SOL/USD reference unavailable. Scanner remains on; new buys wait for fresh pricing.", () => refreshSolPrice(s));
    const f = await flags(userId);
    // halted is written only by explicit owner actions. Do not reinterpret a
    // provider failure, loss threshold or protective alert as an owner stop.
    if (f.halted) s.running = false;
    if (ownerId() !== userId || !passwordConfigured()) stageErrors.push("Owner authorization/configuration unavailable; trading blocked, scanner retries.");
    // A slow/failed reconciliation or rescue must not repeatedly postpone the
    // visible scanner. Persist a read-only scan before retrying known failures.
    if (s.running && (s.pending || s.positions.some(p => p.status === "open" && p.exitRetryReason)) &&
        Date.now() >= (s.nextWorkerScanAt ?? 0) &&
        scanWorkDue(s)) {
      s.entryBlocks = entryRestrictions(s, stageErrors);
      s.nextWorkerScanAt = Date.now() + scanMinutes(s.settings) * 60000;
      await attempt("Discovery unavailable during recovery; scanner will retry without stopping.", () => scan(userId, s, save, false, true));
    }
    if (s.pending) await attempt("Transaction reconciliation unavailable. Scanning continues; no replacement order will be sent.", async () => {
      await reconcile(s); await save();
    });
    if (!s.pending && s.positions.some(p => p.mode === "live" && ["open", "retained"].includes(p.status)) &&
        Date.now() - (s.lastTokenBalanceAt ?? 0) >= 15000) {
      await attempt("Token wallet balances unavailable. Scanning continues; new buys wait and exits require a verified balance.", async () => {
        await refreshWalletHoldings(s); await save();
      });
    }
    if (!s.pending) await attempt("Position monitoring unavailable. Scanner continues; protective exits retry.", () => monitor(userId, s, save, f.emergency));
    // Independent of the configured market/AI scan interval; read-only and
    // strictly budgeted. Exits always get priority over discovery work.
    if (!stageErrors.length && !s.positions.some(p => p.status === "open" && Date.now() - Date.parse(p.lastValuedAt) > 60000)) checkRuntimeGoal(s);
    // Launch recovery runs once with the scheduled discovery scan, never on
    // every priority/exits tick. Log subscriptions continue between scans.
    if (s.settings.mode === "live" && walletAddress() === s.walletBinding && s.walletBinding) {
      await attempt("Wallet balance RPC unavailable. Scanner remains on; new buys wait for a verified balance.", async () => {
        if (s.settings.riskMode !== "crazy" || Date.now() - (s.lastWalletBalanceAt ?? 0) >= 10000) {
          s.liveCashSol = (await walletBalances()).sol;
          s.liveCashUsd = s.liveCashSol * s.solPriceUsd!;
          s.lastWalletBalanceAt = Date.now();
        }
      });
    }
    else if (s.settings.mode === "live") {
      stageErrors.push("Configured wallet is unverified or changed. Scanning continues; restore the original key for exposed positions. Trading remains blocked.");
    }
    if (f.emergency) stageErrors.push("Protective liquidation in progress; scanner continues, new buys wait.");
    s.entryBlocks = entryRestrictions(s, stageErrors);
    if (!s.entryBlocks.length) s.lastError = null;
    await processCopyBuys(userId, s, save);
    await processPumpSnipes(userId, s, save);
    const hasCopy = s.settings.riskMode === "crazy" &&
      crazyState(s).signals.some(signal => latestCopy(s, signal.mint)?.id === signal.id);
    if (s.running && Date.now() >= (s.nextWorkerScanAt ?? 0) &&
        (hasCopy || scanWorkDue(s))) {
      // Bounded recovery attempts prevent a 429 outage from causing a tight
      // request loop. This delays a retry, never changes the owner's run state.
      s.nextWorkerScanAt = Date.now() + scanMinutes(s.settings) * 60000;
      try {
        const canEnter = !s.entryBlocks.length;
        await scan(userId, s, save, canEnter, !canEnter);
      }
      catch (e) {
        event(s, "scanner", e instanceof TradingError ? e.message : "Background scanner unavailable; secondary endpoints will retry. Primary wallet and swaps remain isolated.", "warning");
      }
    }
    await processAiBuys(userId, s, save);
    await scheduleAiSweeps(userId, s, save);
    if (s.equity.length === 0 || Date.now() - Date.parse(s.equity[s.equity.length - 1].time) >= 60000) {
      s.equity.push({ time: now(), valueUsd: equity(s) }); s.equity = s.equity.slice(-1440);
    }
    if (f.emergency && !f.halted && !s.pending && !s.positions.some(p => ["open", "pending"].includes(p.status))) {
      await protectiveExit(userId, false);
    }
    await attempt("On-chain alert stream unavailable. Scanner and polling retries continue.", () => syncRiskStreams(userId, s, async () => {
      await protectiveExit(userId, true);
      // The persisted flag survives restarts. A busy ledger is retried by the
      // worker; never bypass its one-in-flight-order lock.
      void tick(userId).catch(() => undefined);
    }), false);
    s.entryBlocks = entryRestrictions(s, stageErrors);
  });
}
const livePumpMints = new Map<string, number>();
async function processPumpSnipes(userId: string, s: State, save: () => Promise<void>) {
  if (!s.running || s.settings.riskMode !== "crazy" || s.pending || s.entryBlocks?.length || entryRestrictions(s).length) return;
  for (const [mint, lastAttempt] of livePumpMints) {
    const huntSignal = pumpHunt(s.settings) && livePumpHint(mint) &&
      (livePumpActivity(mint).buys >= 1 || pumpActivity(mint).buys >= 1);
    if (!freshPumpSignal(mint) && !huntSignal) {
      if (!livePumpHint(mint)) livePumpMints.delete(mint);
      continue;
    }
    if (Date.now() - lastAttempt < (pumpHunt(s.settings) ? 30000 : 3000)) continue;
    livePumpMints.delete(mint); livePumpMints.set(mint, Date.now());
    if (s.watchlist?.[mint]?.rejectedAt || s.positions.some(p => p.mint === mint && ["open", "pending", "retained"].includes(p.status))) {
      livePumpMints.delete(mint); continue;
    }
    try {
      const hint = livePumpHint(mint);
      const record = recentPumpCreations().find(r => r.mint === mint) ?? (hint ? livePumpRecord(hint) : undefined);
      // One specific native candidate, not Jupiter crawling or historical indexing.
      const candidate = await withRpcMission("priority", () => pumpMarket(mint, s.solPriceUsd, record));
      const previous = s.candidates.find(c => c.mint === mint);
      if (previous?.permanentlyRejectedAt) { livePumpMints.delete(mint); continue; }
      const chosen = previous ? Object.assign(previous, candidate) : candidate;
      if (!previous) s.candidates.push(chosen);
      const assessment = await withRpcMission("priority", () => assess(chosen, s, save, "fast"));
      if (chosen.status === "eligible") await openPosition(userId, s, chosen, assessment.decimals, assessment.staged, save, assessment.curve, assessment.copy, "sniper");
    } catch {
      event(s, "sniper", "Live Pump burst observed; required current safety/reserve/route checks did not authorize a fill. Retrying while signal remains fresh.", "warning", mint);
    }
    break;
  }
}
const signalAttempts = new Map<string, number>();
async function processCopyBuys(userId: string, s: State, save: () => Promise<void>) {
  if (!s.running || s.pending || s.entryBlocks?.length || entryRestrictions(s).length) return;
  const signals = [...crazyState(s).signals].reverse().sort((a, b) =>
    (signalAttempts.get(a.id) ?? 0) - (signalAttempts.get(b.id) ?? 0));
  for (const signal of signals) {
    if (latestCopy(s, signal.mint)?.id !== signal.id || Date.now() - (signalAttempts.get(signal.id) ?? 0) < 3000) continue;
    if (s.positions.some(p => p.mint === signal.mint && ["open", "pending", "retained"].includes(p.status))) {
      crazyState(s).consumed.push(signal.id); continue;
    }
    signalAttempts.set(signal.id, Date.now());
    while (signalAttempts.size > 500) signalAttempts.delete(signalAttempts.keys().next().value!);
    try {
      // Discovery clock is irrelevant to a confirmed, fresh leader swap.
      // Only the targeted market read uses secondary; all safety/orders use primary.
      const hint = livePumpHint(signal.mint);
      const row = hint ? await withRpcMission("priority", () => pumpMarket(signal.mint, s.solPriceUsd, livePumpRecord(hint)))
        : (await getMarkets([signal.mint]))[0];
      if (!row) throw new TradingError("Target market evidence unavailable; no copy authorized.");
      if (s.watchlist?.[row.mint]?.rejectedAt || s.candidates.some(c => c.mint === row.mint && c.permanentlyRejectedAt)) {
        crazyState(s).consumed.push(signal.id); continue;
      }
      const previous = s.candidates.find(c => c.mint === row.mint);
      const candidate = previous ? Object.assign(previous, row) : row;
      if (!previous) s.candidates.push(candidate);
      const assessment = await withRpcMission("priority", () => assess(candidate, s, save, "copy"));
      if (candidate.status === "eligible")
        await openPosition(userId, s, candidate, assessment.decimals, assessment.staged, save, assessment.curve, assessment.copy, "whale");
    } catch {
      event(s, "copy-check", `${signal.handle}: copy waiting for fresh evidence, spending room, or a permitted route. No unchecked/replacement order.`, "warning", signal.mint);
    }
    break; // Expiring signals are retried separately; never start a full crawl here.
  }
}

let feedBusy = false;
let pendingFeed: State | undefined;
/** Background reads never hold the trading ledger or block primary wallet/exits. */
async function refreshCopyFeed(userId: string) {
  if (feedBusy) return;
  feedBusy = true;
  try {
    const snapshot = pendingFeed ?? await readState(userId);
    const configuration = JSON.stringify([snapshot.settings.riskMode, snapshot.settings.copyTradingEnabled, snapshot.settings.trackFomoHandles, snapshot.settings.copyTargets]);
    if (!pendingFeed && !await withRpcMission("background", () => pollFomo(snapshot))) return;
    pendingFeed = snapshot; // Retain decoded signals if a live order holds the ledger.
    await withState(userId, async s => {
      if (JSON.stringify([s.settings.riskMode, s.settings.copyTradingEnabled, s.settings.trackFomoHandles, s.settings.copyTargets]) !== configuration) return;
      const incoming = crazyState(snapshot), current = crazyState(s);
      current.leaders = incoming.leaders.map(l => {
        const old = current.leaders.find(o => o.wallet === l.wallet);
        return { ...l, losingCopies: Math.max(l.losingCopies, old?.losingCopies ?? 0), demoted: l.demoted || !!old?.demoted };
      });
      current.cursors = incoming.cursors;
      current.sourceAt = incoming.sourceAt; current.status = incoming.status;
      current.lastRefreshAt = incoming.lastRefreshAt; current.lastPollAt = incoming.lastPollAt;
      current.signals = [...new Map([...current.signals, ...incoming.signals].map(signal => [signal.id, signal])).values()].slice(-200);
      const knownEvents = new Set(s.activity.map(activity => activity.id));
      s.activity = [...snapshot.activity.filter(activity => !knownEvents.has(activity.id)), ...s.activity].slice(0, 500);
      for (const position of snapshot.positions.filter(p => p.copyExitUncertain)) {
        const actual = s.positions.find(p => p.id === position.id);
        if (actual) actual.copyExitUncertain = true;
      }
    });
    pendingFeed = undefined;
    void tick(userId).catch(() => undefined);
  } catch { /* An unavailable background provider/occupied ledger never creates a wallet error. */ }
  finally { feedBusy = false; }
}
let workerBusy = false;
let fastDiscoveryActive = false, liveMintActive = false, discoveryBusy = false;
let nextCycleAt = 0;
export function startWorker() {
  if (process.env.SENTINEL_READ_ONLY === "true") {
    logger.info("Read-only verification mode: background trading/AI worker is disabled.");
    return;
  }
  onCopyActivity(() => { void refreshCopyFeed(ownerId()); });
  let pumpWake: ReturnType<typeof setTimeout> | undefined;
  onPumpActivity(mint => {
    if (!fastDiscoveryActive || !freshPumpSignal(mint) && !livePumpHint(mint)) return;
    if (!livePumpMints.has(mint)) livePumpMints.set(mint, 0);
    if (!pumpWake) pumpWake = setTimeout(() => {
      pumpWake = undefined;
      void tick(ownerId()).catch(() => undefined);
    }, 100);
  });
  startLivePumpFeed(mint => {
    if (!fastDiscoveryActive || !freshPumpSignal(mint) && !livePumpHint(mint)) return;
    if (!livePumpMints.has(mint)) livePumpMints.set(mint, 0);
    if (!pumpWake) pumpWake = setTimeout(() => {
      pumpWake = undefined;
      void tick(ownerId()).catch(() => undefined);
    }, 100);
  }, () => liveMintActive);
  let mintChecksBusy = false;
  setInterval(async () => {
    if (!liveMintActive || mintChecksBusy) return;
    mintChecksBusy = true;
    try { await checkLivePumpMints(); }
    catch { logger.warn({ status: livePumpStatus() }, "Live Pump mint checks unavailable on secondary RPC."); }
    finally { mintChecksBusy = false; }
  }, 500).unref();
  setInterval(() => { void refreshCopyFeed(ownerId()); }, 1000).unref();
  // Read-only prefetch is independent of the ledger/order lock. The shared
  // discovery promise/cache coalesces calls; signing never occurs here.
  setInterval(async () => {
    if (!fastDiscoveryActive || discoveryBusy) return;
    discoveryBusy = true;
    try { await discover(undefined, undefined, DISCOVERY_INTERVAL_MS); }
    catch { logger.warn("Background market discovery unavailable; entry checks remain fail-closed."); }
    finally { discoveryBusy = false; }
  }, DISCOVERY_INTERVAL_MS).unref();
  setInterval(async () => {
    if (workerBusy || Date.now() < nextCycleAt) return;
    workerBusy = true;
    try {
      const rows = await pool.query("SELECT user_id, state->'settings'->>'riskMode' AS risk_mode, state->'settings'->>'copyTradingEnabled' AS copy_enabled, state->'settings'->>'trackFomoHandles' AS handles_enabled, state->>'running' AS running FROM trading_accounts WHERE user_id=$1 AND (state->>'running'='true' OR state->'pending' != 'null'::jsonb OR EXISTS (SELECT 1 FROM jsonb_array_elements(state->'positions') p WHERE p->>'status' IN ('open','pending')))", [ownerId()]);
      liveMintActive = rows.rows.some(r => r.running === "true");
      fastDiscoveryActive = rows.rows.some(r => r.risk_mode === "crazy" && r.running === "true");
      const fast = rows.rows.some(r => r.risk_mode === "crazy" || r.copy_enabled === "true" || r.handles_enabled === "true");
      nextCycleAt = Date.now() + (fast ? 1000 : 15000);
      for (const r of rows.rows) {
        try { await tick(r.user_id); }
        catch (e) { if (!(e instanceof TradingError && e.status === 409)) logger.warn({ errorType: e instanceof Error ? e.name : "Unknown" }, "Trading worker cycle failed"); }
      }
    } catch { logger.error("Trading worker could not load durable state; no trades attempted."); }
    finally { workerBusy = false; }
  }, 1000).unref();
  logger.info("Sentinel worker initialized: primary wallet/safety/execution, isolated two-minute discovery/watch checks, five-minute watch AI, best-effort protective exits. Provider latency can delay cycles.");
}
