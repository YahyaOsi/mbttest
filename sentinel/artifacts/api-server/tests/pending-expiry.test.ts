import test from "node:test";
import assert from "node:assert/strict";
import { rpcPool } from "../src/lib/sentinel/rpc-pool";
import { inspectMissingPending, clearPendingTransactionLock } from "../src/lib/sentinel/pending-expiry";
import { reconcile } from "../src/lib/sentinel/execution";
import { initialState } from "../src/lib/sentinel/store";
import type { PendingOrder, Position } from "../src/lib/sentinel/types";
import { rpcTask } from "../src/lib/sentinel/rpc-context";

const order = () => ({ signature: "fixture-signature", positionId: "fixture", direction: "buy",
  venue: "pump", createdAt: "2020-01-01T00:00:00Z", wallet: "fixture-wallet" } as PendingOrder);
function fixture() {
  let height = 200, valid = false;
  let status: unknown = null, transaction: unknown = null, calls = 0;
  const rpc = {
    getLatestBlockhashAndContext: async (config: { minContextSlot: number }) => {
      calls++; assert.equal(config.minContextSlot, 90);
      return { context: { slot: 100 }, value: { blockhash: "fence", lastValidBlockHeight: 200 } };
    },
    getBlockHeight: async () => height,
    isBlockhashValid: async () => ({ context: { slot: 500 }, value: valid }),
    getSignatureStatuses: async () => ({ context: { slot: 500 }, value: [status] }),
    getTransaction: async () => transaction,
  } as unknown as Parameters<typeof inspectMissingPending>[1];
  return { rpc, height: (n: number) => { height = n; }, valid: (b: boolean) => { valid = b; },
    status: (s: unknown) => { status = s; }, transaction: (t: unknown) => { transaction = t; },
    calls: () => calls };
}
test("old age/null status never authorize release; a new fence is persisted and survives retries", async () => {
  const f = fixture(), pending = order();
  assert.deepEqual(await inspectMissingPending(pending, f.rpc, 90), { kind: "waiting" });
  assert.equal(pending.expiryMinimumSlot, 90);
  assert.equal(pending.expiryFence?.lastValidBlockHeight, 200);
  assert.deepEqual(await inspectMissingPending(pending, f.rpc, 101), { kind: "waiting" }, "equality with expiry height is not expiration");
  assert.equal(f.calls(), 1, "do not slide the fence forward every cycle");
  f.height(201);
  assert.deepEqual(await inspectMissingPending(pending, f.rpc, 500), { kind: "expired" });
});
test("a valid blockhash, late signature or finalized transaction prevents a false dropped result", async () => {
  const f = fixture(), pending = order();
  await inspectMissingPending(pending, f.rpc, 90); f.height(201);
  f.valid(true);
  assert.deepEqual(await inspectMissingPending(pending, f.rpc, 500), { kind: "waiting" });
  f.valid(false); f.status({ confirmationStatus: "confirmed" });
  assert.deepEqual(await inspectMissingPending(pending, f.rpc, 500), { kind: "waiting" });
  f.status(null); f.transaction({ slot: 400, meta: { err: null } });
  assert.equal((await inspectMissingPending(pending, f.rpc, 500)).kind, "landed", "recover a finalized transaction even if status indexing lags");
  f.transaction({ slot: 400, meta: { err: { InstructionError: [0, "error"] } } });
  assert.equal((await inspectMissingPending(pending, f.rpc, 500)).kind, "landed", "failure is an on-chain outcome, not a dropped trade");
});
test("recorded dispatch expiry is checked directly without creating a replacement fence", async () => {
  const f = fixture();
  const pending = { ...order(), recentBlockhash: "actual-signed-hash", durableNonce: false, lastValidBlockHeight: 200 };
  assert.deepEqual(await inspectMissingPending(pending, f.rpc, 90), { kind: "waiting" });
  assert.equal(f.calls(), 0);
  f.height(201);
  assert.deepEqual(await inspectMissingPending(pending, f.rpc, 90), { kind: "expired" });
  assert.equal(f.calls(), 0);
  f.height(Number.NaN);
  await assert.rejects(inspectMissingPending(pending, f.rpc, 90), /Invalid primary finalized block height/);
});
test("durable nonce and unknown legacy orders require manual evidence; RPC failure never releases an order", async () => {
  const f = fixture();
  assert.deepEqual(await inspectMissingPending({ ...order(), durableNonce: true }, f.rpc, 90), { kind: "waiting" });
  assert.deepEqual(await inspectMissingPending({ ...order(), venue: undefined }, f.rpc, 90), { kind: "waiting" });
  assert.equal(f.calls(), 0);
  const pending = order(); await inspectMissingPending(pending, f.rpc, 90); f.height(201);
  f.rpc.getSignatureStatuses = async () => { throw new Error("429"); };
  await assert.rejects(inspectMissingPending(pending, f.rpc, 500), /429/);
  assert.ok(pending.expiryFence);
});
test("clearing a resolved pending lock preserves owner pause intent, balances and unrelated loss stops", () => {
  const s = initialState(); s.pending = order(); s.running = false;
  s.lastError = "Unresolved transaction signature. New trades remain blocked.";
  s.entryBlocks = ["Transaction awaiting reconciliation; no duplicate orders.", "Daily loss limit reached."];
  const cash = s.cashSol;
  clearPendingTransactionLock(s);
  assert.equal(s.pending, null); assert.equal(s.lastError, null); assert.equal(s.running, false);
  assert.equal(s.cashSol, cash); assert.deepEqual(s.entryBlocks, ["Daily loss limit reached."]);
});
test("reconciler releases only an expired absent buy, never fabricates a fill, and uses primary mission", async () => {
  const originalRead = rpcPool.read;
  try {
    rpcPool.read = async (init, mission) => {
      assert.equal(rpcTask()?.mission, "priority");
      assert.equal(mission, "priority");
      const request = JSON.parse(String(init.body));
      const results: Record<string, unknown> = {
        getSignatureStatuses: { context: { slot: 500 }, value: [null] }, getBlockHeight: 201,
        isBlockhashValid: { context: { slot: 500 }, value: false }, getTransaction: null,
      };
      assert.ok(request.method in results, `Unexpected RPC ${request.method}`);
      return Response.json({ jsonrpc: "2.0", id: request.id, result: results[request.method] });
    };
    const s = initialState(); s.running = true;
    s.pending = { ...order(), expiryFence: { blockhash: "fence", slot: 100, lastValidBlockHeight: 200 } };
    s.positions = [{ id: "fixture", symbol: "FIX", status: "pending", mode: "live" } as Position];
    s.lastError = "Unresolved transaction signature. New trades remain blocked.";
    const before = { cash: s.cashSol, liveCash: s.liveCashSol, trades: s.dailyTrades };
    await reconcile(s);
    assert.equal(s.pending, null); assert.equal(s.positions[0].status, "error"); assert.equal(s.running, true);
    assert.equal(s.lastError, null);
    assert.deepEqual({ cash: s.cashSol, liveCash: s.liveCashSol, trades: s.dailyTrades }, before);
  } finally {
    rpcPool.read = originalRead;
  }
});
