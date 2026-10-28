import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair } from "@solana/web3.js";
import { pool } from "@workspace/db";
import { fixture } from "./helpers/launchpad-fixtures";
import { verifyLaunchCandidate, verifyLaunchpadEntry } from "../src/lib/sentinel/launchpad-entry";
import { discover } from "../src/lib/sentinel/market";
import { openPosition } from "../src/lib/sentinel/engine";
import { initialState } from "../src/lib/sentinel/store";
import { SOL } from "../src/lib/sentinel/discovery-policy";
import { checkCrazySafety } from "../src/lib/sentinel/crazy-safety";

import { fixtureRpcPool } from "./rpc-fixture";
test("real Pump layout verifies discovery and permits an isolated native paper buy; labels, DBC and completed curves cannot authorize", async () => {
  const restoreRpcPool = fixtureRpcPool();
  process.env.SOLANA_RPC_URL = "https://fixture.invalid";
  process.env.JUPITER_API_KEY = "fixture-only";
  const f = fixture("pump"), dbc = fixture("dbc"), ordinary = Keypair.generate().publicKey.toBase58();
  // A liquid active launch, not the tiny low-reserve SDK smoke-test fixture.
  f.state.virtualQuoteReserves = f.state.virtualQuoteReserves.muln(1000);
  f.state.realQuoteReserves = f.state.realQuoteReserves.muln(1000);
  f.state.realTokenReserves = new f.state.realTokenReserves.constructor("594825000000000");
  f.state.virtualTokenReserves = f.state.realTokenReserves.muln(2);
  f.setState();
  f.accounts.get(f.pool.toBase58())!.lamports = Number(f.state.realQuoteReserves.toString()) + 10000000;
  f.accounts.get(f.baseVault.toBase58())!.data.writeBigUInt64LE(800000000000000n, 64);
  let creatorHeld = 0n;
  let extraHolders: any[] = [];
  const creatorAccount = Keypair.generate().publicKey;
  f.connection.getTokenLargestAccounts = async () => ({ context: { slot: 100 }, value: [{ address: f.baseVault, amount: "800000000000000", decimals: 6 }, ...extraHolders] });
  f.connection.getTokenAccountsByOwner = async () => {
    const account = f.accounts.get(f.baseVault.toBase58())!, data = Buffer.from(account.data);
    f.state.creator.toBuffer().copy(data, 32); data.writeBigUInt64LE(creatorHeld, 64);
    return { context: { slot: 100 }, value: creatorHeld ? [{ pubkey: creatorAccount, account: { ...account, data } }] : [] };
  };
  const methods = ["getAccountInfo", "getMultipleAccountsInfo", "getGenesisHash", "getSlot", "getBlockTime", "getTokenLargestAccounts", "getTokenAccountsByOwner"] as const;
  const originals = methods.map(n => Connection.prototype[n]), originalFetch = globalThis.fetch, originalQuery = pool.query;
  for (const n of methods) (Connection.prototype as any)[n] = f.connection[n].bind(f.connection);
  (pool as any).query = async () => ({ rows: [{ halted: false, emergency_requested: false }] });
  let buyAggregatorCalls = 0;
  globalThis.fetch = async input => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/recent")) return Response.json([f.mint.toBase58(), dbc.mint.toBase58(), ordinary].map(id => ({
      id, symbol: "FIX", name: "Fixture", launchpad: "pump.fun", organicScore: 99, usdPrice: 1, liquidity: 50000,
      stats24h: { buyVolume: 200000, sellVolume: 100000 }, stats5m: { numBuys: 20, numSells: 5, priceChange: 3 },
      updatedAt: new Date().toISOString(), firstPool: { createdAt: new Date(Date.now() - 3600000).toISOString() },
    })));
    if (u.pathname.includes("/swap/")) {
      const inputMint = u.searchParams.get("inputMint")!;
      if (inputMint === SOL) buyAggregatorCalls++;
      return Response.json({ inputMint, outputMint: SOL, inAmount: u.searchParams.get("amount"), outAmount: "198000000",
        router: "metis", slippageBps: 100, priceImpactPct: 0, routePlan: [] });
    }
    assert.ok(u.hostname.includes("dexscreener"), "no unrelated discovery feeds or live RPC");
    const mints = u.pathname.split("/").at(-1)!.split(",");
    if (!mints.includes(SOL)) assert.deepEqual(mints, [f.mint.toBase58()], "market scanning only receives an approved mint");
    return Response.json(mints.map(mint => ({
      chainId: "solana", baseToken: { address: mint, symbol: "FIX", name: "Fixture" }, dexId: "pumpfun",
      pairAddress: f.pool.toBase58(), priceUsd: mint === SOL ? "100" : "1", liquidity: { usd: 50000 },
      volume: { h24: 300000, m5: 1000 }, priceChange: { m5: 3, h24: 3 },
      txns: { m5: { buys: 20, sells: 5 } }, pairCreatedAt: Date.now() - 3600000,
    })));
  };
  try {
    const list = await discover();
    assert.ok(list.length >= 1); const c = list.find(c => c.mint === f.mint.toBase58())!;
    assert.equal(c.launchpad, "Pump.fun"); assert.equal(c.poolAddress, f.pool.toBase58());
    assert.ok(c.launchpadVerification?.verifiedAt);
    const s = initialState(); s.running = true; s.cashSol = 1; s.solPriceUsd = 100; s.dailyStartEquity = 0;
    s.settings.positionSizeUsd = 20; s.settings.slippageBps = 100; s.settings.minAgeMinutes = 10;
    c.status = "eligible"; c.score = 99;
    await openPosition("fixture", s, c, 6, false, async () => {});
    assert.equal(s.positions.length, 1); assert.equal(s.positions[0].mode, "paper");
    assert.match(s.positions[0].executionVenue!, /Pump/); assert.equal(s.positions[0].txSignature, null);
    assert.equal(buyAggregatorCalls, 0, "no pool/aggregator buy fallback");
    f.accounts.get(f.baseVault.toBase58())!.data.writeBigUInt64LE(700000000000000n, 64);
    const observed = await checkCrazySafety(c, s.settings);
    assert.equal(observed.top10Pct, 0, "unsampled supply is not invented as a top-ten balance");
    assert.equal(observed.holderCoveragePct, 70, "the partial observed sample is disclosed, not claimed as a full ranking");
    f.accounts.get(f.baseVault.toBase58())!.data.writeBigUInt64LE(800000000000000n, 64);
    await assert.rejects(() => verifyLaunchCandidate({ ...c, mint: ordinary, launchpad: "Pump.fun" }, true), /Launchpad-only/);
    creatorHeld = 100000000000001n;
    await assert.rejects(() => checkCrazySafety(c, s.settings), /Creator holds over 10%/);
    creatorHeld = 100000000000000n;
    assert.equal((await checkCrazySafety(c, s.settings)).creatorHoldingPct, 10, "exactly 10% is permitted");
    creatorHeld = 0n;
    f.accounts.get(f.baseVault.toBase58())!.data.writeBigUInt64LE(750000000000000n, 64);
    const holder = Keypair.generate().publicKey, owner = Keypair.generate().publicKey;
    const template = f.accounts.get(f.baseVault.toBase58())!, data = Buffer.from(template.data);
    owner.toBuffer().copy(data, 32); data.writeBigUInt64LE(250000000000000n, 64);
    f.accounts.set(holder.toBase58(), { ...template, data });
    extraHolders = [{ address: holder, amount: "250000000000000", decimals: 6 }];
    await assert.rejects(() => checkCrazySafety(c, s.settings), /must be below 25%/);
    extraHolders = [];
    // Changing chain state invalidates a previous successful proof at the final buy gate.
    f.state.complete = true; f.setState();
    await assert.rejects(() => verifyLaunchpadEntry(f.mint.toBase58(), true), /Launchpad-only/);
  } finally {
    restoreRpcPool();
    methods.forEach((n, i) => { (Connection.prototype as any)[n] = originals[i]; });
    globalThis.fetch = originalFetch; pool.query = originalQuery;
  }
});
