import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MintLayout } from "@solana/spl-token";
import { pool } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { scan } from "../src/lib/sentinel/engine";
import { initialState } from "../src/lib/sentinel/store";
import { SOL } from "../src/lib/sentinel/discovery-policy";
import { TOKEN_PROGRAM_ID } from "../src/lib/sentinel/token-policy";
import { emptyLaunchDiscovery } from "../src/lib/sentinel/launch-discovery";

test("ordinary-token feeds cannot trigger analysis, paid AI or orders in launchpad-only mode", async () => {
  // Fully isolated simulation: no real DB, RPC, paid AI, signing or broadcasts.
  process.env.SOLANA_RPC_URL = "https://rpc.test.invalid";
  process.env.JUPITER_API_KEY = "synthetic-only";
  const bad = Keypair.generate().publicKey.toBase58();
  const good = Keypair.generate().publicKey.toBase58();
  const fetchBefore = globalThis.fetch, queryBefore = pool.query;
  const createBefore = openai.chat.completions.create;
  let paidCalls = 0, saves = 0, quoteCalls = 0;
  const token = (id: string) => ({ id, symbol: id === bad ? "BAD" : "GOOD", name: "Fixture",
    usdPrice: 1, liquidity: 50000, organicScore: 90, stats24h: { buyVolume: 150000, sellVolume: 50000 },
    stats5m: { numBuys: 20, numSells: 5, priceChange: 1 },
    updatedAt: new Date().toISOString(), firstPool: { createdAt: new Date(Date.now() - 86400000).toISOString() } });
  (pool as any).query = async (sql: string) => {
    assert.ok(sql.startsWith("SELECT halted"), "test must never write to the real DB");
    return { rows: [{ halted: false, emergency_requested: false }] };
  };
  (openai.chat.completions as any).create = async (body: any) => {
    paidCalls++;
    const evidence = JSON.parse(body.messages[1].content);
    assert.equal(evidence.safety.verifiedOnChain, true);
    assert.match(evidence.safety.mintAuthority, /revoked.*verified/);
    assert.match(evidence.safety.freezeAuthority, /revoked.*verified/);
    assert.equal(evidence.safety.tokenProgramAddress, TOKEN_PROGRAM_ID.toBase58());
    return { choices: [{ message: { content: JSON.stringify({
      score: 95, decision: "consider", exit: "staged", reasoning: "Synthetic test evidence only", redFlags: [],
    }) } }] };
  };
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === "rpc.test.invalid") {
      const req = JSON.parse(String(init!.body));
      let result: any;
      if (req.method === "getAccountInfo") {
        const data = Buffer.alloc(82);
        MintLayout.encode({ mintAuthorityOption: req.params[0] === bad ? 1 : 0, mintAuthority: PublicKey.default,
          freezeAuthorityOption: 0, freezeAuthority: PublicKey.default, supply: 1000000000n,
          decimals: 6, isInitialized: true }, data);
        result = { context: { slot: 1 }, value: { data: [data.toString("base64"), "base64"],
          owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 1461600, executable: false, rentEpoch: 0 } };
      } else if (req.method === "getTokenLargestAccounts") {
        result = { context: { slot: 1 }, value: [{ address: good, amount: "1000000", decimals: 6, uiAmount: 1, uiAmountString: "1" }] };
      } else {
        assert.equal(req.method, "getMultipleAccounts");
        assert.ok(req.params[0].length <= 5);
        result = { context: { slot: 1 }, value: req.params[0].map(() => null) };
      }
      return Response.json({ jsonrpc: "2.0", id: req.id, result });
    }
    if (u.hostname === "api.jup.ag") {
      assert.equal(init?.method, undefined, "no transaction POSTs");
      if (u.pathname.includes("/swap/")) {
        quoteCalls++;
        const inputMint = u.searchParams.get("inputMint")!, outputMint = u.searchParams.get("outputMint")!;
        const amount = u.searchParams.get("amount")!;
        const outAmount = inputMint === SOL ? "5500000" : "54500000";
        return Response.json({ router: "metis", inputMint, outputMint, inAmount: amount, outAmount,
          slippageBps: Number(u.searchParams.get("slippageBps")), priceImpactPct: 0.1, routePlan: [] });
      }
      if (u.pathname.endsWith("/search")) return Response.json(u.searchParams.get("query")!.split(",").map(token));
      return Response.json([token(bad), token(good)]);
    }
    assert.equal(u.hostname, "api.dexscreener.com");
    if (u.pathname.includes("token-profiles")) return Response.json([]);
    return Response.json(u.pathname.split("/").at(-1)!.split(",").map(mint => ({
      chainId: "solana", dexId: "raydium", baseToken: { address: mint, symbol: mint === bad ? "BAD" : "GOOD" },
      priceUsd: mint === SOL ? "100" : "1", liquidity: { usd: 50000 }, volume: { h24: 200000 },
      txns: { m5: { buys: 20, sells: 5 } }, priceChange: { m5: 1, h24: 5 },
      pairCreatedAt: Date.now() - 86400000,
    })));
  };
  try {
    const s = initialState();
    // Creation-stream recovery is isolated in launch-discovery tests; never
    // open a websocket from this paper-entry fixture.
    s.launchDiscovery = { ...emptyLaunchDiscovery(), lastPollAt: Date.now() };
    s.running = true; s.solPriceUsd = 100; s.cashSol = 1; s.dailyStartEquity = 0;
    s.settings.minAiScore = 92;
    await scan("synthetic-only", s, async () => { saves++; }, true);
    assert.ok(s.candidates.length > 0, "ordinary candidates are staged, not silently hidden");
    assert.ok(s.candidates.every(c => c.status !== "eligible"), "unverified LP cannot authorize entry");
    assert.equal(paidCalls, 0); assert.equal(s.aiCalls, 0); assert.ok(saves > 0);
    assert.equal(quoteCalls, 0, "ordinary tokens are excluded before routing");
    assert.equal(s.positions.length, 0);
  } finally {
    globalThis.fetch = fetchBefore; pool.query = queryBefore; openai.chat.completions.create = createBefore;
  }
});
