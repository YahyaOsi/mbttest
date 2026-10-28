import type { Candidate, State } from "./types";
import { reconcilePipeline } from "./pipeline-state";
import { pumpHunt } from "./pump-hunt-policy";
export const WATCH_MS = 15 * 60000;
export function applyWatchDecision(s: State, mint: string, decision: "BUY" | "REJECT", reason: string, at = Date.now(), source: "ai" | "deterministic" = "ai") {
  const c = s.candidates.find(c => c.mint === mint), row = s.watchlist?.[mint];
  if (!c || !row || row.rejectedAt || at >= Date.parse(row.expiresAt) ||
      s.positions.some(p => p.mint === mint && ["open", "pending", "retained"].includes(p.status))) return false;
  // A late, already-reserved paid response must not overwrite the budget fallback.
  if (source === "ai" && row.decisionSource === "deterministic" && s.aiCalls >= s.settings.maxAiCallsPerDay) return false;
  row.aiDecision = decision; row.aiDecisionAt = at; row.decisionSource = source;
  if (source === "ai") c.lastAiSweepAt = new Date(at).toISOString();
  c.aiSweepReason = `${source === "deterministic" ? "Deterministic budget fallback · " : ""}${decision}: ${reason.slice(0, 1000)}`;
  if (decision === "REJECT") {
    // Latest owner policy: AI is advisory in Crazy mode, not a hard veto.
    // Deterministic safety and the original immutable deadline still apply.
    if (source === "ai" && s.settings.riskMode === "crazy") return true;
    row.rejectedAt = new Date(at).toISOString(); row.reason = `${source === "ai" ? "AI" : "Deterministic budget fallback"} REJECT: ${reason.slice(0, 1000)}`;
    c.permanentlyRejectedAt = row.rejectedAt; c.status = "rejected"; c.reasoning = row.reason;
  }
  return true;
}
export function hasPotential(c: Candidate, s: State) {
  if (pumpHunt(s.settings) && c.liquidityUsd >= 400 && c.priceUsd > 0 &&
      c.missingMarketData?.includes("activity")) return true;
  const floor = s.settings.riskMode === "crazy" ? s.settings.crazyMinLiquidityUsd ?? 1000 : s.settings.minLiquidityUsd;
  if ((c.risks?.length ?? 0) > 0) {
    if (c.risks.length > 2 || c.risks.some(r => !/liquidity below|volume below|insufficient recent buy activity/i.test(r))) return false;
    return c.priceUsd > 0 && c.liquidityUsd >= floor * 0.75 &&
      (!c.risks.some(r => /volume/i.test(r)) || c.volume24hUsd >=
        (s.settings.riskMode === "crazy" ? s.settings.crazyMinVolumeUsd ?? 0 : s.settings.minVolumeUsd) * 0.5);
  }
  return !!c.watchStartedAt || ((c.score ?? 0) >= s.settings.minAiScore && c.priceUsd > 0) || c.buys5m >= 3 || c.volume24hUsd >= s.settings.minVolumeUsd * 0.5 ||
    c.liquidityUsd >= floor * 0.75 || c.marketDataStatus === "awaiting_market_data";
}
/** Server timestamps are immutable across refreshes, restarts and CA lookups. */
export function stageCandidate(c: Candidate, s: State, at = Date.now(), enroll = false) {
  s.watchlist ??= {};
  const old = s.watchlist[c.mint];
  // Discovery alone is not a minor-metric failure. Screen first, then stage;
  // explicit CA enrollment is the intentional exception.
  if (!old && !enroll && c.status === "discovered") return c;
  if (old) {
    c.watchStartedAt = old.startedAt; c.watchExpiresAt = old.expiresAt;
    if (s.positions.some(p => p.mint === c.mint && ["open", "pending", "retained"].includes(p.status))) {
      c.watchExpiresAt = null;
      if (c.status === "watching") c.status = "discovered";
      return c;
    }
    if (old.rejectedAt) {
      c.permanentlyRejectedAt = old.rejectedAt; c.status = "rejected"; c.reasoning = old.reason ?? "Permanently rejected after the 15-minute staging window.";
      return c;
    }
    if (at >= Date.parse(old.expiresAt) && !s.positions.some(p => p.mint === c.mint && ["open", "pending", "retained"].includes(p.status))) {
      old.rejectedAt = new Date(at).toISOString(); old.reason = "15-minute watch window expired without a completed entry.";
      c.permanentlyRejectedAt = old.rejectedAt; c.status = "rejected"; c.reasoning = old.reason; return c;
    }
  }
  if (c.status !== "eligible" && (old || enroll || hasPotential(c, s))) {
    const row = old ?? { startedAt: new Date(at).toISOString(), expiresAt: new Date(at + WATCH_MS).toISOString() };
    s.watchlist[c.mint] = row; c.watchStartedAt = row.startedAt; c.watchExpiresAt = row.expiresAt;
    c.status = "watching";
  }
  return c;
}
export function mergeCandidates(s: State, fresh: Candidate[], at = Date.now()) {
  const rows = new Map(s.candidates.map(c => [c.mint, c]));
  for (const c of fresh) {
    const old = rows.get(c.mint);
    rows.set(c.mint, { ...old, ...c, lastAiSweepAt: old?.lastAiSweepAt, aiSweepReason: old?.aiSweepReason });
  }
  s.candidates = [...rows.values()].map(c => stageCandidate(c, s, at));
  reconcilePipeline(s, at);
  return s.candidates;
}
