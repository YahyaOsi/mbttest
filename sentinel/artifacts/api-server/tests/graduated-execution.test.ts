import test from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { pool } from "@workspace/db";
import { graduatedFixture } from "./helpers/graduated-fixtures";
import { token } from "./helpers/launchpad-fixtures";
import { quote } from "../src/lib/sentinel/routes";
import { executeLive } from "../src/lib/sentinel/execution";
import { rpcPool } from "../src/lib/sentinel/rpc-pool";
import { initialState } from "../src/lib/sentinel/store";
import { pumpMarket } from "../src/lib/sentinel/pump-market";
import { verifyLaunchCandidate } from "../src/lib/sentinel/launchpad-entry";
import { PUMP_AMM_PROGRAM } from "../src/lib/sentinel/curve-policy";
import { SOL } from "../src/lib/sentinel/discovery-policy";
import { anchorTag } from "../src/lib/sentinel/launchpad-policy";
import { tokenAddress } from "../src/lib/sentinel/token-policy";
import type { Position } from "../src/lib/sentinel/types";

test("graduated Jupiter build uses final provenance/encoded/CPI/native checks before signing; failures never submit or fall back", async () => {
  const env = { ...process.env }, originalFetch = globalThis.fetch, originalQuery = pool.query;
  const originalBroadcast = rpcPool.broadcast;
  rpcPool.broadcast = async bytes => Connection.prototype.sendRawTransaction(bytes);
  Object.assign(process.env, { SOLANA_RPC_URL: "https://fixture.invalid", JUPITER_API_KEY: "fixture",
    SENTINEL_OWNER_USER_ID: "fixture", SENTINEL_APP_PASSWORD: "long-fixture-password", SESSION_SECRET: "fixture-session-secret-long-enough",
    AI_INTEGRATIONS_OPENAI_BASE_URL: "https://fixture.invalid", ENABLE_MAINNET_TRADING: "true",
    SENTINEL_ALWAYS_ON_CONFIRMED: "true", SENTINEL_READ_ONLY: "false" });
  const f = graduatedFixture(), mint = f.mint.toBase58(), owner = f.user.toBase58();
  process.env.SOLANA_TRADING_PRIVATE_KEY = JSON.stringify([...f.keypair.secretKey]);
  const methods = ["getAccountInfo", "getMultipleAccountsInfo", "getLatestBlockhash", "getFeeForMessage", "simulateTransaction", "sendRawTransaction", "getSignatureStatuses", "getProgramAccounts"] as const;
  const originals = methods.map(n => Connection.prototype[n]);
  const ata = tokenAddress(f.user, f.mint), now = new Date().toISOString();
  let failure = "", sends = 0, saved = false, q: any;
  (pool as any).query = async () => ({ rows: [{ halted: false, emergency_requested: false }] });
  Connection.prototype.getAccountInfo = f.connection.getAccountInfo.bind(f.connection);
  Connection.prototype.getLatestBlockhash = async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1000 });
  Connection.prototype.getMultipleAccountsInfo = f.connection.getMultipleAccountsInfo.bind(f.connection);
  Connection.prototype.getFeeForMessage = async () => ({ context: { slot: 123 }, value: 5000 });
  Connection.prototype.getSignatureStatuses = async () => ({ context: { slot: 123 }, value: [null] });
  Connection.prototype.getProgramAccounts = (async () => []) as any;
  Connection.prototype.simulateTransaction = (async (tx: VersionedTransaction, options: any) => {
    assert.equal(options.innerInstructions, true);
    const addresses: string[] = options.accounts.addresses;
    const post = addresses.map(address => {
      const a = f.accounts.get(address);
      return a ? { ...a, data: [a.data.toString("base64"), "base64"], owner: a.owner.toBase58() } : null;
    });
    const ti = addresses.indexOf(ata.toBase58());
    const received = token(f.mint, f.user, failure === "minimum" ? 1n : BigInt(q.outAmount), failure === "delegate" ? f.user : PublicKey.default);
    post[ti] = { ...received, owner: received.owner.toBase58(), data: [received.data.toString("base64"), "base64"] };
    post[0]!.lamports -= Number(q.inAmount) + 2039280 + 5000;
    const keys = tx.message.getAccountKeys();
    const index = (key: PublicKey) => keys.staticAccountKeys.findIndex(k => k.equals(key));
    const accounts = Array(9).fill(index(f.user));
    accounts[0] = index(f.migratedPool); accounts[7] = index(f.migratedBase); accounts[8] = index(f.migratedQuote);
    if (failure === "cpi") accounts[0] = index(f.user);
    if (failure === "provenance") f.setLp(1n);
    return { context: { slot: 123 }, value: {
      err: failure === "simulation" ? { InstructionError: [0, "Custom"] } : null,
      logs: [], accounts: post, unitsConsumed: 100000,
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: index(PUMP_AMM_PROGRAM), accounts,
        data: bs58.encode(Buffer.concat([anchorTag("buy"), Buffer.alloc(17)])) }] }],
    } };
  }) as any;
  Connection.prototype.sendRawTransaction = async (bytes: Uint8Array | number[] | Buffer) => {
    assert.equal(saved, true, "signed intent must be saved before a mocked submission");
    sends++;
    const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes));
    assert.ok(tx.signatures[0].some(v => v !== 0));
    return bs58.encode(tx.signatures[0]);
  };
  let aggregatorBuys = 0;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    assert.equal(u.hostname, "api.jup.ag", "No live RPC, provider fallback, funded trade or other network access allowed");
    if (u.pathname.endsWith("/execute")) {
      assert.equal(saved, true);
      const tx = VersionedTransaction.deserialize(Buffer.from(JSON.parse(String(init!.body)).signedTransaction, "base64"));
      assert.ok(tx.signatures[0].some(v => v !== 0));
      sends++;
      return Response.json({ status: "Success" });
    }
    assert.ok(u.pathname.endsWith("/order"));
    if (u.searchParams.get("inputMint") === mint) return Response.json({
      router: "metis", inputMint: mint, outputMint: SOL, inAmount: u.searchParams.get("amount"),
      outAmount: "1000000", priceImpactPct: 0, slippageBps: 100, routePlan: [],
    });
    aggregatorBuys++;
    const provider = f.quote(u.searchParams.get("amount")!);
    const tx = f.build(provider);
    if (failure === "encoded") tx.message.compiledInstructions[0].data[12] = 7; // ordinary Raydium enum
    return Response.json({ ...provider, transaction: Buffer.from(tx.serialize()).toString("base64") });
  };
  const make = () => {
    const s = initialState(); s.running = true; s.solPriceUsd = 100; s.walletBinding = owner;
    s.settings = { ...s.settings, mode: "live", acknowledgeRisk: true, launchpadCurvesEnabled: true, positionSizeUsd: 1 };
    const p = { id: "fixture", mint, symbol: "FIX", mode: "live", status: "open", walletAddress: owner,
      rawInitial: "0", rawRemaining: "0", quantity: 0, decimals: 6, openedAt: now, originalCostSol: 0, originalCostUsd: 0,
      remainingCostSol: 0, remainingCostUsd: 0, realizedPnlSol: 0, realizedPnlUsd: 0 } as Position;
    s.positions = [p]; return { s, p };
  };
  try {
    // Real market/candidate path: completed curve is visible, progress is absent,
    // and pool reserves replace the now-empty native curve reserves.
    const c = await pumpMarket(mint, 100, undefined, { id: mint, usdPrice: 1, updatedAt: now, liquidity: 50000,
      stats24h: { buyVolume: 100000, sellVolume: 100000 }, stats5m: { numBuys: 20, numSells: 1, priceChange: 1 },
      firstPool: { createdAt: new Date(Date.now() - 3600000).toISOString() } });
    assert.equal(c.launchpadVerification?.phase, "graduated"); assert.equal(c.curveProgressPct, undefined);
    assert.equal(c.poolAddress, f.migratedPool.toBase58()); assert.equal(c.liquidityUsd, 10000);
    await verifyLaunchCandidate(c, true);
    for (failure of ["simulation", "cpi", "minimum", "delegate", "encoded", "provenance"]) {
      f.setLp(); const { s, p } = make(); saved = false;
      q = await quote(SOL, mint, "1000000", 100, owner);
      await assert.rejects(() => executeLive("fixture", s, p, q, "buy", 1, failure, async () => { saved = true; }));
      assert.equal(sends, 0); assert.equal(saved, false); assert.equal(s.pending, null);
    }
    assert.equal(aggregatorBuys, 6, "a failed validation cannot acquire another buy route");
    f.setLp(); failure = ""; const { s, p } = make();
    q = await quote(SOL, mint, "1000000", 100, owner);
    await executeLive("fixture", s, p, q, "buy", 1, "fixture", async () => { saved = !!s.pending?.signature; });
    assert.equal(sends, 1); assert.ok(s.pending?.signature);
    assert.equal(s.pending?.quotedOutput, q.outAmount);
    // A later removable-LP observation blocks new buys, not rescue sells.
    f.setLp(1n);
    const rejected = await pumpMarket(mint, 100);
    assert.equal(rejected.launchpadVerification?.phase, "graduated");
    assert.match(rejected.reasoning, /removable/);
    await assert.rejects(() => verifyLaunchCandidate(rejected, true), /removable/);
    const rescue = await quote(mint, SOL, "1000000000", 100);
    assert.equal(rescue.router, "metis"); assert.equal(sends, 1, "quote-only protective route never submits");
  } finally {
    rpcPool.broadcast = originalBroadcast;
    methods.forEach((name, i) => { (Connection.prototype as any)[name] = originals[i]; });
    globalThis.fetch = originalFetch; pool.query = originalQuery;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
