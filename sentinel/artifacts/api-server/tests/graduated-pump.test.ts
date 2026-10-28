import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { graduatedFixture } from "./helpers/graduated-fixtures";
import { token } from "./helpers/launchpad-fixtures";
import { graduatedPumpState } from "../src/lib/sentinel/pump-graduated";
import { authorizeGraduatedQuote, assertGraduatedAuthorization, assertGraduatedInstruction,
  assertGraduatedTransaction, assertGraduatedSimulation } from "../src/lib/sentinel/graduated-route-policy";
import { PUMP_AMM_PROGRAM } from "../src/lib/sentinel/curve-policy";
import { anchorTag } from "../src/lib/sentinel/launchpad-policy";
import { entryFilters } from "../src/lib/sentinel/analysis";
import { initialState } from "../src/lib/sentinel/store";
import { SOL } from "../src/lib/sentinel/discovery-policy";

test("official origin + canonical migration + actual burned LP supply, never provider labels or Pool.lp_supply", async () => {
  const f = graduatedFixture(), read = () => graduatedPumpState(f.connection, f.mint);
  const proof = await read();
  assert.equal(proof.phase, "graduated"); assert.ok(proof.pool.equals(f.migratedPool));
  assert.ok(proof.quote.amount > 0n); assert.ok(!f.migratedState.lpSupply.isZero(), "Pool.lp_supply does not reflect burns");
  for (const supply of [1n, 10000000n]) {
    f.setLp(supply); await assert.rejects(read, /removable/);
  }
  f.setLp(0n, f.user); await assert.rejects(read, /controlled/);
  f.setLp(0n, f.migratedPool, true); await assert.rejects(read, /freezeable/); f.setLp();
  f.accounts.set(f.migratedBase.toBase58(), token(f.mint, f.user, 100n));
  await assert.rejects(read, /externally controlled/);
  f.accounts.set(f.migratedBase.toBase58(), token(f.mint, f.migratedPool, 100n, f.user));
  await assert.rejects(read, /externally controlled/);
  f.accounts.set(f.migratedBase.toBase58(), token(f.mint, f.migratedPool, 100n));
  f.migratedState.creator = f.user; f.setPool(); await assert.rejects(read, /noncanonical/);
  f.migratedState.creator = (await import("@pump-fun/pump-sdk")).pumpPoolAuthorityPda(f.mint); f.setPool();
  f.migratedState.poolQuoteTokenAccount = f.migratedBase; f.setPool(); await assert.rejects(read, /derivation/);
  f.migratedState.poolQuoteTokenAccount = f.migratedQuote; f.setPool();
  f.accounts.get(f.global.toBase58())!.data[56] = 8; await assert.rejects(read, /disabled/);
  f.accounts.get(f.global.toBase58())!.data[56] = 0;
  f.accounts.get(f.migratedQuote.toBase58())!.lamports = 2039280;
  await assert.rejects(read, /backed by real lamports/);
  f.accounts.get(f.migratedQuote.toBase58())!.lamports = 100002039280;
  f.state.complete = false; f.setState(); await assert.rejects(read, /origin/);
  f.state.complete = true; f.setState();
  f.accounts.delete(f.migratedPool.toBase58()); await assert.rejects(read, /migration pending.*Raydium/);
  f.setPool(); f.accounts.delete(f.pool.toBase58()); await assert.rejects(read, /origin/);
});

test("graduated authorization is object-bound, fresh, canonical, single-hop and does not broaden ordinary pool access", async () => {
  const f = graduatedFixture(), p = await graduatedPumpState(f.connection, f.mint), mint = f.mint.toBase58();
  const q = f.quote(); authorizeGraduatedQuote(q, p, mint); assertGraduatedAuthorization(q, p, mint);
  assert.throws(() => assertGraduatedAuthorization({ ...q }, p, mint), /locally authorized/);
  authorizeGraduatedQuote(q, { ...p, at: Date.now() - 31000 }, mint);
  assert.throws(() => assertGraduatedAuthorization(q, p, mint), /stale/);
  for (const edit of [
    { router: "raydium" }, { inputMint: mint }, { routePlan: [] },
    { routePlan: [q.routePlan[0], q.routePlan[0]] },
    { routePlan: [{ ...q.routePlan[0], percent: 50 }] },
    { routePlan: [{ ...q.routePlan[0], swapInfo: { ...q.routePlan[0].swapInfo, ammKey: f.user.toBase58() } }] },
    { platformFee: { amount: "1" } },
  ]) assert.throws(() => authorizeGraduatedQuote({ ...q, ...edit }, p, mint), /canonical/);
});

