import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { MintLayout } from "@solana/spl-token";
import { pool } from "@workspace/db";
import { monitor, awaitingMigrationRoute } from "../src/lib/sentinel/engine";
import { initialState } from "../src/lib/sentinel/store";
import { snapshotExitPlan } from "../src/lib/sentinel/exit-policy";
import { SOL, USDC } from "../src/lib/sentinel/discovery-policy";
import { TOKEN_PROGRAM_ID } from "../src/lib/sentinel/token-policy";
import type { Position } from "../src/lib/sentinel/types";

test("monitor fills tiers; failed protective exits preserve owner running intent and retry the same position", async () => {
  // Isolated test-process fixtures only. Never read real secrets or make network calls.
  process.env.SOLANA_RPC_URL = "https://rpc.test.invalid";
  process.env.JUPITER_API_KEY = "synthetic-readonly-provider-key";
  const mint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  const originalFetch = globalThis.fetch, originalQuery = pool.query;
  let unitSol = 0.0003, liquidity = 100000, quotes: { amount: string; slippage: number }[] = [];
  let rpcCalls = 0, providersDown = false;
  let emergency = false;
  (pool as any).query = async (sql: string, params: any[]) => {
    if (sql.startsWith("SELECT halted")) return { rows: [{ halted: false, emergency_requested: emergency }] };
    if (sql.includes("emergency_requested=COALESCE") && params[2] !== null) emergency = params[2];
    return { rows: [] };
  };
  const data = Buffer.alloc(82);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000n,
    decimals: 0, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === "rpc.test.invalid") {
      rpcCalls++;
      const req = JSON.parse(String(init!.body));
      const result = req.method === "getAccountInfo" ? { context: { slot: 1 }, value: {
        data: [data.toString("base64"), "base64"], owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 1461600, executable: false, rentEpoch: 0 } }
        : req.method === "getMultipleAccounts" ? { context: { slot: 1 }, value: req.params[0].map(() => null) }
        : req.method === "getTokenLargestAccounts" ? { context: { slot: 1 }, value: [
          { address: mint, amount: "10000", decimals: 0, uiAmount: 10000, uiAmountString: "10000" }] } : null;
      assert.notEqual(result, null, `unexpected RPC method ${req.method}`);
      return Response.json({ jsonrpc: "2.0", id: req.id, result });
    }
    if (u.hostname === "api.jup.ag" && u.pathname.startsWith("/tokens/")) {
      return Response.json([{ id: mint, usdPrice: unitSol * 100, organicScore: 90, updatedAt: new Date().toISOString() }]);
    }
    if (u.hostname === "api.dexscreener.com") {
      const m = u.pathname.endsWith(SOL) ? SOL : mint;
      return Response.json([{ chainId: "solana", baseToken: { address: m, symbol: "TEST" }, pairAddress: mint,
        priceUsd: m === SOL ? "100" : String(unitSol * 100), liquidity: { usd: m === SOL ? 1000000 : liquidity },
        volume: { h24: 500000 }, priceChange: { m5: 0, h24: 0 }, txns: { m5: { buys: 30, sells: 20 } },
        pairCreatedAt: Date.now() - 4 * 3600000 }]);
    }
    if (u.hostname === "api.jup.ag") return new Response("primary unavailable", { status: 503 });
    assert.equal(u.hostname, "transaction-v1.raydium.io");
    assert.equal(init?.method, undefined); // absolutely no build or broadcast in this paper-only test
    quotes.push({ amount: u.searchParams.get("amount")!, slippage: Number(u.searchParams.get("slippageBps")) });
    if (providersDown) return new Response("unavailable", { status: 503 });
    const amount = u.searchParams.get("amount")!, bps = Number(u.searchParams.get("slippageBps"));
    const out = BigInt(Math.floor(Number(amount) * unitSol * 1e9));
    return Response.json({ success: true, data: { swapType: "BaseIn", inputMint: mint, outputMint: SOL,
      inputAmount: amount, outputAmount: out.toString(), otherAmountThreshold: (out * BigInt(10000 - bps) / 10000n).toString(),
      slippageBps: bps, priceImpactPct: 0, routePlan: [{ poolId: mint, inputMint: mint, outputMint: SOL }] } });
  };
  const make = () => {
    const s = initialState(); s.solPriceUsd = 100; s.cashSol = 1; s.dailyStartEquity = 0;
    s.settings.adaptiveExitsEnabled = false;
    // Existing positions keep their snapshotted legacy 8% trail.
    s.settings.trailingStopPct = 8;
    s.settings.secondSellPct = 30; // Explicit legacy two-tier position, not the new 2x/trail default.
    const p: Position = {
      id: "synthetic-only", mint, symbol: "TEST", mode: "paper", status: "open", walletAddress: null,
      entryPriceUsd: 0.01, currentPriceUsd: 0.01, originalCostSol: 0.1, remainingCostSol: 0.1,
      originalCostUsd: 10, remainingCostUsd: 10, realizedPnlSol: 0, quantity: 1000,
      realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlPct: 0, openedAt: new Date().toISOString(),
      closedAt: null, stage: 0, exitReason: null, txSignature: null, rawInitial: "1000", rawRemaining: "1000",
      decimals: 0, highWaterPriceUsd: 0.01, highWaterPriceSol: 0.0001, entryLiquidityUsd: 100000,
      lastLiquidityUsd: 100000, stagedExit: true, lastValuedAt: new Date().toISOString(),
      exitPlan: snapshotExitPlan(s.settings), firstTierDone: false, secondTierDone: false,
    };
    s.positions = [p]; return { s, p };
  };
  try {
    const { s, p } = make();
    await monitor("synthetic", s, async () => {}, false);
    assert.equal(p.rawRemaining, "500"); assert.equal(p.firstTierDone, true); assert.equal(p.secondTierDone, false);
    unitSol = 0.0005;
    await monitor("synthetic", s, async () => {}, false);
    assert.equal(p.rawRemaining, "200"); assert.equal(p.secondTierDone, true);
    assert.equal(quotes.at(-1)?.amount, "300");
    // Even beyond max-hold time, the moon bag is governed by its trailing/risk exits.
    p.openedAt = new Date(Date.now() - 10 * 3600000).toISOString();
    unitSol = 0.00049;
    await monitor("synthetic", s, async () => {}, false);
    assert.equal(p.status, "open"); assert.equal(p.rawRemaining, "200");
    unitSol = 0.00045;
    await monitor("synthetic", s, async () => {}, false);
    assert.equal(p.status, "retained"); assert.match(p.exitReason!, /Moon bag trailing stop/);
    assert.equal(p.rawRemaining, "10"); assert.equal(quotes.at(-1)?.amount, "190");
    const urgent = make(); liquidity = 70000; quotes = []; rpcCalls = 0;
    await monitor("synthetic", urgent.s, async () => {}, false);
    assert.equal(urgent.p.status, "retained");
    assert.equal(quotes.length, 1); assert.equal(quotes[0].amount, "990");
    assert.equal(quotes[0].slippage, 300); assert.equal(rpcCalls, 0);
    assert.match(urgent.p.exitReason!, /not a single-block claim/);
    const failed = make(); providersDown = true;
    failed.s.running = true;
    await monitor("synthetic", failed.s, async () => {}, false);
    assert.equal(failed.p.status, "open"); assert.equal(failed.s.running, true);
    assert.ok(failed.p.exitRetryReason, "failed rescue is persisted per position, not forgotten");
    assert.equal(emergency, false, "provider errors must not change owner control flags");
    assert.equal(failed.s.pending, null);
    providersDown = false;
    await monitor("synthetic", failed.s, async () => {}, false);
    assert.equal(failed.p.status, "retained", "same protective exit succeeds when routes recover, preserving 1%");
    assert.equal(failed.s.running, true, "no manual restart was necessary");
  } finally { globalThis.fetch = originalFetch; pool.query = originalQuery; }
});

test("missing sell routes are tolerated only within 30 minutes of verified curve completion", () => {
  const t = Date.parse("2026-10-26T12:00:00Z");
  assert.equal(awaitingMigrationRoute({} as Position, t), false);
  assert.equal(awaitingMigrationRoute({ curveMigratedAt: new Date(t - 29 * 60000).toISOString() } as Position, t), true);
  assert.equal(awaitingMigrationRoute({ curveMigratedAt: new Date(t - 31 * 60000).toISOString() } as Position, t), false);
});
