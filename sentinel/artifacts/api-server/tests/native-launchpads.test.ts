import test from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { fixture, n, token } from "./helpers/launchpad-fixtures";
import { nativeCurveQuote, buildCurveTransaction } from "../src/lib/sentinel/launchpad-routes";
import { assertAuthorizedCurveBuild, curveSwapInstruction, curveAmounts, verifyLaunchpadProgram } from "../src/lib/sentinel/launchpad-policy";
import { accountBatches } from "../src/lib/sentinel/launchpad-state";
import { PUMP_PROGRAM, DBC_PROGRAM } from "../src/lib/sentinel/curve-policy";
import { SOL, USDC } from "../src/lib/sentinel/discovery-policy";
import { vaultSnapshot } from "../src/lib/sentinel/chain-risk-policy";
import { quote } from "../src/lib/sentinel/routes";

const limits = { slippageBps: 100, maxPriceImpactPct: 5 };
// Every RPC/provider method used here is in memory. No keys are loaded, no
// signature is produced and no transaction is submitted.
for (const kind of ["pump", "dbc"] as const) {
  test(`${kind}: locally decoded mainnet layouts quote and build unsigned atomic buys AND sells`, async () => {
    const f = fixture(kind);
    for (const buy of [true, false]) {
      if (kind === "dbc" && buy) {
        await assert.rejects(() => nativeCurveQuote(SOL, f.mint.toBase58(), "1000000", limits, f.user.toBase58(), f.connection), /Only verified active Pump.fun/);
        continue;
      }
      const q = await nativeCurveQuote(buy ? SOL : f.mint.toBase58(), buy ? f.mint.toBase58() : SOL,
        "1000000", limits, f.user.toBase58(), f.connection);
      assert.equal(q.router, kind); assert.equal(q.programIdentity, "upgradeable");
      assert.ok(BigInt(q.outAmount) > 0n);
      const small = await nativeCurveQuote(buy ? SOL : f.mint.toBase58(), buy ? f.mint.toBase58() : SOL,
        "750000", limits, undefined, f.connection);
      assert.ok(BigInt(small.outAmount) < BigInt(q.outAmount), "quote varies with exact input, not provider labels");
      const tx = VersionedTransaction.deserialize(Buffer.from(q.transaction!, "base64"));
      assert.equal(tx.message.header.numRequiredSignatures, 1);
      assert.equal(tx.message.staticAccountKeys[0].toBase58(), f.user.toBase58());
      assert.equal(tx.message.addressTableLookups.length, 0);
      assert.ok(tx.signatures[0].every(v => v === 0));
      assertAuthorizedCurveBuild(q, tx);
      assert.throws(() => assertAuthorizedCurveBuild({ ...q }, tx)); // no caller-supplied authorization
      const ix = tx.message.compiledInstructions.find(i => tx.message.staticAccountKeys[i.programIdIndex].equals(kind === "pump" ? PUMP_PROGRAM : DBC_PROGRAM))!;
      const minimum = curveAmounts(BigInt(q.inAmount), BigInt(q.outAmount), 100);
      curveSwapInstruction((kind === "pump" ? PUMP_PROGRAM : DBC_PROGRAM).toBase58(), ix.data, buy, 1000000n, minimum);
      const corrupt = Buffer.from(ix.data); corrupt.writeBigUInt64LE(1n, 16);
      assert.throws(() => curveSwapInstruction((kind === "pump" ? PUMP_PROGRAM : DBC_PROGRAM).toBase58(), corrupt, buy, 1000000n, minimum));
      if (kind === "pump" && buy) { corrupt[24] = 1; assert.throws(() => curveSwapInstruction(PUMP_PROGRAM.toBase58(), corrupt, buy, 1000000n, 1n)); }
      tx.message.recentBlockhash = f.mint.toBase58();
      assert.throws(() => assertAuthorizedCurveBuild(q, tx)); // whole message/account binding
    }
  });
  test(`${kind}: stale/migrating, unsafe mint, wrong vault owner/delegate and unknown program fail closed`, async () => {
    for (const problem of ["complete", "mint", "delegate", "vault", "program", "liquidity", "impact", "quoteMint"]) {
      const f = fixture(kind);
      if (problem === "complete") {
        if (kind === "pump") f.state.complete = true; else f.state.poolState.isMigrated = 1;
        f.setState();
      }
      if (problem === "mint") f.accounts.get(f.mint.toBase58())!.data.writeUInt32LE(1, 0);
      if (problem === "delegate") f.accounts.set(f.baseVault.toBase58(), token(f.mint, kind === "pump" ? f.pool :
        PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], DBC_PROGRAM)[0], 800000000000000n, f.user));
      if (problem === "vault") f.accounts.get(f.baseVault.toBase58())!.owner = f.user;
      if (problem === "program") f.accounts.get((kind === "pump" ? PUMP_PROGRAM : DBC_PROGRAM).toBase58())!.executable = false;
      if (problem === "liquidity") {
        if (kind === "pump") f.state.realQuoteReserves = n(0);
        else f.state.poolState.quoteReserve = n(0);
        f.setState();
      }
      if (problem === "quoteMint") {
        if (kind === "pump") { f.state.quoteMint = new PublicKey(USDC); f.setState(); }
        else { f.config.quoteMint = new PublicKey(USDC); f.setConfig(); }
      }
      await assert.rejects(() => nativeCurveQuote(SOL, f.mint.toBase58(), "1000000",
        problem === "impact" ? { ...limits, maxPriceImpactPct: 0 } : limits, undefined, f.connection), undefined, problem);
    }
  });
}
test("DBC withdrawable liquidity blocks buys but does not block rescue sell quotes", async () => {
  const f = await fixture("dbc");
  f.config.partnerPermanentLockedLiquidityPercentage = 0;
  f.config.partnerLiquidityPercentage = 100;
  await f.setConfig();
  await assert.rejects(() => nativeCurveQuote(SOL, f.mint.toBase58(), "1000000", { slippageBps: 300, maxPriceImpactPct: 5 }, undefined, f.connection), /Only verified active Pump.fun/);
  const sell = await nativeCurveQuote(f.mint.toBase58(), SOL, "1000000", { slippageBps: 300, maxPriceImpactPct: 5 }, undefined, f.connection);
  assert.equal(sell.router, "dbc");
});

