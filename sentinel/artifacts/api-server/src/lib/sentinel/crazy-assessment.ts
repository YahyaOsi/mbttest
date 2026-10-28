import { crazyProof } from "./crazy-proof";
import { copyGuard, crazyMarketFilters, crazyState, dipSignal, momentumSignal } from "./crazy-policy";
import { event, now } from "./store";
import type { Candidate, CopySignal, Position, State } from "./types";
import { targetLeaders } from "./copy-targets";
import { confidence } from "./confidence";
import { decisionMetric } from "./telemetry";
import { curveProgressAllowed } from "./pump-sniping";
import { marketFreshnessMs, pumpHunt, sniperAgeSeconds } from "./pump-hunt-policy";
import { preMigration } from "./curve-policy";

export function latestCopy(s: State, mint: string, at = Date.now()): CopySignal | undefined {
  const state = crazyState(s);
  return [...state.signals].reverse().find(signal => signal.mint === mint && signal.side === "buy" &&
    !state.consumed.includes(signal.id) && state.leaders.some(l => l.wallet === signal.wallet && l.active && !l.demoted) &&
    state.leaders.some(l => l.wallet === signal.wallet &&
      (l.origin !== "target" && l.origin !== "username"
        ? !!s.settings.trackFomoHandles && s.settings.riskMode === "crazy"
        : targetLeaders(s.settings, state.leaders, state.leaders).some(t => t.wallet === l.wallet))) &&
    (state.leaders.some(l => l.wallet === signal.wallet && l.origin === "target") ||
      Number.isFinite(Date.parse(state.sourceAt ?? "")) && at - Date.parse(state.sourceAt!) >= 0 && at - Date.parse(state.sourceAt!) < 30 * 60000) &&
    !copyGuard(signal, signal.priceSol, at) &&
    !state.signals.some(later => later.wallet === signal.wallet && later.mint === mint && later.side === "sell" && later.at >= signal.at));
}
export async function assessCrazy(c: Candidate, s: State, readProof: typeof crazyProof = crazyProof) {
  if (pumpHunt(s.settings)) {
    const preflight = confidence(c, s.settings);
    c.confidenceScore = preflight.score; c.confidenceReasons = preflight.reasons;
  }
  decisionMetric(s, c, "screening-started", "Screening requested; on-chain proof is not yet granted.");
  const result = () => ({ candidate: c, decimals: 0, staged: true, copy: undefined as CopySignal | undefined, strategy: undefined as Position["crazyStrategy"] });
  const reject = (message: string) => {
    c.status = "rejected"; c.reasoning = message; c.risks = [message];
    event(s, "crazy-gate", `${c.symbol}: ${message}`, "warning", c.mint);
    decisionMetric(s, c, "safety-rejected", message);
    return result();
  };
  const state = crazyState(s);
  let copy = latestCopy(s, c.mint);
  const history = state.observations[c.mint] ?? [];
  const momentum = momentumSignal(c, history), dip = dipSignal(c, history);
  const sniperCandidate = c.ageMinutes >= 0 && c.ageMinutes <= sniperAgeSeconds(s.settings) / 60;
  let copyProblem: string | null = null;
  if (copy) {
    const age = Date.now() - Date.parse(state.sourceAt ?? "");
    const directTarget = state.leaders.some(l => l.wallet === copy!.wallet && l.origin === "target");
    copyProblem = !directTarget && (!Number.isFinite(age) || age < 0 || age > 30 * 60000)
      ? "Fomo ranking is stale; new copies blocked."
      : copyGuard(copy, c.priceUsd / (s.solPriceUsd || 0));
    if (copyProblem) {
      event(s, "copy-check", `${copyProblem}; wallet ${copy.wallet}; lag ${Date.now() - copy.at}ms. Other independent strategies still require their own signals.`, "warning", c.mint);
      copy = undefined;
    }
  }
  const huntNominee = pumpHunt(s.settings) && c.buys5m >= 1 && c.buys5m >= c.sells5m &&
    (c.confidenceScore ?? 0) >= (s.settings.confidenceThreshold ?? 40);
  if (!copy && !sniperCandidate && !momentum && !dip && !huntNominee) {
    c.status = "watching"; c.reasoning = "Waiting for a fresh pool, positive buy-biased momentum with real five-minute USD volume, a dip recovery, or a verified leader buy.";
    c.risks = []; event(s, "crazy-signal", `${c.symbol}: ${c.reasoning}`, "info", c.mint);
    return result();
  }
  const filters = crazyMarketFilters(c, s.settings, !!copy);
  if (filters.length) return reject(filters.join(". "));
  try {
    const gates = await readProof(c, s.settings);
    const ranked = confidence(c, s.settings);
    c.confidenceScore = ranked.score; c.confidenceReasons = ranked.reasons;
    if (pumpHunt(s.settings) && (!Number.isFinite(ranked.score) || ranked.score < (s.settings.confidenceThreshold ?? 40) ||
        Date.now() - Date.parse(c.updatedAt) > marketFreshnessMs(s.settings)))
      return reject(`Pump hunt confidence ${ranked.score} below ${s.settings.confidenceThreshold ?? 40}, or market older than 60s: ${ranked.reasons.join(", ")}`);
    if (gates.curve && preMigration(gates.curve) &&
        !curveProgressAllowed(c, s.settings, gates.curve.progressPct, !!copy))
      return reject(`Curve progress ${gates.curve.progressPct ?? "unknown"} outside allowed window; confidence ${ranked.score}: ${ranked.reasons.join(", ")}`);
    c.safetyChecked = true;
    // One attributed entry per mint, not four duplicate orders. Prefer the
    // expiring leader signal, then a fresh pool, then momentum or a dip.
    const strategy: Position["crazyStrategy"] = copy ? "whale"
      : sniperCandidate && Date.now() / 1000 - gates.openTime <= sniperAgeSeconds(s.settings) ? "sniper"
      : momentum || huntNominee ? "momentum" : dip ? "dip" : undefined;
    if (!strategy) return reject(copyProblem ?? "SNIPER pool is older than five minutes; no other strategy has a qualifying signal.");
    c.status = "eligible"; c.risks = [];
    c.reasoning = `${strategy.toUpperCase()} deterministic signal. Mint/freeze/extensions checked. Observed top-10 non-curve wallet share ${gates.top10Pct.toFixed(2)}% from ${gates.holderAccountsObserved} largest token accounts (${gates.holderCoveragePct.toFixed(2)}% supply observed), not a complete wallet ranking. Not an AI score or safety guarantee.`;
    c.ageMinutes = Math.max(0, (Date.now() / 1000 - gates.openTime) / 60);
    c.updatedAt = now();
    event(s, "crazy-signal", `${c.symbol}: ${c.reasoning}`, "success", c.mint);
    decisionMetric(s, c, "eligible", `${strategy}; confidence ${ranked.score}: ${ranked.reasons.join(", ")}`);
    return { candidate: c, decimals: gates.decimals, staged: true, copy, strategy, curve: gates.curve ?? undefined };
  } catch (e) {
    return reject(e instanceof Error ? e.message : "High-risk on-chain gates unavailable; no order.");
  }
}
