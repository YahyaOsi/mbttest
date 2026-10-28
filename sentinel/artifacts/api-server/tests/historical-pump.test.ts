import test from "node:test";
import assert from "node:assert/strict";
import { Connection } from "@solana/web3.js";
import { historicalPumpPage } from "../src/lib/sentinel/historical-pump";
import { initialState } from "../src/lib/sentinel/store";

test("historical API pagination retains offsets and provider failure falls back without losing unresolved RPC history", async () => {
  const originalFetch = globalThis.fetch, originalHistory = Connection.prototype.getSignaturesForAddress,
    originalTransactions = Connection.prototype.getParsedTransactions;
  const s = initialState(), mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  let down = false, unresolved = true, historyCalls = 0;
  globalThis.fetch = async () => down ? new Response("Forbidden", { status: 403 }) : Response.json([{ mint }]);
  Connection.prototype.getSignaturesForAddress = (async (_program, options) => {
    historyCalls++; assert.equal(options?.limit, 1000);
    return [{ signature: "history-page-end", err: null }];
  }) as any;
  Connection.prototype.getParsedTransactions = (async signatures => {
    assert.ok(signatures.length <= 5, "RPC transport batch limit, not a discovery-universe cap");
    return signatures.map(() => unresolved ? null : { slot: 10, meta: { err: null, logMessages: [] } });
  }) as any;
  try {
    assert.deepEqual(await historicalPumpPage(s, 1000), [mint]); assert.equal(s.pumpHistory!.offset, 1);
    down = true;
    assert.deepEqual(await historicalPumpPage(s, 32000), []);
    assert.equal(s.pumpHistory!.offset, 1); assert.equal(s.pumpHistory!.before, undefined);
    assert.deepEqual(s.pumpHistory!.pending, ["history-page-end"]);
    unresolved = false;
    await historicalPumpPage(s, 63000);
    assert.equal(s.pumpHistory!.before, "history-page-end"); assert.equal(s.pumpHistory!.pending!.length, 0);
    assert.equal(historyCalls, 1, "unresolved page is retried before requesting a subsequent page");
  } finally {
    globalThis.fetch = originalFetch; Connection.prototype.getSignaturesForAddress = originalHistory;
    Connection.prototype.getParsedTransactions = originalTransactions;
  }
});
