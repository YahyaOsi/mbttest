import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { moonitFixture } from "./helpers/moonit-fixture";
import { verifyCreation } from "../src/lib/sentinel/launch-events";
import { MOONIT_PROGRAM, MOONIT_CONFIG, isMoonitTrade } from "../src/lib/sentinel/moonit-policy";
import { moonitState, registerMoonitOrigins } from "../src/lib/sentinel/moonit-state";
import { nativeCurveQuote } from "../src/lib/sentinel/launchpad-routes";
import { assertAuthorizedCurveBuild } from "../src/lib/sentinel/launchpad-policy";
import { launchAllocation, orderedLaunchWork, retainLaunchRecords } from "../src/lib/sentinel/launch-allocation";
import { PUMP_PROGRAM } from "../src/lib/sentinel/curve-policy";
import { LaunchDiscovery, emptyLaunchDiscovery } from "../src/lib/sentinel/launch-discovery";
import { SOL } from "../src/lib/sentinel/discovery-policy";
import { token } from "./helpers/launchpad-fixtures";
import { checkCrazySafety } from "../src/lib/sentinel/crazy-safety";
import { initialState } from "../src/lib/sentinel/store";
import { TOKEN_PROGRAM_ID } from "../src/lib/sentinel/token-policy";
import { ingestMoonitLogs, moonitActivity } from "../src/lib/sentinel/moonit-observations";
import type { Candidate } from "../src/lib/sentinel/types";

test("80/20 bounded discovery rotates both sources and safely spills unused slots", () => {
  const p = Array.from({ length: 40 }, (_, i) => `p${i}`), m = ["m0", "m1", "m2", "m3"], cursor = { pump: 0, secondary: 0 };
  const first = launchAllocation(p, m, cursor, 10), next = launchAllocation(p, m, cursor, 10);
  assert.equal(first.pump.length, 8); assert.equal(first.secondary.length, 2);
  assert.deepEqual(orderedLaunchWork(first).slice(0, 5), [...first.pump.slice(0, 4), first.secondary[0]]);
  assert.equal(orderedLaunchWork(first, 4)[0], "m0", "a deadline after four actual Pump attempts resumes on the secondary turn");
  assert.deepEqual(next.secondary, ["m2", "m3"]); assert.ok(!next.pump.includes(first.pump[0]));
  assert.equal(launchAllocation(p, [], cursor, 10).pump.length, 10);
  assert.equal(launchAllocation(["one"], m, cursor).secondary.length, 4);
  assert.deepEqual(launchAllocation([], [], cursor), { pump: [], secondary: [] });
  const at = Date.now(), base = { mint: "", program: "", pool: "", signature: "", slot: 1, createdAt: null, observedAt: at, tokenProgram: "" };
  const retained = retainLaunchRecords([...p.map(mint => ({ ...base, mint, program: PUMP_PROGRAM.toBase58() })),
    ...m.map(mint => ({ ...base, mint, program: MOONIT_PROGRAM.toBase58() }))], at, 10);
  assert.equal(retained.filter(r => r.program === MOONIT_PROGRAM.toBase58()).length, 2, "secondary records survive a primary flood");
});

test("Moonit creation requires genuine program/new mint/canonical curve/creator and backend signers", async () => {
  const f = moonitFixture();
  const record = await verifyCreation(f.connection, f.creation, "fixture-creation", MOONIT_PROGRAM, Date.now());
  assert.equal(record?.creator, f.creator.toBase58()); assert.equal(record?.backendAuthority, f.backend.toBase58());
  assert.equal(record?.pool, f.pool.toBase58());
  assert.equal(await verifyCreation(f.connection, f.creation, "fake", Keypair.generate().publicKey, Date.now()), null);
  f.creation.meta!.preBalances[3] = 1;
  assert.equal(await verifyCreation(f.connection, f.creation, "reused-mint", MOONIT_PROGRAM, Date.now()), null);
  f.creation.meta!.preBalances[3] = 0;
  f.creation.transaction.message.accountKeys[0].signer = false;
  assert.equal(await verifyCreation(f.connection, f.creation, "unsigned-creator", MOONIT_PROGRAM, Date.now()), null);
});

