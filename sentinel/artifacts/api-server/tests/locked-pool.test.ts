import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { moonitFixture } from "./helpers/moonit-fixture";
import { account, token } from "./helpers/launchpad-fixtures";
import { CPMM_PROGRAM, CPMM_AUTHORITY } from "../src/lib/sentinel/curve-policy";
import { SOL } from "../src/lib/sentinel/discovery-policy";
import { lockedPoolState, assertLockedPoolQuote, assertLockedPoolTransaction } from "../src/lib/sentinel/locked-pool";
import { initialState } from "../src/lib/sentinel/store";
import { openPosition } from "../src/lib/sentinel/engine";
import { assess } from "../src/lib/sentinel/analysis";
import { boundedEvidence } from "../src/lib/sentinel/rpc-context";
import { pool as database } from "@workspace/db";
import type { Candidate } from "../src/lib/sentinel/types";

function fixture() {
  const f = moonitFixture(), pool = Keypair.generate().publicKey, base = Keypair.generate().publicKey,
    quote = Keypair.generate().publicKey, lpMint = Keypair.generate().publicKey, data = Buffer.alloc(637), lp = Buffer.alloc(82);
  createHash("sha256").update("account:PoolState").digest().copy(data, 0, 0, 8);
  for (const [offset, key] of [[72, base], [104, quote], [136, lpMint], [168, f.mint], [200, new PublicKey(SOL)]] as const)
    key.toBuffer().copy(data, offset);
  data[328] = PublicKey.findProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed")], CPMM_PROGRAM)[1];
  data.writeBigUInt64LE(1000000000n, 333); data.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000) - 3600), 373);
  MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: CPMM_AUTHORITY, supply: 0n, decimals: 9, isInitialized: true,
    freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, lp);
  f.accounts.set(pool.toBase58(), account(CPMM_PROGRAM, data)); f.accounts.set(lpMint.toBase58(), account(TOKEN_PROGRAM_ID, lp));
  f.accounts.set(base.toBase58(), token(f.mint, CPMM_AUTHORITY, 900000000000000000n));
  f.accounts.set(quote.toBase58(), token(new PublicKey(SOL), CPMM_AUTHORITY, 50000000000n));
  f.accounts.set(CPMM_PROGRAM.toBase58(), { ...account(new PublicKey("BPFLoader2111111111111111111111111111111111"), Buffer.alloc(1)), executable: true });
  f.connection.getTokenLargestAccounts = async () => ({ context: { slot: 100 }, value: [] });
  return { ...f, pool, base, quote, lpMint, data, lp };
}

test("ordinary SOL pools require full burned/inaccessible LP and exact token/program/vault controls", async () => {
  const f = fixture();
  const proof = await lockedPoolState(f.connection, f.mint, f.pool.toBase58());
  assert.equal(proof.phase, "pool"); assert.ok(proof.baseVault.equals(f.base));
  f.lp.writeBigUInt64LE(1n, 36);
  await assert.rejects(() => lockedPoolState(f.connection, f.mint, f.pool.toBase58()), /not fully burned/);
  f.lp.writeBigUInt64LE(0n, 36); f.lp.writeUInt32LE(1, 46);
  await assert.rejects(() => lockedPoolState(f.connection, f.mint, f.pool.toBase58()), /authorities/);
  f.lp.writeUInt32LE(0, 46); f.data[329] = 4;
  await assert.rejects(() => lockedPoolState(f.connection, f.mint, f.pool.toBase58()), /non-trading/);
  f.data[329] = 0; f.accounts.get(f.base.toBase58())!.data.writeUInt32LE(1, 72);
  await assert.rejects(() => lockedPoolState(f.connection, f.mint, f.pool.toBase58()), /vault/);
  f.accounts.get(f.base.toBase58())!.data.writeUInt32LE(0, 72);
  await assert.rejects(() => lockedPoolState(f.connection, Keypair.generate().publicKey, f.pool.toBase58()), /exact token/);
});

test("permanent sink custody works but delegated or removable/unknown lockers never do", async () => {
  const f = fixture(), custody = Keypair.generate().publicKey;
  f.lp.writeBigUInt64LE(1000000000n, 36);
  const sink = token(f.lpMint, new PublicKey("1nc1nerator11111111111111111111111111111111"), 1000000000n);
  f.accounts.set(custody.toBase58(), sink);
  f.connection.getTokenLargestAccounts = async () => ({ context: { slot: 100 }, value: [
    { address: custody, amount: "1000000000", decimals: 9, uiAmount: 1, uiAmountString: "1" },
  ] });
  assert.equal((await lockedPoolState(f.connection, f.mint, f.pool.toBase58())).phase, "pool");
  sink.data.writeUInt32LE(1, 72);
  await assert.rejects(() => lockedPoolState(f.connection, f.mint, f.pool.toBase58()), /not fully burned/);
  sink.data.writeUInt32LE(0, 72); Keypair.generate().publicKey.toBuffer().copy(sink.data, 32);
  await assert.rejects(() => lockedPoolState(f.connection, f.mint, f.pool.toBase58()), /not fully burned/);
});

