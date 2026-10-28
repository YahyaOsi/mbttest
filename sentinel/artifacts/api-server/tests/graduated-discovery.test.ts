import test from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import { graduatedFixture } from "./helpers/graduated-fixtures";
import { fixture, n } from "./helpers/launchpad-fixtures";
import { discover, getMarkets, resetLaunchDiscoveryConnection } from "../src/lib/sentinel/market";
import { initialState } from "../src/lib/sentinel/store";
import { emptyLaunchDiscovery } from "../src/lib/sentinel/launch-discovery";
import { PUMP_PROGRAM } from "../src/lib/sentinel/curve-policy";
import { SOL } from "../src/lib/sentinel/discovery-policy";
import { assessmentQueue } from "../src/lib/sentinel/scan-policy";
import { assess } from "../src/lib/sentinel/analysis";

import { fixtureRpcPool } from "./rpc-fixture";
test("cold-cache scanner fetches activity for retained graduated creations and reaches real assessment; active volume survives native pricing", async () => {
  const restoreRpcPool = fixtureRpcPool();
  const f = graduatedFixture(), active = fixture("pump");
  active.state.realTokenReserves = n("594825000000000"); active.setState();
  const env = process.env.SOLANA_RPC_URL, fetch = globalThis.fetch;
  process.env.SOLANA_RPC_URL = "https://fixture.invalid";
  const methods = ["getAccountInfo", "getMultipleAccountsInfo", "getTokenLargestAccounts", "getTokenAccountsByOwner"] as const;
  const originals = methods.map(m => Connection.prototype[m]);
  const accounts = new Map([...f.accounts, ...active.accounts]);
  Connection.prototype.getAccountInfo = async key => accounts.get(key.toBase58()) ?? null;
  Connection.prototype.getMultipleAccountsInfo = async keys => {
    assert.ok(keys.length <= 5);
    return keys.map(k => accounts.get(k.toBase58()) ?? null);
  };
  Connection.prototype.getTokenLargestAccounts = (async (mint: PublicKey) => ({
    context: { slot: 100 }, value: [{ address: mint.equals(f.mint) ? f.migratedBase : active.baseVault,
      amount: "800000000000000", decimals: 6, uiAmount: 800000000, uiAmountString: "800000000" }],
  })) as any;
  Connection.prototype.getTokenAccountsByOwner = (async () => ({ context: { slot: 100 }, value: [] })) as any;
  const searches: string[][] = [];
  let dexOnly = false;
  const metadata = (mint: string) => ({ id: mint, launchpad: "untrusted-label", symbol: "FIX", name: "Fixture",
    usdPrice: 999, liquidity: 9999999, updatedAt: new Date().toISOString(),
    stats24h: { buyVolume: 200000, sellVolume: 100000 }, stats5m: { numBuys: 20, numSells: 2,
      buyVolume: 1000, sellVolume: 100, priceChange: 3 }, firstPool: { createdAt: new Date(Date.now() - 3600000).toISOString() } });
  globalThis.fetch = async url => {
    const u = new URL(String(url));
    if (u.hostname === "api.jup.ag") {
      assert.ok(u.pathname.endsWith("/search"), "retained creations must not depend on a recent-token feed");
      const mints = u.searchParams.get("query")!.split(",");
      searches.push(mints);
      return dexOnly ? Response.json([]) : Response.json(mints.map(metadata));
    }
    assert.equal(u.hostname, "api.dexscreener.com", "no live RPC, quotes, AI or trades in scanner test");
    const mints = u.pathname.split("/").at(-1)!.split(",");
    return Response.json(mints.map(mint => ({
      chainId: "solana", baseToken: { address: mint, symbol: "FIX", name: "Fixture" }, dexId: "untrusted-dex",
      pairAddress: f.user.toBase58(), priceUsd: mint === SOL ? "100" : "777", liquidity: { usd: 999999 },
      volume: { h24: 300000, m5: 1100 }, priceChange: { m5: 3, h24: 4 },
      txns: { m5: { buys: 20, sells: 2 } }, pairCreatedAt: Date.now() - 3600000,
    })));
  };
  const s = initialState(); s.solPriceUsd = 100; s.settings.riskMode = "crazy"; s.settings.crazyAcknowledged = true;
  s.launchDiscovery = { ...emptyLaunchDiscovery(), lastPollAt: Date.now(),
    records: [f, active].map(item => ({ mint: item.mint.toBase58(), pool: item.pool.toBase58(),
      program: PUMP_PROGRAM.toBase58(), observedAt: Date.now(), createdAt: Date.now() - 3600000, signature: "fixture",
      slot: 100, tokenProgram: item.accounts.get(item.mint.toBase58())!.owner.toBase58() })) };
  try {
    const list = await discover(s, async () => {}, 0);
    assert.equal(list.length, 2); assert.equal(searches.length, 1);
    assert.deepEqual(new Set(searches[0]), new Set([f.mint.toBase58(), active.mint.toBase58()]));
    const graduated = list.find(c => c.mint === f.mint.toBase58())!;
    assert.equal(graduated.launchpadVerification?.phase, "graduated");
    assert.equal(graduated.poolAddress, f.migratedPool.toBase58(), "indexed pairAddress must not authorize a pool");
    assert.equal(graduated.curveProgressPct, undefined);
    assert.equal(graduated.liquidityUsd, 10000); assert.notEqual(graduated.priceUsd, 777);
    assert.equal(graduated.volume24hUsd, 300000); assert.equal(graduated.buys5m, 20);
    assert.deepEqual(graduated.missingMarketData, []); assert.equal(graduated.marketDataStatus, "market_data_available");
    s.candidates = list;
    assert.ok(assessmentQueue(s).some(c => c.mint === graduated.mint));
    const assessed = await assess(graduated, s, async () => {});
    assert.equal(assessed.candidate.status, "eligible", assessed.candidate.reasoning);
    assert.equal(assessed.strategy, "momentum");
    const [priced] = await getMarkets([active.mint.toBase58()]);
    assert.equal(priced.volume24hUsd, 300000, "native overlay retains indexed 24h volume instead of 5m-only observations");
    assert.equal(priced.liquidityUsd, 2000); assert.notEqual(priced.priceUsd, 777);
    assert.equal(priced.launchpadVerification?.phase, "active");
    // A new graduated mint with no cached Jupiter data can use DEX activity,
    // but must still prove its own canonical on-chain pool.
    const other = graduatedFixture();
    for (const [key, value] of other.accounts) accounts.set(key, value);
    dexOnly = true;
    s.launchDiscovery.records.push({ mint: other.mint.toBase58(), pool: other.pool.toBase58(),
      program: PUMP_PROGRAM.toBase58(), observedAt: Date.now(), createdAt: Date.now() - 3600000,
      signature: "fixture-2", slot: 100, tokenProgram: other.accounts.get(other.mint.toBase58())!.owner.toBase58() });
    const fromDex = (await discover(s, async () => {}, 0)).find(c => c.mint === other.mint.toBase58())!;
    assert.equal(fromDex.buys5m, 20); assert.equal(fromDex.volume24hUsd, 300000);
    assert.equal(fromDex.poolAddress, other.migratedPool.toBase58()); assert.deepEqual(fromDex.missingMarketData, []);
  } finally {
    restoreRpcPool();
    resetLaunchDiscoveryConnection();
    methods.forEach((m, i) => { (Connection.prototype as any)[m] = originals[i]; });
    globalThis.fetch = fetch;
    if (env === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = env;
  }
});
