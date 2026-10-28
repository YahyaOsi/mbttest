import { Router, type IRouter } from "express";
import { ownerId, requireOwner, sameOrigin } from "../lib/owner-auth";
import {
  GetDashboardResponse, GetCandidatesResponse, GetPositionsResponse, GetActivityResponse,
  GetSettingsResponse, UpdateSettingsBody, ControlBotBody, AnalyzeTokenParams,
  AnalyzeTokenResponse, ClosePositionParams, GetConnectionsResponse, GetSetupResponse,
  VerifyOwnerWalletBody,
  GetHighRiskStatusResponse,
} from "@workspace/api-zod";
import {
  currentPositions, dailyLoss, dailyLossLimit, equity, event, flags, initialState, latch, now,
  readState, rollDay, scanningUsers, TradingError, withState,
  cashUsd,
} from "../lib/sentinel/store";
import { discover, getMarkets, validMint } from "../lib/sentinel/market";
import { assess } from "../lib/sentinel/analysis";
import { liveBlockers, requireLive, walletAddress, walletBalances } from "../lib/sentinel/chain";
import { huntSettingsProblem } from "../lib/sentinel/pump-hunt-policy";
import { scan, sell, tick, refreshSolPrice } from "../lib/sentinel/engine";
import { mergeCandidates, stageCandidate } from "../lib/sentinel/watchlist";
import { connections, setup } from "../lib/sentinel/readiness";
import { crazyState, FOMO_SOURCE, positionBudget, scanMinutes } from "../lib/sentinel/crazy-policy";
import { validateCopyTargets } from "../lib/sentinel/copy-targets";
import { livePumpStatus } from "../lib/sentinel/pump-live-feed";
import rpcConnectionRouter from "./rpc-connection";
import { refreshWalletHoldings } from "../lib/sentinel/wallet-reconciliation";
import { reconcile } from "../lib/sentinel/execution";
import { isVerifiedLaunchCandidate, verifyLaunchpadEntry, verifyLaunchCandidate } from "../lib/sentinel/launchpad-entry";
import { pool } from "@workspace/db";
import { rpcPool } from "../lib/sentinel/rpc-pool";

