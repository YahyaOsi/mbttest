import test from "node:test";
import assert from "node:assert/strict";
import { walletProblem } from "../src/lib/sentinel/wallet-policy";
import type { State, Position, PendingOrder } from "../src/lib/sentinel/types";

const state = (walletBinding: string | null = "old") => ({ walletBinding, positions: [], pending: null }) as Pick<State, "walletBinding" | "positions" | "pending">;
test("fresh and changed keys cannot trade without matching address confirmation", () => {
  assert.ok(walletProblem(state(null), null));
  assert.ok(walletProblem(state(null), "new"));
  assert.ok(walletProblem(state("old"), "new"));
  assert.equal(walletProblem(state("old"), "old"), null);
});
test("open positions and pending transactions remain bound to their original wallet", () => {
  const s = state();
  s.positions = [{ mode: "live", status: "open", walletAddress: "old" } as Position];
  assert.ok(walletProblem(s, "new"));
  assert.equal(walletProblem(s, "old"), null);
  s.pending = { wallet: "old" } as PendingOrder;
  assert.ok(walletProblem(s, "new"));
});
test("unknown legacy exposure cannot silently adopt a replacement signer", () => {
  const s = state("new");
  s.positions = [{ mode: "live", status: "open", walletAddress: null } as Position];
  assert.ok(walletProblem(s, "new"));
  s.positions[0].status = "closed";
  assert.equal(walletProblem(s, "new"), null);
});
