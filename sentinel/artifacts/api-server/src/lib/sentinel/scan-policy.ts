import type { Candidate, State } from "./types";
import { entryCooldownMs } from "./crazy-policy";

/** Least recently checked first: a high-ranked unsafe mint must not starve the queue. */
export function assessmentQueue(s: State, at = Date.now()): Candidate[] {
  return s.candidates.filter(c => c.status !== "rejected" && c.marketDataStatus !== "awaiting_market_data" &&
    !s.positions.some(p => p.mint === c.mint && ["open", "pending", "retained"].includes(p.status)) &&
    !(s.cooldowns[c.mint] && at - Date.parse(s.cooldowns[c.mint]) < entryCooldownMs(s.settings)))
    .sort((a, b) => (Date.parse(s.candidateCheckedAt?.[a.mint] ?? "") || 0) -
      (Date.parse(s.candidateCheckedAt?.[b.mint] ?? "") || 0));
}

export function recordCandidateCheck(s: State, mint: string, at = Date.now()) {
  s.candidateCheckedAt = Object.fromEntries(Object.entries({
    ...s.candidateCheckedAt, [mint]: new Date(at).toISOString(),
  }).filter(([, t]) => at - Date.parse(t) < 86400000).slice(-1000));
}

export function scanFilterSummary(candidates: Candidate[]) {
  const counts = new Map<string, number>();
  for (const c of candidates.filter(c => c.status === "rejected")) {
    for (const r of c.risks) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([r, n]) => `${r}: ${n}`).join("; ");
}