const router: IRouter = Router();
// All routes below have already passed server-side password authentication.
const getAuth = (_req: unknown) => ({ userId: ownerId() });
router.use("/sentinel", requireOwner, sameOrigin);
router.use("/sentinel/rpc", rpcConnectionRouter);
router.get("/sentinel/diagnostics", async (req, res): Promise<void> => {
  const userId = getAuth(req).userId;
  const s = await readState(userId);
  const [funnel, recent] = await Promise.all([
    pool.query(`SELECT CASE WHEN kind='candidate' THEN 'candidate/'||coalesce(data->>'outcome','unknown') ELSE kind END AS kind,
      data->>'policy' AS policy,count(*)::int AS count FROM sentinel_diagnostics
      WHERE user_id=$1 AND time>=now()-interval '24 hours' GROUP BY 1,2 ORDER BY count(*) DESC`, [userId]),
    pool.query(`SELECT time,kind,mint,data FROM sentinel_diagnostics WHERE user_id=$1 ORDER BY time DESC LIMIT 50`, [userId]),
  ]);
  const open = currentPositions(s).filter(p => ["open", "pending"].includes(p.status));
  res.json({ generatedAt: now(), rpc: { ...rpcPool.availability(), endpoints: rpcPool.status() },
    risk: { equityUsd: equity(s), openCostUsd: open.reduce((n, p) => n + p.remainingCostUsd, 0),
      openRiskUsd: open.reduce((n, p) => n + p.remainingCostUsd * (p.riskMode === "crazy" ? 0.2 : s.settings.stopLossPct / 100), 0),
      dailyLossUsd: dailyLoss(s), dailyLossLimitUsd: dailyLossLimit(s), dailyLossRemainingUsd: Math.max(0, dailyLossLimit(s) - dailyLoss(s)),
      normalEquityPct: s.settings.normalEquityPct, snipeEquityPct: s.settings.snipeEquityPct },
    pipeline: s.candidates.reduce<Record<string, number>>((n, c) => { const key = c.pipelineStatus ?? "observed"; n[key] = (n[key] ?? 0) + 1; return n; }, {}),
    funnel: funnel.rows, recent: recent.rows });
});
router.get("/sentinel/candidates", async (req, res): Promise<void> => {
  const userId = getAuth(req).userId;
  if (userId) {
    const state = await readState(userId);
    if (state.candidates.length) { res.json(GetCandidatesResponse.parse(state.candidates)); return; }
  }
  try { res.json(GetCandidatesResponse.parse(await withState(userId, (s, save) => discover(s, save)))); }
  catch { res.status(502).json({ error: "Discovery providers are unavailable. No sample data substituted. Please retry." }); }
});
router.get("/sentinel/dashboard", async (req, res): Promise<void> => {
  const userId = getAuth(req).userId!;
  const s = await readState(userId);
  const p = currentPositions(s);
  const closed = p.filter(x => x.status === "closed");
  const active = p.filter(x => ["open", "pending"].includes(x.status));
  const blockers = liveBlockers(userId, s.settings, s);
  if (s.pending) blockers.push("Transaction awaiting finalized reconciliation.");
  const f = await flags(userId);
  res.json(GetDashboardResponse.parse({
    mode: s.settings.mode, running: s.running && !f.halted, scanning: scanningUsers.has(userId),
    entryBlocks: s.entryBlocks ?? [],
    lastScanAt: s.lastScanAt, nextScanAt: s.running && !f.halted ? new Date(Math.max(Date.now(), Date.parse(s.lastScanAt || now()) + scanMinutes(s.settings) * 60000)).toISOString() : null,
    workerHeartbeatAt: s.heartbeatAt, scanIntervalSeconds: scanMinutes(s.settings) * 60,
    aiIntervalMinutes: s.settings.aiIntervalMinutes, aiCacheMinutes: s.settings.aiCacheMinutes,
    lastAiAt: s.lastAiAt,
    nextAiAt: s.running && s.aiCalls < s.settings.maxAiCallsPerDay ? new Date(Math.max(Date.now(), Date.parse(s.lastAiAt || now()) + s.settings.aiIntervalMinutes * 60000)).toISOString() : null,
    cashSol: s.settings.mode === "paper" ? s.cashSol : s.liveCashSol,
    solPriceUsd: s.solPriceUsd, reserveSol: s.settings.solReserve,
    cashUsd: cashUsd(s), equityUsd: equity(s),
    realizedPnlUsd: p.reduce((v, x) => v + x.realizedPnlUsd, 0),
    unrealizedPnlUsd: active.reduce((v, x) => v + x.unrealizedPnlUsd, 0),
    winRatePct: closed.length ? closed.filter(x => x.realizedPnlSol > 0).length / closed.length * 100 : null,
    closedTrades: closed.length, openPositions: active.length, candidatesScanned: s.scanned,
    aiCallsToday: s.aiDay === now().slice(0, 10) ? s.aiCalls : 0, aiCallLimit: s.settings.maxAiCallsPerDay,
    dailyLossUsd: dailyLoss(s), dailyLossLimitUsd: dailyLossLimit(s),
    liveReady: blockers.length === 0, blockers,
    walletAddress: walletAddress(),
    equity: s.equity, recentActivity: s.activity.slice(0, 6),
    sourceStatus: s.sourceStatus + ` ${livePumpStatus()}` + (s.runtimeGoal ? ` Run goal: $${s.runtimeGoal.startingEquityUsd.toFixed(2)} → $${s.runtimeGoal.targetEquityUsd.toFixed(2)} (5×)${s.runtimeGoal.reachedAt ? "; reached, entries/scanning stopped; exits still monitored" : ""}.` : ""),
    lastError: s.lastError,
  }));
});
router.get("/sentinel/positions", async (req, res): Promise<void> => { res.json(GetPositionsResponse.parse((await readState(getAuth(req).userId!)).positions)); });
router.get("/sentinel/activity", async (req, res): Promise<void> => { res.json(GetActivityResponse.parse((await readState(getAuth(req).userId!)).activity)); });
router.get("/sentinel/settings", async (req, res): Promise<void> => { res.json(GetSettingsResponse.parse((await readState(getAuth(req).userId!)).settings)); });
router.get("/sentinel/high-risk", async (req, res): Promise<void> => {
  const s = await readState(getAuth(req).userId!), state = crazyState(s);
  res.json(GetHighRiskStatusResponse.parse({
    source: FOMO_SOURCE, status: state.status, updatedAt: state.sourceAt,
    positionSizeUsd: positionBudget({ ...s.settings, riskMode: "crazy" }, equity(s)),
    leaders: state.leaders.filter(l => l.active || l.demoted || s.positions.some(p => p.leaderWallet === l.wallet && ["open", "pending"].includes(p.status))).map(l => ({
      wallet: l.wallet, handle: l.handle, rank: l.rank, losingCopies: l.losingCopies, demoted: l.demoted,
      allocatedUsd: currentPositions(s).filter(p => p.leaderWallet === l.wallet && ["open", "pending"].includes(p.status))
        .reduce((n, p) => n + p.remainingCostUsd + Math.max(0, p.unrealizedPnlUsd), 0),
    })),
    notices: [
      "High risk is OFF until selected, acknowledged, saved while paused, and started. No strategy guarantees profits.",
      "Top-10 concentration remains mandatory. Verified native curves need no DEX LP lock; ordinary supported Raydium SOL pools require independently proved fully burned/permanently inaccessible LP. Social authenticity and beneficial ownership are not certified.",
      "All four strategies monitor together with shared limits and one entry per mint. Signal priority: verified Whale Copy, then Sniper, Momentum, Dip Hunter. Each filled position retains its own strategy's exit handling.",
      "Sniper: pool open ≤5 minutes. Momentum: positive buy-biased activity with ≥$500 five-minute volume, or 1.3× observed volume. Dip: observed 30% drop then 5–15% recovery.",
      `${s.settings.normalEquityPct ?? 8}% equity for normal Crazy entries; up to ${s.settings.snipeEquityPct ?? 15}% only for high-confidence snipes. Daily trade-count cap is disabled; equity-aware daily loss stop, position limit and protected SOL reserve remain active.`,
      "Crazy Mode: $1,000 default real-reserve liquidity floor; no default 24h volume floor. Background discovery every two minutes. Live confirmed Pump burst and copy signals can wake the execution worker between sweeps; no guaranteed millisecond execution.",
      "Fomo Api is independent, not an official Fomo integration. Rankings include unrealized gains, span chains, and can disagree with independent calculations. Linked wallets are provider-reported; actual swaps are verified on-chain.",
      "Manual Copy Trade enables explicit wallet targets independently of Track FOMO & User Handles. The separate tracking toggle controls X/FOMO targets and public Crazy Mode rankings; off means no leaderboard requests. X needs an explicit linked wallet; posts are not tracked. FOMO names need fresh verified links. Secondary wallet WebSockets verify fresh swaps without HTTP history polling. Existing copied-position exits remain monitored even when new tracking is disabled.",
      "New fills: 50% at +100% net SOL gain (2x before fees), then a 15% trailing stop on the sellable remainder. The permanent 1% remains protected. Older positions keep their existing exit snapshot. Stops are not guaranteed prices.",
      "Continuous scanning retries errors without changing owner run intent. Daily loss protection blocks new trades, not scanning. The existing 5x portfolio target stops new entries/scanning when reached but leaves protective exits active. No daily trade-count stop; scheduled AI shares the configured daily paid-request budget.",
    ],
  }));
});
router.get("/sentinel/connections", async (req, res): Promise<void> => {
  const id = getAuth(req).userId!;
  await readState(id);
  res.json(GetConnectionsResponse.parse(connections(id)));
});
router.get("/sentinel/setup", async (req, res): Promise<void> => {
  const id = getAuth(req).userId!;
  res.json(GetSetupResponse.parse(setup(id, await readState(id))));
});
router.put("/sentinel/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid settings. Check values and limits.", details: parsed.error.flatten() }); return; }
  const settings = { ...parsed.data, crazyStrategy: "all" as const };
  const huntProblem = huntSettingsProblem(settings);
  if (huntProblem) { res.status(400).json({ error: huntProblem }); return; }
  const targetProblem = validateCopyTargets(settings);
  if (targetProblem) { res.status(400).json({ error: targetProblem }); return; }
  if (settings.riskMode === "crazy" && !settings.crazyAcknowledged) { res.status(400).json({ error: "Acknowledge high-risk mode before saving it." }); return; }
  if (settings.secondTakeProfitPct <= settings.takeProfitPct) { res.status(400).json({ error: "The second profit target must exceed the first." }); return; }
  if (settings.exitStrategy === "moonbag" && settings.firstSellPct + settings.secondSellPct >= 100) { res.status(400).json({ error: "Tier 1 and Tier 2 must total less than 100% of the original position, leaving a moon bag." }); return; }
  if (settings.adaptiveExitsEnabled && (settings.firstSellPct + settings.secondSellPct + (settings.earlySellPct ?? 20) >= 100 ||
      (settings.earlyTakeProfitPct ?? 60) >= settings.takeProfitPct)) {
    res.status(400).json({ error: "Early profit target must be below the first target; all sell tiers must total less than 100%." }); return;
  }
  if (settings.riskMode !== "crazy" && settings.positionSizeUsd > settings.paperBalanceUsd && settings.mode === "paper") { res.status(400).json({ error: "Position size exceeds the starting paper balance." }); return; }
  const userId = getAuth(req).userId!;
  const result = await withState(userId, async s => {
    if (s.pending) throw new TradingError("Settings are locked during transaction reconciliation.", 409);
    if (s.running) throw new TradingError("Pause new entries before editing settings.", 409);
    if (settings.mode !== s.settings.mode && s.positions.some(p => ["open", "pending"].includes(p.status))) throw new TradingError("Close existing positions before changing modes.", 409);
    if ((settings.riskMode ?? "conservative") !== (s.settings.riskMode ?? "conservative") && s.positions.some(p => ["open", "pending"].includes(p.status))) throw new TradingError("Close existing positions before switching risk modes.", 409);
    if (settings.mode === "live") requireLive(userId, { ...s, settings });
    for (const p of s.positions) if (["open", "pending", "retained"].includes(p.status) && p.maxHoldMinutes == null)
      p.maxHoldMinutes = s.settings.maxHoldMinutes;
    const switched = settings.mode !== s.settings.mode;
    const materiallyChanged = settings.minAiScore !== s.settings.minAiScore ||
      settings.exitStrategy !== s.settings.exitStrategy || settings.riskMode !== s.settings.riskMode ||
      settings.crazyStrategy !== s.settings.crazyStrategy;
    s.settings = settings;
    if (materiallyChanged) s.assessments = {};
    if (switched) {
      await refreshSolPrice(s);
      if (settings.mode === "live") { s.liveCashSol = (await walletBalances()).sol; s.liveCashUsd = s.liveCashSol * s.solPriceUsd!; }
      s.dailyStartEquity = equity(s); s.equity = [{ time: now(), valueUsd: equity(s) }];
    }
    event(s, "settings", `Risk settings saved. ${settings.mode.toUpperCase()} execution; ${settings.riskMode === "crazy" ? "CRAZY / all four strategies" : "Conservative"} strategy. Existing paper balance only changes via Reset Paper.`);
    return s.settings;
  });
  res.json(GetSettingsResponse.parse(result));
});
router.post("/sentinel/control", async (req, res): Promise<void> => {
  const p = ControlBotBody.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Invalid command." }); return; }
  const id = getAuth(req).userId!;
  const action = p.data.action;
  if (action === "pause" || action === "emergency") {
    // Persist the stop even if a scan currently holds the state lock.
    await latch(id, true, action === "emergency" ? true : undefined);
    try {
      await withState(id, async s => { s.running = false; event(s, "control", action === "emergency" ? "Emergency latched. Attempting exits on the worker cycle; execution is not guaranteed." : "New entries paused. Existing positions remain monitored.", "warning"); });
    } catch (e) { if (!(e instanceof TradingError && e.status === 409)) throw e; }
    if (action === "emergency") void tick(id).catch(() => undefined);
    res.json({ success: true, message: action === "emergency" ? "Emergency stop saved. Exits will be attempted; check positions for failures." : "Entries paused. Exit monitoring continues." }); return;
  }
  const message = await withState(id, async s => {
    rollDay(s);
    if (action === "reset-paper") {
      if (s.settings.mode !== "paper" || s.running || s.pending || s.positions.some(p => ["open", "pending"].includes(p.status))) throw new TradingError("Pause and close all positions before resetting paper trading.", 409);
      s.cashUsd = s.settings.paperBalanceUsd; s.cashSol = s.solPriceUsd ? s.cashUsd / s.solPriceUsd : null; s.dailyStartEquity = s.cashUsd;
      s.positions = s.positions.filter(p => p.mode !== "paper");
      s.equity = [{ time: now(), valueUsd: s.cashUsd }]; s.cooldowns = {}; delete s.crazyGoal;
      event(s, "paper", `Paper account reset to $${s.cashUsd.toFixed(2)}. Paper position history cleared; audit log retained.`, "warning");
      return "Paper balance reset. No real funds changed.";
    }
    if (!s.settings.acknowledgeRisk) throw new TradingError("Review Strategy and acknowledge risks and operating costs before starting.");
    if (s.settings.riskMode === "crazy" && !s.settings.crazyAcknowledged) throw new TradingError("High-risk mode requires a separate acknowledgement.");
    s.entryBlocks = [];
    try { await refreshSolPrice(s); }
    catch { s.entryBlocks.push("SOL/USD reference unavailable; scanning continues and pricing retries."); }
    if (s.settings.mode === "live") {
      try {
        requireLive(id, s);
        const b = await walletBalances();
        s.liveCashSol = b.sol; s.liveCashUsd = b.sol * (s.solPriceUsd ?? 0);
        if (!s.positions.some(p => p.mode === "live")) s.dailyStartEquity = equity(s);
      } catch { s.entryBlocks.push("Live setup or wallet balance unavailable; scanning continues, new buys wait for recovery."); }
    }
    if (s.pending) s.entryBlocks.push("Transaction awaiting reconciliation; scanning continues without duplicate orders.");
    if (dailyLoss(s) >= dailyLossLimit(s)) s.entryBlocks.push("Equity-aware daily loss limit reached; scanning continues, new buys wait.");
    await latch(id, false, false);
    s.running = true; s.runtimeGoal = undefined; s.lastError = s.entryBlocks[0] ?? null; s.nextWorkerScanAt = 0;
    event(s, "control", `Automatic SOL-funded ${s.settings.mode} trading started. ${s.settings.riskMode === "crazy"
      ? `CRAZY / all four strategies: ${s.settings.normalEquityPct ?? 8}% normal equity sizing, up to ${s.settings.snipeEquityPct ?? 15}% qualified snipes; no daily trade-count cap. ${s.settings.pumpHuntEnabled ? "Pump hunt enabled." : ""} Daily loss stop retained. AI advisory only.`
      : `Conservative strategy; paid AI no more often than every ${s.settings.aiIntervalMinutes}m, hard cap ${s.settings.maxAiCallsPerDay} requests/UTC day.`} Market scans every ${scanMinutes(s.settings) * 60}s; fresh Whale Tail signals may trigger an earlier check. Exit worker cycle ${s.settings.riskMode === "crazy" ? "1" : "15"}s, best effort; providers and order reconciliation can delay checks.`, "success");
    return `Automatic ${s.settings.mode} mode started. Service must remain online.`;
  });
  res.json({ success: true, message });
});
router.post("/sentinel/scan", async (req, res): Promise<void> => {
  const id = getAuth(req).userId!;
  await withState(id, (s, save) => scan(id, s, save, false));
  res.json({ success: true, message: "Scan completed. Manual scans assess candidates but never initiate buys." });
});
router.post("/sentinel/candidates/:mint/analyze", async (req, res): Promise<void> => {
  const parsed = AnalyzeTokenParams.safeParse(req.params);
  if (!parsed.success || !validMint(parsed.data.mint)) { res.status(400).json({ error: "Invalid Solana mint." }); return; }
  const mint = parsed.data.mint;
  const result = await withState(getAuth(req).userId!, async (s, save) => {
    const c = (await getMarkets([mint]))[0];
    if (!c) throw new TradingError("Token market not found.", 404);
    mergeCandidates(s, [c]);
    const index = s.candidates.findIndex(c => c.mint === mint);
    if (index < 0) s.candidates.unshift(c); else s.candidates[index] = c;
    stageCandidate(c, s, Date.now(), true);
    await save();
    return c;
  });
  res.json(AnalyzeTokenResponse.parse(result));
});
router.post("/sentinel/reconcile", async (_req, res): Promise<void> => {
  const result = await withState(ownerId(), async (s, save) => {
    const signature = s.pending?.signature ?? null;
    await reconcile(s);
    // Persist the proven chain outcome before an optional balance refresh can fail.
    await save();
    if (!s.pending) {
      await refreshWalletHoldings(s);
      if (s.running) s.nextWorkerScanAt = 0;
    }
    await save();
    return { success: !s.pending, pending: !!s.pending, running: s.running, signature,
      lastValidBlockHeight: s.pending?.lastValidBlockHeight ?? s.pending?.expiryFence?.lastValidBlockHeight ?? null,
      message: s.pending
        ? "Primary RPC check completed; finalized status or expiry proof is still pending. No lock was forced clear."
        : s.running ? "Transaction state and wallet balances reconciled. Scanning is scheduled immediately; normal guarded automation continues."
          : "Transaction state and wallet balances reconciled. The bot remains owner-paused; no restart or trade was triggered." };
  });
  res.json(result);
});
router.post("/sentinel/wallet/refresh", async (_req, res): Promise<void> => {
  const result = await withState(ownerId(), async (s, save) => {
    if (s.pending) await reconcile(s);
    if (s.pending) { await save(); return null; }
    const changed = await refreshWalletHoldings(s);
    if (s.running) s.nextWorkerScanAt = 0;
    await save();
    return changed;
  });
  if (result === null) {
    res.status(409).json({ error: "Transaction reconciliation is still awaiting finalized status or verified expiry. No pending lock was forced clear and no replacement trade was sent." });
    return;
  }
  res.json({ success: true, message: `Wallet balances refreshed. ${result} position(s) reconciled. External transfers are not sales. No transaction was submitted; the 1% reserve remains protected.` });
});
router.post("/sentinel/positions/:id/close", async (req, res): Promise<void> => {
  const parsed = ClosePositionParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid position." }); return; }
  const id = getAuth(req).userId!;
  await withState(id, async (s, save) => {
    const p = s.positions.find(p => p.id === parsed.data.id);
    if (!p) throw new TradingError("Position not found.", 404);
    await sell(id, s, p, 1, "Manual exit — keep permanent 1%", save);
  });
  res.json({ success: true, message: "Sellable balance processed or awaiting finality; permanent 1% excluded. Transferred-out tokens are reconciled without a sale. Refresh positions to verify." });
});
router.post("/sentinel/wallet/verify", async (req, res): Promise<void> => {
  const parsed = VerifyOwnerWalletBody.safeParse(req.body);
  const configured = walletAddress();
  if (!parsed.success || !configured || parsed.data.address !== configured) {
    res.status(400).json({ error: "Confirmation must exactly match the configured burner address. Verify it independently in your wallet." }); return;
  }
  await withState(ownerId(), async s => {
    if (s.running || !(await flags(ownerId())).halted) throw new TradingError("Pause entries before verifying or switching wallets.", 409);
    if (s.pending || s.positions.some(p => p.mode === "live" && ["open", "pending"].includes(p.status))) {
      throw new TradingError("Close all live positions and reconcile pending transactions using the ORIGINAL key before changing wallets. No funds or history were moved.", 409);
    }
    const balance = await walletBalances();
    const old = s.walletBinding;
    s.walletBinding = configured; s.liveCashSol = balance.sol;
    if (s.solPriceUsd) s.liveCashUsd = balance.sol * s.solPriceUsd;
    if (s.settings.mode === "live" && old !== configured) {
      s.dailyStartEquity = equity(s);
      s.equity = [{ time: now(), valueUsd: equity(s) }];
    }
    s.assessments = {};
    event(s, "wallet", `${old && old !== configured ? "Switched from " + old + " to" : "Verified"} burner ${configured}. No funds transferred. Previous trade history retained under its original wallet.`, "warning");
  });
  res.json({ success: true, message: "Burner address verified. Only this wallet can back new live trades. Trading remains paused." });
});
router.use((err: unknown, req: any, res: any, next: any) => {
  if (err instanceof TradingError) { res.status(err.status).json({ error: err.message }); return; }
  next(err);
});
export default router;
