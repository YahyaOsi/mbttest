import type { Candidate, State } from "./types";

export const ASSESSMENT_POLICY_VERSION = 3;
/** These unavailable verification topics are not trading checks at owner request. */
export function excludedVerificationFlag(flag: string) {
  return /social authenticity|social.{0,30}(?:verif|authentic)|(?:verif|authentic).{0,30}social|(?:lp|liquidity).{0,20}(?:burn|lock)|(?:burn|lock).{0,20}(?:lp|liquidity)/i.test(flag) &&
    !/mint authority|freeze authority|wash trad|drain|sell pressure|concentration|price impact/i.test(flag);
}
export function currentCandidateWarnings(c: Candidate, enforcePoolLp = false): Candidate {
  if (c.lpVerification || (enforcePoolLp && c.launchpadVerification?.phase !== "active")) return c;
  const risks = c.risks.filter(flag => !excludedVerificationFlag(flag));
  if (excludedVerificationFlag(c.reasoning)) {
    return { ...c, risks, status: "watching", score: null,
      reasoning: "Waiting for a fresh assessment under the current entry checks." };
  }
  return risks.length === c.risks.length ? c : { ...c, risks };
}
export function aiDue(s: State, at = Date.now()) {
  return s.aiCalls < s.settings.maxAiCallsPerDay &&
    (!s.lastAiAt || at - Date.parse(s.lastAiAt) >= s.settings.aiIntervalMinutes * 60000);
}
export function marketUnchanged(old: Candidate, fresh: Candidate) {
  const relative = (a: number, b: number, tolerance: number) => Math.abs(b - a) <= Math.max(Math.abs(a), 1e-12) * tolerance;
  return old.mint === fresh.mint && old.name === fresh.name && old.symbol === fresh.symbol &&
    relative(old.priceUsd, fresh.priceUsd, 0.05) &&
    relative(old.liquidityUsd, fresh.liquidityUsd, 0.1) &&
    relative(old.volume24hUsd, fresh.volume24hUsd, 0.2) &&
    Math.abs(old.change5mPct - fresh.change5mPct) <= 3 &&
    Math.abs(old.change24hPct - fresh.change24hPct) <= 10 &&
    relative(old.buys5m, fresh.buys5m, 0.2) && relative(old.sells5m, fresh.sells5m, 0.2);
}
export function cachedAssessment(s: State, c: Candidate, at = Date.now()) {
  const cached = s.assessments[c.mint];
  if (!cached || cached.policyVersion !== ASSESSMENT_POLICY_VERSION || at - Date.parse(cached.at) >= s.settings.aiCacheMinutes * 60000 ||
      !marketUnchanged(cached.snapshot, c)) return null;
  return cached;
}