test("independent Moonit state rejects creator-controlled withdrawal/config, freeze/mint authority, unsupported curves and delegated vaults", async () => {
  const f = moonitFixture(), record = await verifyCreation(f.connection, f.creation, "origin", MOONIT_PROGRAM, Date.now());
  registerMoonitOrigins([record!]);
  const proof = await moonitState(f.connection, f.mint);
  assert.equal(proof.state.sold, 200000000000000000n); assert.ok(proof.realSolLamports > 0n);
  const config = Buffer.from(f.config);
  for (const offset of [8, 40, 72]) {
    f.creator.toBuffer().copy(f.config, offset);
    await assert.rejects(() => moonitState(f.connection, f.mint), /controls|creator/);
    config.copy(f.config);
  }
  f.curve[58] = 4;
  await assert.rejects(() => moonitState(f.connection, f.mint), /Unsupported/); f.curve[58] = 1;
  f.mintData.writeUInt32LE(1, 46);
  await assert.rejects(() => moonitState(f.connection, f.mint), /authority/); f.mintData.writeUInt32LE(0, 46);
  f.mintData.writeUInt32LE(1, 0);
  await assert.rejects(() => moonitState(f.connection, f.mint), /authority/); f.mintData.writeUInt32LE(0, 0);
  const vault = f.accounts.get(f.vault.toBase58())!;
  vault.data.writeUInt32LE(1, 72); Keypair.generate().publicKey.toBuffer().copy(vault.data, 76);
  await assert.rejects(() => moonitState(f.connection, f.mint), /vault/); vault.data.writeUInt32LE(0, 72);
  registerMoonitOrigins([]);
  await assert.rejects(() => moonitState(f.connection, f.mint), /creator.*proof/);
});

test("native Moonit exact-input buy/sell are locally built, bounded, unsigned and simulation-only", async () => {
  const f = moonitFixture(), record = await verifyCreation(f.connection, f.creation, "origin", MOONIT_PROGRAM, Date.now());
  registerMoonitOrigins([record!]);
  const user = Keypair.generate().publicKey.toBase58(), limits = { slippageBps: 100, maxPriceImpactPct: 10 };
  const buy = await nativeCurveQuote(SOL, f.mint.toBase58(), "10000000", limits, user, f.connection);
  assert.equal(buy.router, "moonit");
  for (const [q, buying] of [[buy, true], [await nativeCurveQuote(f.mint.toBase58(), SOL, "1000000000", limits, user, f.connection), false]] as const) {
    const tx = VersionedTransaction.deserialize(Buffer.from(q.transaction!, "base64")), keys = tx.message.getAccountKeys();
    assert.ok(tx.signatures.every(s => s.every(v => v === 0))); assertAuthorizedCurveBuild(q, tx);
    const swap = tx.message.compiledInstructions.find(i => keys.get(i.programIdIndex)!.equals(MOONIT_PROGRAM))!;
    assert.ok(swap); assert.ok(isMoonitTrade(swap.data, buying, BigInt(q.inAmount), BigInt(q.outAmount) * 99n / 100n));
    assert.ok(swap.accountKeyIndexes.some(i => keys.get(i)!.equals(MOONIT_CONFIG)));
    const edited = Buffer.from(swap.data); edited[24] = 1;
    assert.equal(isMoonitTrade(edited, buying, BigInt(q.inAmount), 1n), false);
    let simulations = 0;
    f.connection.simulateTransaction = (async (unsigned: VersionedTransaction) => {
      simulations++; assert.ok(unsigned.signatures.every(s => s.every(v => v === 0)));
      return { context: { slot: 101 }, value: { err: null, logs: ["fixture unsigned simulation"], unitsConsumed: 90000 } };
    }) as any;
    assert.equal((await f.connection.simulateTransaction(tx, { sigVerify: false })).value.err, null);
    assert.equal(simulations, 1);
    tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    assert.throws(() => assertAuthorizedCurveBuild(q, tx), /locally verified/);
  }
  registerMoonitOrigins([]);
});

