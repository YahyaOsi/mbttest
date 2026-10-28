import test from "node:test";
import assert from "node:assert/strict";
import { entriesToday, entryBudgetAvailable } from "../src/lib/sentinel/entry-policy";
import type { Position, State } from "../src/lib/sentinel/types";

const time = Date.parse("2026-10-26T23:59:00Z");
function state(): State {
  return {
    settings: { mode: "live", maxEntriesPerDay: 3 },
    positions: [
      { mode: "live", openedAt: "2026-10-26T01:00:00Z", status: "closed", walletAddress: "old-wallet" },
      { mode: "live", openedAt: "2026-10-26T02:00:00Z", status: "error", walletAddress: "new-wallet" },
      { mode: "paper", openedAt: "2026-10-26T03:00:00Z", status: "open" },
      { mode: "live", openedAt: "2026-10-25T23:59:59Z", status: "closed" },
    ] as Position[],
  } as State;
}
test("daily counting remains available for reporting but never caps entries", () => {
  const s = state();
  assert.equal(entriesToday(s, time), 2);
  assert.equal(entryBudgetAvailable(s, time), true);
  s.positions.push({ mode: "live", openedAt: "2026-10-26T23:58:00Z", status: "pending" } as Position);
  assert.equal(entryBudgetAvailable(s, time), true);
  assert.equal(entryBudgetAvailable(s, Date.parse("2026-10-27T00:00:00Z")), true);
});
test("deprecated entry-count settings do not stop continuous execution", () => {
  const s = state();
  for (const limit of [0, -1, NaN, 2.5]) {
    s.settings.maxEntriesPerDay = limit;
    assert.equal(entryBudgetAvailable(s, time), true);
  }
});
