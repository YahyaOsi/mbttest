import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { discover, getMarkets } from "../src/lib/sentinel/market";

test("multi-source discovery, mint batching and provider outages use real indexed data only", async () => {
  const original = globalThis.fetch;
  const originalKey = process.env.JUPITER_API_KEY;
  process.env.JUPITER_API_KEY = "isolated-test-fixture";
  const mints = Array.from({ length: 70 }, () => Keypair.generate().publicKey.toBase58());
  let downDex = false, downAll = false;
  const dexBatchSizes: number[] = [];
  const row = (mint: string, launchpad?: string) => ({
    id: mint, launchpad, symbol: "TOKEN", name: "Token", usdPrice: 1, liquidity: 40000,
    stats24h: { buyVolume: 200000, sellVolume: 100000 }, stats5m: { numBuys: 20, numSells: 5 },
    updatedAt: new Date().toISOString(), firstPool: { createdAt: new Date(Date.now() - 86400000).toISOString() },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (downAll || (downDex && url.hostname.includes("dexscreener"))) return new Response("{}", { status: 503 });
    if (url.pathname.endsWith("/recent")) return Response.json([row(mints[0], "pump.fun")]);
    if (url.pathname.includes("toptrending")) return Response.json([row(mints[1], "bags")]);
    if (url.pathname.includes("toporganicscore")) return Response.json([row(mints[2])]);
    if (url.pathname.endsWith("/search")) return Response.json(url.searchParams.get("query")!.split(",").map(m => row(m)));
    if (url.pathname.includes("token-profiles")) return Response.json([{ chainId: "solana", tokenAddress: mints[3] }, { chainId: "ethereum", tokenAddress: mints[4] }]);
    const requested = url.pathname.split("/").at(-1)!.split(",");
    dexBatchSizes.push(requested.length);
    return Response.json(requested.map(mint => ({
      chainId: "solana", dexId: "meteora", baseToken: { address: mint }, priceUsd: "1",
      liquidity: { usd: 40000 }, volume: { h24: 300000 }, pairCreatedAt: Date.now() - 86400000,
      txns: { m5: { buys: 20, sells: 5 } },
    })));
  };
  try {
    const discovered = await discover();
    assert.ok(discovered.length > 0, "indexed tokens are visible without labels authorizing a buy");
    assert.ok(discovered.every(c => c.status !== "eligible"));
    assert.equal(discovered.some(c => c.mint === mints[4]), false);
    const markets = await getMarkets(mints);
    assert.equal(markets.length, 70);
    assert.ok(dexBatchSizes.every(n => n <= 30));
    downDex = true;
    const fallback = await getMarkets([mints[0]]);
    assert.equal(fallback[0].discoverySource, "Jupiter Tokens");
    assert.equal(fallback[0].priceUsd, 1);
    assert.ok(fallback[0].risks.some(r => r.includes("DEX pool data unavailable")));
    downAll = true;
    await assert.rejects(() => getMarkets([Keypair.generate().publicKey.toBase58()]), /unavailable/);
  } finally {
    globalThis.fetch = original;
    if (originalKey === undefined) delete process.env.JUPITER_API_KEY; else process.env.JUPITER_API_KEY = originalKey;
  }
});
