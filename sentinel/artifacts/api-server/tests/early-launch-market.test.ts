import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { discover, getMarkets, refreshLaunchDiscovery } from "../src/lib/sentinel/market";
import { initialState } from "../src/lib/sentinel/store";
import { emptyLaunchDiscovery } from "../src/lib/sentinel/launch-discovery";
import { PUMP_PROGRAM, DBC_PROGRAM } from "../src/lib/sentinel/curve-policy";
import { entryFilters } from "../src/lib/sentinel/analysis";
import { TOKEN_PROGRAM_ID } from "../src/lib/sentinel/token-policy";
import { GetCandidatesResponse } from "@workspace/api-zod";
import { fixtureRpcPool } from "./rpc-fixture";

test("persisted Pump/Bags-DBC launches surface without any indexer data and become market-backed only on real evidence", async () => {
  const s = initialState(), time = Date.now(), original = globalThis.fetch;
  const restoreRpcPool = fixtureRpcPool();
  const [pump, dbc] = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  s.launchDiscovery = { ...emptyLaunchDiscovery(), lastPollAt: time,
    records: [pump, dbc].map((mint, i) => ({
      mint, program: (i ? DBC_PROGRAM : PUMP_PROGRAM).toBase58(), pool: Keypair.generate().publicKey.toBase58(),
      signature: "mock-creation", slot: 1, createdAt: i ? null : time - 3600000,
      observedAt: time, tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    })) };
  let indexed = false, rpc = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (!url.includes("dexscreener") && !url.includes("api.jup.ag")) { rpc++; throw new Error("No RPC/network side effects allowed"); }
    if (indexed && url.includes("/tokens/v1/solana/")) return Response.json([{
      chainId: "solana", baseToken: { address: pump, symbol: "INDEXED", name: "Indexed launch" },
      priceUsd: 0.1, liquidity: { usd: 50000 }, volume: { h24: 200000 },
      txns: { m5: { buys: 20, sells: 2 } }, priceChange: { m5: 1, h24: 1 },
      // Creation age must come from the persisted verified event, not invented.
    }]);
    return indexed ? Response.json([]) : new Response("{}", { status: 503 });
  };
  try {
    await refreshLaunchDiscovery(s, async () => undefined);
    assert.equal(s.candidates.length, 0, "creation records alone do not authorize candidates");
    const list = GetCandidatesResponse.parse(await discover(s, async () => undefined));
    assert.equal(list.length, 1, "a Pump creation remains visible as pending, never silently discarded");
    assert.equal(list[0].launchpadVerification?.phase, "observed");
    assert.ok(list.every(c => c.marketDataStatus === "awaiting_market_data"));
    assert.ok(list.every(c => entryFilters(c, s).length > 0));
    indexed = true;
    const [ready] = await getMarkets([pump]);
    assert.equal(ready.symbol, "INDEXED");
    assert.equal(ready.priceUsd, 0.1);
    assert.equal(ready.marketDataStatus, "market_data_available");
    assert.deepEqual(ready.missingMarketData, []);
    assert.ok(ready.ageMinutes > 59);
    assert.equal(ready.safetyChecked, false, "market readiness never grants holder/authority/AI clearance");
    assert.equal(ready.score, null);
    assert.equal(ready.status, "discovered");
    assert.ok(rpc > 0, "a live RPC proof is required even for a persisted creation");
  } finally { globalThis.fetch = original; restoreRpcPool(); }
});
