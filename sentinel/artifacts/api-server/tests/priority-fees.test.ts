import test from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { applyPriorityFee, MAX_PRIORITY_LAMPORTS } from "../src/lib/sentinel/priority-fees";

test("dynamic priority fee is capped, changes only unsigned compute price and never broadcasts", async () => {
  process.env.SOLANA_RPC_URL = "https://priority.test.invalid";
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(String(init!.body));
    assert.equal(req.method, "getRecentPrioritizationFees");
    calls++;
    return Response.json({ jsonrpc: "2.0", id: req.id, result: [{ slot: 1, prioritizationFee: 1000000000 }] });
  };
  try {
    const payer = Keypair.generate(), recipient = Keypair.generate().publicKey;
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 999999999n }),
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 100 })],
    }).compileToV0Message());
    const next = await applyPriorityFee(tx, { addressLookupTableAccounts: [] });
    const instructions = TransactionMessage.decompile(next.message).instructions;
    const prices = instructions.filter(i => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3);
    assert.equal(prices.length, 1);
    const price = prices[0].data.readBigUInt64LE(1);
    assert.ok(price * 1400000n <= BigInt(MAX_PRIORITY_LAMPORTS) * 1000000n);
    assert.ok(instructions.at(-1)!.data.equals(TransactionMessage.decompile(tx.message).instructions.at(-1)!.data));
    assert.equal(calls, 1);
    tx.sign([payer]);
    await assert.rejects(applyPriorityFee(tx, { addressLookupTableAccounts: [] }), /must be unsigned/);
  } finally { globalThis.fetch = originalFetch; }
});
