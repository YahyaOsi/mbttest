import type { State } from "./types";
import { equity, event, now } from "./store";

/** The requested 5x target stops discovery/new entries, not protective position
 * management. Provider errors never change the owner's run state. */
export function checkRuntimeGoal(s: State) {
  if (!s.running || s.pending) return;
  const value = equity(s);
  if (!Number.isFinite(value) || value <= 0) return;
  s.runtimeGoal ??= { startingEquityUsd: value, targetEquityUsd: value * 5 };
  if (s.runtimeGoal.reachedAt || value < s.runtimeGoal.targetEquityUsd) return;
  s.runtimeGoal.reachedAt = now();
  s.running = false;
  event(s, "control", `5× starting-equity goal reached ($${value.toFixed(2)} / $${s.runtimeGoal.targetEquityUsd.toFixed(2)}). Scanning and new buys stopped; existing protective exits and permanent 1% retention remain active.`, "success");
}