test("protected quotes reject multihop/other pools and encoded swaps cannot substitute pools or vaults", async () => {
  const f = fixture(), proof = await lockedPoolState(f.connection, f.mint, f.pool.toBase58());
  const q = { router: "raydium", routePlan: [{ poolId: f.pool.toBase58() }] };
  assert.doesNotThrow(() => assertLockedPoolQuote(q, proof));
  assert.throws(() => assertLockedPoolQuote({ ...q, router: "metis" }, proof), /single direct/);
  assert.throws(() => assertLockedPoolQuote({ ...q, routePlan: [...q.routePlan, ...q.routePlan] }, proof), /single direct/);
  const user = Keypair.generate().publicKey, make = (pool: PublicKey, vault: PublicKey) => {
    const keys = [user, CPMM_AUTHORITY, Keypair.generate().publicKey, pool, Keypair.generate().publicKey,
      Keypair.generate().publicKey, vault, f.base, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, new PublicKey(SOL), f.mint];
    return new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [new TransactionInstruction({ programId: CPMM_PROGRAM, keys: keys.map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i >= 3 && i <= 7 })), data: Buffer.alloc(24) })],
    }).compileToV0Message());
  };
  const tx = make(f.pool, f.quote);
  assert.ok(tx.signatures.every(s => s.every(v => v === 0)));
  assert.doesNotThrow(() => assertLockedPoolTransaction(tx, tx.message.getAccountKeys(), proof));
  const wrongPool = make(Keypair.generate().publicKey, f.quote), wrongVault = make(f.pool, Keypair.generate().publicKey);
  assert.throws(() => assertLockedPoolTransaction(wrongPool, wrongPool.message.getAccountKeys(), proof), /pool\/vaults/);
  assert.throws(() => assertLockedPoolTransaction(wrongVault, wrongVault.message.getAccountKeys(), proof), /pool\/vaults/);
});

test("a verified ordinary LP-protected token reaches the real paper-entry flow without signing or broadcasting", async () => {
  const f = fixture(), oldFetch = globalThis.fetch, oldInfo = Connection.prototype.getAccountInfo,
    oldMulti = Connection.prototype.getMultipleAccountsInfo, oldLargest = Connection.prototype.getTokenLargestAccounts, oldQuery = database.query;
  f.accounts.set(f.quote.toBase58(), token(new PublicKey(SOL), CPMM_AUTHORITY, 500000000000n));
  Connection.prototype.getAccountInfo = f.connection.getAccountInfo as any;
  Connection.prototype.getMultipleAccountsInfo = f.connection.getMultipleAccountsInfo as any;
  const holder = Keypair.generate().publicKey;
  f.accounts.set(holder.toBase58(), token(f.mint, Keypair.generate().publicKey, 100000000000000000n));
  Connection.prototype.getTokenLargestAccounts = (async () => ({ context: { slot: 100 }, value: [
    { address: f.base, amount: "900000000000000000", decimals: 9, uiAmount: 900000000, uiAmountString: "900000000" },
    { address: holder, amount: "100000000000000000", decimals: 9, uiAmount: 100000000, uiAmountString: "100000000" },
  ] })) as any;
  database.query = (async () => ({ rows: [{ halted: false, emergency: false }] })) as any;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname.includes("dexscreener.com")) return Response.json([
      { chainId: "solana", baseToken: { address: SOL }, priceUsd: "100", liquidity: { usd: 1000000 } },
    ]);
    if (!url.hostname.includes("raydium.io")) return new Response("{}", { status: 503 });
    const amount = BigInt(url.searchParams.get("amount")!), incoming = url.searchParams.get("inputMint") === SOL;
    const out = incoming ? amount * 1800000n : amount / 1800000n;
    return Response.json({ success: true, data: {
      swapType: "BaseIn", inputMint: url.searchParams.get("inputMint"), outputMint: url.searchParams.get("outputMint"),
      inputAmount: amount.toString(), outputAmount: out.toString(), otherAmountThreshold: (out * 99n / 100n).toString(),
      slippageBps: 100, priceImpactPct: 0.001, routePlan: [{ poolId: f.pool.toBase58(),
        inputMint: url.searchParams.get("inputMint"), outputMint: url.searchParams.get("outputMint") }],
    } });
  };
  try {
    const s = initialState(); s.running = true; s.cashSol = 1; s.solPriceUsd = 100; s.dailyStartEquity = 0;
    s.settings.positionSizeUsd = 20; s.settings.slippageBps = 100;
    s.settings.minAgeMinutes = 10; s.settings.minLiquidityUsd = 10000; s.settings.minVolumeUsd = 100000;
    const c = { mint: f.mint.toBase58(), poolAddress: f.pool.toBase58(), symbol: "LPTEST", name: "LP fixture",
      status: "eligible", score: 99, priceUsd: 0.0000555555556, liquidityUsd: 50000, volume24hUsd: 200000,
      buys5m: 20, sells5m: 2, change5mPct: 3, change24hPct: 3, ageMinutes: 60, risks: [],
      marketDataStatus: "market_data_available", missingMarketData: [], updatedAt: new Date().toISOString(),
    } as Candidate;
    const stalledAi = boundedEvidence(() => new Promise<never>(() => {}), 10).catch(() => "optional timeout");
    const fast = await assess(c, s, async () => {}, "fast");
    assert.equal(await stalledAi, "optional timeout");
    assert.equal(fast.candidate.status, "eligible"); assert.equal(s.aiCalls, 0, "first scan never waits for paid AI");
    await openPosition("isolated-lp-fixture", s, c, fast.decimals, fast.staged, async () => {});
    assert.equal(s.positions.length, 1); assert.equal(s.positions[0].mode, "paper");
    assert.equal(s.positions[0].txSignature, null); assert.match(s.positions[0].executionVenue!, /Raydium/);
    assert.equal(c.lpVerification?.protectedPct, 100); assert.equal(c.launchpadVerification, undefined);
    assert.equal(s.positions[0].exitPlan?.firstTargetPct, 100);
  } finally {
    globalThis.fetch = oldFetch; Connection.prototype.getAccountInfo = oldInfo;
    Connection.prototype.getMultipleAccountsInfo = oldMulti; Connection.prototype.getTokenLargestAccounts = oldLargest; database.query = oldQuery;
  }
});
