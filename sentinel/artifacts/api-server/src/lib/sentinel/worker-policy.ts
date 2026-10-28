import { dailyLoss, dailyLossLimit } from "./store";
import type { State } from "./types";

export function entryRestrictions(s: State, stageErrors: string[] = []) {
  const reasons = [...stageErrors];
  if (s.pending) reasons.push("Transaction awaiting reconciliation; no duplicate orders.");
  if (dailyLoss(s) >= dailyLossLimit(s)) reasons.push("Daily loss limit reached (equity-aware); scanning continues and entries resume when the limit clears.");
  for (const p of s.positions) {
    if (["open", "pending"].includes(p.status) && p.exitRetryReason)
      reasons.push(`${p.symbol}: protective exit is retrying; position may still be exposed.`);
  }
  return [...new Set(reasons)];
}
/** Deduplicate identical transient warnings on the fast worker cadence. */
export function workerWarning(s: State, message: string) {
  const last = s.activity.find(a => a.category === "worker-warning" && a.message === message);
  return !last || Date.now() - Date.parse(last.time) >= 60000;
}