test("program identities resolve upgradeable ProgramData; malformed linkages and loaders are rejected", async () => {
  const f = fixture("pump");
  assert.equal(await verifyLaunchpadProgram(f.connection, PUMP_PROGRAM), "upgradeable");
  const p = f.accounts.get(PUMP_PROGRAM.toBase58())!, key = new PublicKey(p.data.subarray(4));
  f.accounts.get(key.toBase58())!.data[12] = 0;
  assert.equal(await verifyLaunchpadProgram(f.connection, PUMP_PROGRAM), "immutable");
  f.accounts.get(key.toBase58())!.data[12] = 2;
  await assert.rejects(() => verifyLaunchpadProgram(f.connection, PUMP_PROGRAM));
  p.owner = PublicKey.default;
  await assert.rejects(() => verifyLaunchpadProgram(f.connection, PUMP_PROGRAM));
});
test("atomic builders reject extra signers, oversized packets and multiple swaps; RPC reads stay at five", async () => {
  const f = fixture("pump");
  assert.equal((await accountBatches(f.connection, Array(13).fill(f.mint))).length, 13);
  const q = await nativeCurveQuote(SOL, f.mint.toBase58(), "1000000", limits, f.user.toBase58(), f.connection);
  const tx = VersionedTransaction.deserialize(Buffer.from(q.transaction!, "base64"));
  const swap = tx.message.compiledInstructions.at(-1)!;
  const ix = new TransactionInstruction({ programId: PUMP_PROGRAM, data: Buffer.from(swap.data),
    keys: [{ pubkey: f.mint, isSigner: true, isWritable: true }] });
  await assert.rejects(() => buildCurveTransaction(f.connection, f.user, [ix], PUMP_PROGRAM, true, 1000000n, 1n));
  await assert.rejects(() => buildCurveTransaction(f.connection, f.user, [ix, ix], PUMP_PROGRAM, true, 1000000n, 1n));
  ix.keys = [];
  await assert.rejects(() => buildCurveTransaction(f.connection, f.user, [ix,
    new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(1600) })],
    PUMP_PROGRAM, true, 1000000n, 1n));
  for (const args of [[0n, 1n, 100], [1n << 64n, 1n, 100], [1n, 1n, 10000]] as const) assert.throws(() => curveAmounts(...args));
});
test("both aggregator routes unavailable: native buy/sell fallbacks remain independent and never broadcast", async () => {
  const fetch = globalThis.fetch;
  const names = ["getAccountInfo", "getMultipleAccountsInfo", "getProgramAccounts", "getGenesisHash", "getSlot", "getBlockTime"] as const;
  const originals = names.map(n => Connection.prototype[n]);
  globalThis.fetch = async (url, init) => {
    const host = new URL(String(url)).hostname;
    assert.ok(["api.jup.ag", "transaction-v1.raydium.io"].includes(host), "All RPC must use in-memory fixtures");
    assert.notEqual(init?.method, "POST");
    return new Response("no aggregator route", { status: 503 });
  };
  try {
    for (const kind of ["pump", "dbc"] as const) {
      const f = fixture(kind);
      for (const name of names) (Connection.prototype as any)[name] = f.connection[name].bind(f.connection);
      for (const buy of [true, false]) {
        if (kind === "dbc" && buy) {
          await assert.rejects(() => quote(SOL, f.mint.toBase58(), "1000000", 100, undefined, 5), /Entry blocked|LP|pool/i);
          continue;
        }
        const q = await quote(buy ? SOL : f.mint.toBase58(), buy ? f.mint.toBase58() : SOL, "1000000", 100, undefined, 5);
        assert.equal(q.router, kind);
        assert.equal(q.transaction, undefined);
      }
    }
  } finally {
    globalThis.fetch = fetch;
    names.forEach((n, i) => { (Connection.prototype as any)[n] = originals[i]; });
  }
});
test("Pump native reserve mapping values actual lamports, never virtual SOL; migrations/missing balances are gaps", () => {
  const f = fixture("pump");
  const pair = { pool: f.pool.toBase58(), vaultA: f.baseVault.toBase58(), vaultB: f.pool.toBase58(),
    mintA: f.mint.toBase58(), mintB: SOL, decimalsA: 0, decimalsB: 9, nativeB: true, venue: "Pump" };
  const tx = { slot: 1, transaction: { message: { accountKeys: [{ pubkey: pair.vaultA }, { pubkey: pair.vaultB }] } },
    meta: { err: null, preBalances: [0, 1000000000], postBalances: [0, 500000000],
      preTokenBalances: [{ accountIndex: 0, mint: pair.mintA, uiTokenAmount: { amount: "100" } }],
      postTokenBalances: [{ accountIndex: 0, mint: pair.mintA, uiTokenAmount: { amount: "100" } }],
      logMessages: [] as string[] } };
  assert.deepEqual(vaultSnapshot(tx, pair, { [SOL]: 100, [pair.mintA]: 1 }), { before: 200, after: 150 });
  tx.meta.logMessages.push("Program log: Instruction: Migrate");
  assert.equal(vaultSnapshot(tx, pair, { [SOL]: 100, [pair.mintA]: 1 }), null);
  tx.meta.logMessages = []; tx.meta.preBalances = [];
  assert.equal(vaultSnapshot(tx, pair, { [SOL]: 100, [pair.mintA]: 1 }), null);
});