test("creator limits and actual sampled non-curve wallet holdings stay mandatory without invented missing supply", async () => {
  const f = moonitFixture(), record = await verifyCreation(f.connection, f.creation, "safety-origin", MOONIT_PROGRAM, Date.now());
  registerMoonitOrigins([record!]);
  let held = f.total / 10n;
  const creatorToken = Keypair.generate().publicKey;
  f.connection.getTokenAccountsByOwner = async () => ({ context: { slot: 101 }, value: [
    { pubkey: creatorToken, account: token(f.mint, f.creator, held) },
  ] });
  f.connection.getTokenLargestAccounts = async () => ({ context: { slot: 101 },
    value: [{ address: f.vault, amount: f.remaining.toString(), decimals: 9, uiAmount: 800000000, uiAmountString: "800000000" }] });
  const settings = initialState().settings, c = { mint: f.mint.toBase58(), updatedAt: new Date().toISOString(), ageMinutes: 1 } as Candidate;
  assert.equal((await checkCrazySafety(c, settings, f.connection)).creatorHoldingPct, 10);
  held++;
  await assert.rejects(() => checkCrazySafety(c, settings, f.connection), /over 10%/);
  held = 0n;
  assert.equal((await checkCrazySafety(c, { ...settings, crazyTop10Pct: 15 }, f.connection)).top10Pct, 0,
    "unobserved supply must not be invented as a top-ten holding");
  const wallet = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
  const holders = [f.total / 20n, f.total / 20n, f.total / 50n].map((amount, i) => {
    const address = Keypair.generate().publicKey;
    f.accounts.set(address.toBase58(), token(f.mint, i < 2 ? wallet : other, amount));
    return { address, amount: amount.toString(), decimals: 9, uiAmount: 0, uiAmountString: "0" };
  });
  f.connection.getTokenLargestAccounts = async () => ({ context: { slot: 101 }, value: [
    { address: f.vault, amount: f.remaining.toString(), decimals: 9, uiAmount: 0, uiAmountString: "0" }, ...holders,
  ] });
  const sample = await checkCrazySafety(c, { ...settings, crazyTop10Pct: 15 }, f.connection);
  assert.equal(sample.top10Pct, 12);
  assert.equal(sample.holderAccountsObserved, 4);
  await assert.rejects(() => checkCrazySafety(c, { ...settings, crazyTop10Pct: 12 }, f.connection), /Observed top-10/);
  f.accounts.delete(holders[0].address.toBase58());
  await assert.rejects(() => checkCrazySafety(c, settings, f.connection), /Holder account unavailable|holder account unavailable/);
  const readAccounts = f.connection.getMultipleAccountsInfo.bind(f.connection);
  f.connection.getMultipleAccountsInfo = async (keys: PublicKey[]) =>
    keys.some(key => key.equals(holders[0].address)) ? [] : readAccounts(keys);
  await assert.rejects(() => checkCrazySafety(c, settings, f.connection), /Incomplete holder account response/);
  registerMoonitOrigins([]);
});

test("Moonit trade activity is accepted only inside real program frames and never fabricates an age/window", () => {
  const f = moonitFixture(), mint = f.mint.toBase58();
  const record = { mint, program: MOONIT_PROGRAM.toBase58(), pool: f.pool.toBase58(), signature: "origin", slot: 100,
    createdAt: null, observedAt: Date.now(), tokenProgram: TOKEN_PROGRAM_ID.toBase58() };
  const bytes = Buffer.alloc(149);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(bytes);
  bytes.writeBigUInt64LE(1000000000n, 8); bytes.writeBigUInt64LE(10000000n, 16);
  f.pool.toBuffer().copy(bytes, 48); f.mint.toBuffer().copy(bytes, 80); f.creator.toBuffer().copy(bytes, 112);
  const line = `Program data: ${bytes.toString("base64")}`, program = MOONIT_PROGRAM.toBase58();
  ingestMoonitLogs({ err: null, signature: "spoof", logs: [line] }, 100, [record]);
  assert.equal(moonitActivity(mint).count, 0);
  ingestMoonitLogs({ err: null, signature: "real", logs: [`Program ${program} invoke [1]`, line, `Program ${program} success`] }, 101, [record]);
  assert.equal(moonitActivity(mint).buys, 1);
  assert.equal(record.createdAt, null);
});

test("Moonit recovery is capped, persisted and survives reconnect/restart without losing pending creation", async () => {
  const f = moonitFixture();
  f.connection.onLogs = (() => 1) as any; f.connection.removeOnLogsListener = async () => {};
  f.connection.getSignaturesForAddress = async key => key.equals(MOONIT_PROGRAM) ? [{ signature: "recover", err: null, slot: 100, memo: null, blockTime: f.creation.blockTime }] : [];
  let available = false;
  f.connection.getParsedTransaction = async () => available ? f.creation : null;
  let state = emptyLaunchDiscovery(), persisted = structuredClone(state);
  const save = async () => { persisted = structuredClone(state); };
  const now = Date.now(), first = new LaunchDiscovery(f.connection);
  await first.poll(state, save, now);
  assert.deepEqual(state.sources[MOONIT_PROGRAM.toBase58()].pending, ["recover"]);
  await first.dispose();
  available = true;
  state = structuredClone(persisted);
  const restarted = new LaunchDiscovery(f.connection);
  await restarted.poll(state, save, now + 60000);
  assert.equal(state.records[0]?.mint, f.mint.toBase58());
  assert.deepEqual(state.sources[MOONIT_PROGRAM.toBase58()].pending, []);
  assert.match(state.status, /80\/20/);
  assert.ok(Number(state.status.match(/; (\d+)\//)![1]) <= 24);
  await restarted.dispose();
});
