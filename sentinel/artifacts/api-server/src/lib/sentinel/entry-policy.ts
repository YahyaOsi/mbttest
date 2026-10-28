import type { State } from "./types";

// Count attempts, including failed/pending entries and closed positions, across
// every burner in the same mode. Pause/restart and wallet changes cannot reset it.
export function entriesToday(s: State, time = Date.now()): number {
  const today = new Date(time).toISOString().slice(0, 10);
  return s.positions.filter(p =>
    p.mode === s.settings.mode && p.openedAt.slice(0, 10) === today
  ).length;
}

export function entryBudgetAvailable(s: State, time = Date.now()): boolean {
  // Owner removed trade-count limits, not loss, spending or AI limits.
  return true;
}
