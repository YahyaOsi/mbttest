import type { Candidate } from "./types";
import { boundedEvidence } from "./rpc-context";

/** Reuse actual recent observations, never manufacture freshness. Execution
 * still rechecks quotes and on-chain safety on the dedicated primary. */
export async function sweepEvidence(
  batch: Candidate[], lookup: (mints: string[]) => Promise<Candidate[]>,
  clock = () => Date.now(), timeoutMs = 3000,
): Promise<Candidate[]> {
  const fresh = (c: Candidate) => {
    const age = clock() - Date.parse(c.updatedAt);
    return Number.isFinite(age) && age >= -5000 && age <= 45000 && c.priceUsd > 0;
  };
  const missing = batch.filter(c => !fresh(c)).map(c => c.mint);
  const live = missing.length ? await boundedEvidence(() => lookup(missing), timeoutMs) : [];
  return batch.map(c => {
    const current = live.find(row => row.mint === c.mint && fresh(row)) ?? (fresh(c) ? c : undefined);
    if (!current) throw new Error("Fresh AI market evidence unavailable");
    return { ...c, ...current };
  });
}
