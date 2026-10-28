import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { pool as db } from "@workspace/db";
import { initialState } from "../src/lib/sentinel/store";
import { assess } from "../src/lib/sentinel/analysis";
import { monitor, openPosition } from "../src/lib/sentinel/engine";
import { crazyState } from "../src/lib/sentinel/crazy-policy";
import { CPMM_AUTHORITY, CPMM_PROGRAM } from "../src/lib/sentinel/curve-policy";
import { SOL } from "../src/lib/sentinel/discovery-policy";
import type { Candidate } from "../src/lib/sentinel/types";

test("none of the four strategies can authorize an ordinary AMM token or bypass launchpad identity", async () => {
  process.env.SOLANA_RPC_URL = "https://crazy-rpc.test.invalid";
  process.env.JUPITER_API_KEY = "synthetic-only";
  const originalFetch = globalThis.fetch, originalQuery = db.query;
  const mint = Keypair.generate().publicKey, pool = Keypair.generate().publicKey;
  const leader = Keypair.generate().publicKey.toBase58();
  const lp = PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), pool.toBuffer()], CPMM_PROGRAM)[0];
  const vault = (token: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), pool.toBuffer(), token.toBuffer()], CPMM_PROGRAM)[0];
  const baseVault = vault(mint), quoteVault = vault(new PublicKey(SOL)), holder = Keypair.generate().publicKey;
  const holderAccount = Keypair.generate().publicKey;
  let lpSupply = 0n, poolAgeSec = 60;
  const account = (data: Buffer, owner = TOKEN_PROGRAM_ID) => ({
    data: [data.toString("base64"), "base64"], owner: owner.toBase58(), lamports: 3000000, executable: false, rentEpoch: 0,
  });
  const mintData = (supply: bigint, authority?: PublicKey) => {
    const d = Buffer.alloc(82);
    MintLayout.encode({ mintAuthorityOption: authority ? 1 : 0, mintAuthority: authority ?? PublicKey.default, supply,
      decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, d);
    return d;
  };
  const tokenData = (token: PublicKey, owner: PublicKey, amount: bigint) => {
    const d = Buffer.alloc(165);
    AccountLayout.encode({ mint: token, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, d);
    return d;
  };
  const getAccount = (address: string): any => {
    if (address === pool.toBase58()) {
      const d = Buffer.alloc(637);
      createHash("sha256").update("account:PoolState").digest().subarray(0, 8).copy(d);
      for (const [offset, key] of [[72, baseVault], [104, quoteVault], [136, lp], [168, mint], [200, new PublicKey(SOL)]] as const) key.toBuffer().copy(d, offset);
      d.writeBigUInt64LE(1000000n, 333); d.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000) - poolAgeSec), 373);
      return account(d, CPMM_PROGRAM);
    }
    if (address === lp.toBase58()) return account(mintData(lpSupply, CPMM_AUTHORITY));
    if (address === mint.toBase58()) return account(mintData(1000000000n));
    if (address === baseVault.toBase58()) return account(tokenData(mint, CPMM_AUTHORITY, 900000000n));
    if (address === quoteVault.toBase58()) return account(tokenData(new PublicKey(SOL), CPMM_AUTHORITY, 1000000000n));
    if (address === holderAccount.toBase58()) return account(tokenData(mint, holder, 10000000n));
    return null;
  };
  (db as any).query = async (sql: string) => {
    assert.ok(sql.startsWith("SELECT halted"), "no actual DB writes in test");
    return { rows: [{ halted: false, emergency_requested: false }] };
  };
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === "crazy-rpc.test.invalid") {
      const req = JSON.parse(String(init!.body)); let result: any;
      if (req.method === "getAccountInfo") result = { context: { slot: 1 }, value: getAccount(req.params[0]) };
      else if (req.method === "getMultipleAccounts") {
        assert.ok(req.params[0].length <= 5);
        result = { context: { slot: 1 }, value: req.params[0].map(getAccount) };
      } else {
        assert.equal(req.method, "getTokenLargestAccounts");
        result = { context: { slot: 1 }, value: [{ address: baseVault.toBase58(), amount: "900000000", decimals: 6, uiAmount: 900, uiAmountString: "900" },
          { address: holderAccount.toBase58(), amount: "10000000", decimals: 6, uiAmount: 10, uiAmountString: "10" }] };
      }
      return Response.json({ jsonrpc: "2.0", id: req.id, result });
    }
    assert.equal(init?.method, undefined, "no signing, broadcasting, AI requests, or build POSTs");
    if (u.hostname === "api.dexscreener.com") return Response.json([{
      chainId: "solana", baseToken: { address: SOL }, priceUsd: "100", liquidity: { usd: 1000000 },
    }]);
    assert.equal(u.hostname, "api.jup.ag"); assert.ok(u.pathname.includes("/swap/"));
    const inputMint = u.searchParams.get("inputMint")!, outputMint = u.searchParams.get("outputMint")!;
    const amount = u.searchParams.get("amount")!, n = BigInt(amount);
    return Response.json({ router: "metis", inputMint, outputMint, inAmount: amount,
      outAmount: String(inputMint === SOL ? n / 10n : n * 10n * 995n / 1000n),
      slippageBps: Number(u.searchParams.get("slippageBps")), priceImpactPct: 0.1,
      routePlan: [{ swapInfo: { ammKey: pool.toBase58() } }] });
  };
  const make = (strategy: "sniper" | "momentum" | "dip" | "whale") => {
    const s = initialState(); s.settings = { ...s.settings, riskMode: "crazy", crazyStrategy: "all", crazyAcknowledged: true, trackFomoHandles: true };
    poolAgeSec = strategy === "sniper" ? 60 : 600;
    s.running = true; s.cashSol = 0.5; s.solPriceUsd = 100; s.dailyStartEquity = 0;
    const c = { mint: mint.toBase58(), symbol: "TEST", name: "Synthetic", priceUsd: 1,
      liquidityUsd: 20000, volume24hUsd: 200000, volume5mUsd: strategy === "dip" ? 10 : 30, ageMinutes: strategy === "sniper" ? 1 : 10, buys5m: 25, sells5m: 5, change5mPct: 2,
      change24hPct: 0, updatedAt: new Date().toISOString(), flaggedSuspicious: false, organicScore: 90,
      poolAddress: pool.toBase58(), status: "watching", risks: [], score: null, safetyChecked: false } as Candidate;
    const state = crazyState(s), at = Date.now();
    state.observations[c.mint] = strategy === "dip"
      ? [{ at: at - 240000, price: 1.4, activity: 10 }, { at: at - 180000, price: 0.93, activity: 10 }, { at: at - 120000, price: 0.94, activity: 10 }]
      : strategy === "momentum" ? [240000, 180000, 120000].map(t => ({ at: at - t, price: 1, activity: 10 })) : [];
    state.sourceAt = new Date(at).toISOString();
    state.leaders = [{ wallet: leader, handle: "fixture", rank: 1, losingCopies: 0, demoted: false, active: true }];
    state.signals = strategy === "whale" ? [{ id: "leader-buy", wallet: leader, handle: "fixture", mint: c.mint, at: at - 1000, side: "buy", priceSol: 0.01, fraction: 1 }] : [];
    return { s, c };
  };
  try {
    for (const strategy of ["sniper", "momentum", "dip", "whale"] as const) {
      const { s, c } = make(strategy);
      const a = await assess(c, s, async () => {});
      assert.equal(a.candidate.status, "rejected", `${strategy}: ordinary pool must be rejected`);
      assert.match(c.reasoning, /pool|LP/i);
      c.status = "eligible"; // Even a stale/forged eligible assessment cannot authorize it.
      await assert.rejects(() => openPosition("synthetic", s, c, a.decimals, a.staged, async () => {}, a.curve, a.copy, strategy), /Entry blocked|pool|LP/i);
      assert.equal(s.positions.length, 0); assert.equal(s.aiCalls, 0);
    }
  } finally { globalThis.fetch = originalFetch; db.query = originalQuery; }
});
