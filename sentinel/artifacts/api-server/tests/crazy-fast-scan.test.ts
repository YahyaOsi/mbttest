import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { pool } from "@workspace/db";
import { initialState } from "../src/lib/sentinel/store";
import { scan } from "../src/lib/sentinel/engine";
import { emptyLaunchDiscovery } from "../src/lib/sentinel/launch-discovery";
import { SOL } from "../src/lib/sentinel/discovery-policy";

test("Crazy discovery excludes indexed ordinary-pool tokens before screening or entry", async () => {
  process.env.SOLANA_RPC_URL = "https://fast-scan.test.invalid";
  process.env.JUPITER_API_KEY = "synthetic";
  const originalFetch = globalThis.fetch, originalQuery = pool.query;
  const mints = Array.from({ length: 3 }, () => Keypair.generate().publicKey);
  const holders = mints.map(() => Keypair.generate().publicKey);
  const owner = Keypair.generate().publicKey;
  let activeReads = 0, peakReads = 0, holderReads = 0;
  const tokens = mints.map((mint, i) => ({
    id: mint.toBase58(), symbol: `FIX${i}`, name: "Synthetic",
    usdPrice: 1, liquidity: 2500, organicScore: 0, stats24h: { buyVolume: 0, sellVolume: 0 },
    stats5m: { numBuys: 20, numSells: 5, priceChange: 3 },
    updatedAt: new Date().toISOString(), firstPool: { createdAt: new Date(Date.now() - 60000).toISOString() },
  }));
  const account = (data: Buffer) => ({ data: [data.toString("base64"), "base64"],
    owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, lamports: 3000000, rentEpoch: 0 });
  const getAccount = (address: string) => {
    let i = mints.findIndex(m => m.toBase58() === address);
    if (i >= 0) {
      const data = Buffer.alloc(82);
      MintLayout.encode({ mintAuthorityOption: i === 0 ? 1 : 0, mintAuthority: owner, supply: 1000000000n,
        decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
      return account(data);
    }
    i = holders.findIndex(h => h.toBase58() === address);
    if (i < 0) return null;
    const data = Buffer.alloc(165);
    AccountLayout.encode({ mint: mints[i], owner, amount: 1000000n, delegateOption: 0,
      delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
      closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    return account(data);
  };
  (pool as any).query = async (sql: string) => {
    assert.ok(sql.startsWith("SELECT halted"), "no actual database writes");
    return { rows: [{ halted: false, emergency_requested: false }] };
  };
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === "fast-scan.test.invalid") {
      activeReads++; peakReads = Math.max(peakReads, activeReads);
      await new Promise(r => setTimeout(r, 2));
      const req = JSON.parse(String(init!.body)); let result: any;
      try {
        if (req.method === "getAccountInfo") result = { context: { slot: 1 }, value: getAccount(req.params[0]) };
        else if (req.method === "getTokenLargestAccounts") {
          holderReads++;
          const i = mints.findIndex(m => m.toBase58() === req.params[0]);
          result = { context: { slot: 1 }, value: [{ address: holders[i].toBase58(), amount: "1000000", decimals: 6, uiAmount: 1, uiAmountString: "1" }] };
        } else {
          assert.equal(req.method, "getMultipleAccounts");
          assert.ok(req.params[0].length <= 5);
          result = { context: { slot: 1 }, value: req.params[0].map(getAccount) };
        }
        return Response.json({ jsonrpc: "2.0", id: req.id, result });
      } finally { activeReads--; }
    }
    assert.equal(init?.method, undefined, "no transaction, build, AI or broadcast POSTs");
    if (u.hostname === "api.jup.ag") {
      if (u.pathname.includes("/swap/")) {
        const inputMint = u.searchParams.get("inputMint")!, outputMint = u.searchParams.get("outputMint")!;
        const amount = u.searchParams.get("amount")!, n = BigInt(amount);
        return Response.json({ router: "metis", inputMint, outputMint, inAmount: amount,
          outAmount: String(inputMint === SOL ? n / 10n : n * 10n * 995n / 1000n),
          slippageBps: Number(u.searchParams.get("slippageBps")), priceImpactPct: 0.1, routePlan: [] });
      }
      return Response.json(u.pathname.endsWith("/search")
        ? tokens.filter(t => u.searchParams.get("query")!.split(",").includes(t.id)) : tokens);
    }
    assert.equal(u.hostname, "api.dexscreener.com");
    if (u.pathname.includes("token-profiles")) return Response.json([]);
    return Response.json(u.pathname.split("/").at(-1)!.split(",").map(address => ({
      chainId: "solana", dexId: "raydium", baseToken: { address, symbol: "FIX" },
      priceUsd: address === SOL ? "100" : "1", liquidity: { usd: address === SOL ? 1000000 : 2500 },
      volume: { h24: 0, m5: 600 }, txns: { m5: { buys: 20, sells: 5 } },
      priceChange: { m5: 3, h24: 3 }, pairCreatedAt: Date.now() - 60000,
    })));
  };
  try {
    const s = initialState();
    s.settings = { ...s.settings, riskMode: "crazy", crazyAcknowledged: true, maxEntriesPerDay: 1, maxPositions: 1 };
    s.launchDiscovery = { ...emptyLaunchDiscovery(), lastPollAt: Date.now() };
    s.running = true; s.cashSol = 1; s.solPriceUsd = 100; s.dailyStartEquity = 0;
    await scan("fixture", s, async () => {}, true);
    assert.equal(s.positions.length, 0, "ordinary indexed tokens do not enter the approved scanner");
    assert.ok(s.candidates.length > 0, "ordinary indexed tokens are visible for LP verification and staging");
    assert.ok(s.candidates.every(c => c.status !== "eligible"), "invalid ordinary pools never authorize entry");
    assert.equal(s.aiCalls, 0);
    assert.ok(s.activity.find(a => a.category === "entry-summary")!.message.includes("opened/pending 0"));
  } finally { globalThis.fetch = originalFetch; pool.query = originalQuery; }
});