test("encoded v0 transactions and simulation must match exact amounts, single PumpSwap hop and canonical vaults", async () => {
  const f = graduatedFixture(), p = await graduatedPumpState(f.connection, f.mint), q = f.quote();
  for (const shared of [false, true]) {
    const tx = f.build(q, shared), keys = tx.message.getAccountKeys();
    assertGraduatedTransaction(tx, keys, q, p);
    const ix = tx.message.compiledInstructions[0], data = Buffer.from(ix.data);
    for (const offset of [0, shared ? 9 : 8, shared ? 13 : 12, shared ? 14 : 13, data.length - 1, data.length - 3]) {
      const wrong = Buffer.from(data); wrong[offset] ^= 1;
      assert.throws(() => assertGraduatedInstruction(wrong, BigInt(q.inAmount), BigInt(q.outAmount), q.slippageBps), /Encoded/);
    }
    assert.throws(() => assertGraduatedInstruction(data, BigInt(q.inAmount) + 1n, BigInt(q.outAmount), 100), /Encoded/);
    assert.throws(() => assertGraduatedInstruction(data, BigInt(q.inAmount), BigInt(q.outAmount) + 1n, 100), /Encoded/);
    const index = (key: PublicKey) => [...keys.staticAccountKeys].findIndex(k => k.equals(key));
    const wrongDestination = VersionedTransaction.deserialize(tx.serialize());
    wrongDestination.message.compiledInstructions[0].accountKeyIndexes[shared ? 6 : 3] = index(f.user);
    assert.throws(() => assertGraduatedTransaction(wrongDestination, keys, q, p), /binding mismatch/);
    const accounts = Array(9).fill(index(f.user));
    accounts[0] = index(p.pool); accounts[7] = index(p.baseVault); accounts[8] = index(p.quoteVault);
    const cpi = { programIdIndex: index(PUMP_AMM_PROGRAM), accounts, data: bs58.encode(Buffer.concat([anchorTag("buy"), Buffer.alloc(17)])) };
    assertGraduatedSimulation([{ index: 0, instructions: [cpi] }], keys, p);
    assert.throws(() => assertGraduatedSimulation(null, keys, p), /lacks/);
    assert.throws(() => assertGraduatedSimulation([], keys, p), /exactly one/);
    assert.throws(() => assertGraduatedSimulation([{ instructions: [cpi, cpi] }], keys, p), /exactly one/);
    assert.throws(() => assertGraduatedSimulation([{ instructions: [{ ...cpi, accounts: Array(9).fill(index(f.user)) }] }], keys, p), /different/);
    tx.sign([f.keypair]); assert.throws(() => assertGraduatedTransaction(tx, keys, q, p), /unsigned/);
  }
});

test("completed curves do not inherit active 15–40% window or low curve liquidity floors", () => {
  const s = initialState(); s.settings.minLiquidityUsd = 50000; s.settings.curveMinLiquidityUsd = 1;
  const c = { mint: Keypair.generate().publicKey.toBase58(), priceUsd: 1, liquidityUsd: 10000, volume24hUsd: 1000000,
    ageMinutes: 100, buys5m: 100, sells5m: 1, change5mPct: 1, updatedAt: new Date().toISOString(), curveProgressPct: 100,
    launchpadVerification: { phase: "graduated" }, launchpad: "Pump.fun" } as any;
  const reasons = entryFilters(c, s, true);
  assert.ok(!reasons.some(r => /progress/.test(r))); assert.ok(reasons.includes("Liquidity below limit"));
  c.launchpadVerification.phase = "active";
  assert.ok(entryFilters(c, s, true).some(r => /15–40/.test(r)));
  assert.equal(c.mint === SOL, false);
});
