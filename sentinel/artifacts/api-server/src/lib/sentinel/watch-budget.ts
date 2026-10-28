import { entryFilters } from "./analysis";
import { applyWatchDecision, stageCandidate } from "./watchlist";
import { event } from "./store";
import type { State } from "./types";
import { pumpHunt } from "./pump-hunt-policy";
import { confidence } from "./confidence";

/** One cheap pass over active watches. BUY requests the fast safety lane; it
 * never grants chain clearance or invokes a paid provider. */
export function evaluateBudgetWatches(s: State, at = Date.now()): Set<string> {
  const evaluated = new Set<string>();
  if (!s.running || s.aiCalls < s.settings.maxAiCallsPerDay) return evaluated;
  let buys = 0;
  for (const c of s.candidates) {
    const row = s.watchlist?.[c.mint];
    if (!row || row.rejectedAt || c.permanentlyRejectedAt || c.status !== "watching" ||
        s.positions.some(p => p.mint === c.mint && ["open", "pending", "retained"].includes(p.status))) continue;
    stageCandidate(c, s, at);
    if (c.permanentlyRejectedAt || at >= Date.parse(row.expiresAt)) continue;
    if (pumpHunt(s.settings) && c.missingMarketData?.includes("activity")) {
      c.reasoning = "Missing live/indexed activity evidence; keep original watch deadline while secondary evidence refreshes.";
      continue;
    }
    const reasons = entryFilters(c, s);
    if (!pumpHunt(s.settings) && (!Number.isFinite(c.change5mPct) || c.change5mPct <= 0 ||
        c.buys5m < Math.max(1, c.sells5m) * 1.3)) {
      reasons.push("Positive price momentum and at least 1.3:1 buy bias required");
    }
    if (pumpHunt(s.settings)) {
      const ranked = confidence(c, s.settings);
      // Missing holder proof may nominate primary checks, never authorize a fill.
      if (c.buys5m < c.sells5m || ranked.score + (c.observedTop10Pct == null ? 20 : 0) < (s.settings.confidenceThreshold ?? 40))
        reasons.push("Pump hunt needs buy bias and sufficient potential confidence before fresh holder proof");
    }
    const decision = reasons.length ? "REJECT" : "BUY";
    const reason = reasons.length ? reasons.join(". ") : "Current market thresholds and positive buy-biased momentum passed; fresh on-chain safety and execution guards required.";
    if (applyWatchDecision(s, c.mint, decision, reason, at, "deterministic")) {
      evaluated.add(c.mint);
      if (decision === "BUY") buys++;
    }
  }
  if (evaluated.size) event(s, "watch-fallback",
    `Paid AI budget exhausted. Deterministic watchlist pass: ${buys} BUY requests, ${evaluated.size - buys} permanent REJECT. No external AI calls; BUY still requires fresh safety, available funds and owner run intent.`);
  return evaluated;
}
