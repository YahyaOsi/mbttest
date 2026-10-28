import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { initialState, dailyLossLimit, normalize } from "../src/lib/sentinel/store";
import { RpcPool } from "../src/lib/sentinel/rpc-pool";
import { SOLANA_MAINNET_GENESIS } from "../src/lib/sentinel/network-policy";
import { cappedTip, appendTip, sendJitoBundle } from "../src/lib/sentinel/jito";
import { reconcilePipeline } from "../src/lib/sentinel/pipeline-state";
import { protectedTokens } from "../src/lib/sentinel/retention-policy";
import { confidence } from "../src/lib/sentinel/confidence";
import { curveProgressAllowed } from "../src/lib/sentinel/pump-sniping";
import { positionBudget } from "../src/lib/sentinel/crazy-policy";
import { snapshotExitPlan, tierAmount, moonbagDecision, markExitFill } from "../src/lib/sentinel/exit-policy";
import { volatilityStop } from "../src/lib/sentinel/volatility-risk";
import { metric, flushMetrics, metricsSaved } from "../src/lib/sentinel/telemetry";
import { applyWatchDecision } from "../src/lib/sentinel/watchlist";
import type { Candidate, Position } from "../src/lib/sentinel/types";

const endpoints = ["one", "two", "three"].map(id => ({ id, url: `https://${id}.invalid`, pinned: false }));
const request = (method: string) => ({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });
test("verified read failover uses secondary; signature/status/blockhash/simulation/broadcast never fail over", async () => {
  const calls: string[] = [];
  const pool = new RpcPool(() => endpoints, async (e, init) => {
    const method = JSON.parse(String(init.body)).method; calls.push(`${e.id}:${method}`);
    if (method === "getGenesisHash") return Response.json({ result: SOLANA_MAINNET_GENESIS });
    if (method === "getSlot") return Response.json({ result: 1000 });
    if (e.id === "three") return new Response("unavailable", { status: 429 });
    return Response.json({ result: { context: { slot: 1000 }, value: 10000000 } });
  });
  pool.setReadFailover(true);
  await pool.read(request("getBalance"), "wallet");
  assert.ok(calls.includes("three:getBalance"));
  assert.ok(calls.some(c => c === "one:getBalance" || c === "two:getBalance"));
  assert.equal(pool.availability().failoverReads, 1);
  for (const method of ["getLatestBlockhash", "getBlockHeight", "isBlockhashValid", "getSignatureStatuses", "simulateTransaction", "getTransaction"]) {
    calls.length = 0;
    await assert.rejects(pool.read(request(method), "priority"));
    assert.ok(calls.every(c => c.startsWith("three:")));
  }
  calls.length = 0;
  await assert.rejects(pool.broadcast(new Uint8Array([1]), "fixture-signature"));
  assert.ok(calls.every(c => c.startsWith("three:")));
});
test("read failover can be disabled and rejects wrong-network secondaries", async () => {
  const calls: string[] = [];
  const pool = new RpcPool(() => endpoints, async (e, init) => {
    const method = JSON.parse(String(init.body)).method; calls.push(`${e.id}:${method}`);
    if (e.id === "three") return new Response("down", { status: 429 });
    return Response.json({ result: method === "getGenesisHash" ? "wrong-network" : 5 });
  });
  await assert.rejects(pool.read(request("getBalance"), "wallet"));
  assert.ok(calls.every(c => c.startsWith("three:")));
  pool.setReadFailover(true); calls.length = 0;
  await assert.rejects(pool.read(request("getBalance"), "wallet"));
  assert.ok(!calls.some(c => /^(one|two):getBalance$/.test(c)));
});
test("atomic Jito tip respects both caps; failed bundle does not mutate signed bytes", async () => {
  const settings = initialState().settings;
  assert.equal(cappedTip(settings, 100000000n, 1000000), 100000);
  assert.equal(cappedTip({ ...settings, jitoMaxTipPct: 0.01 }, 100000000n, 1000000), 10000);
  assert.equal(cappedTip(settings, 100n, 100000), 0);
  const payer = Keypair.generate(), recipient = Keypair.generate().publicKey;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message());
  const tipped = appendTip(tx, [], payer.publicKey, recipient, 1000); tipped.sign([payer]);
  const bytes = tipped.serialize(), before = Buffer.from(bytes).toString("hex");
  await assert.rejects(sendJitoBundle(bytes, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, "sendBundle"); assert.equal(body.params[0].length, 1);
    assert.equal(body.params[0][0], Buffer.from(bytes).toString("base64"));
    return new Response("down", { status: 503 });
  }));
  assert.equal(Buffer.from(tipped.serialize()).toString("hex"), before);
  assert.throws(() => appendTip(tipped, [], payer.publicKey, recipient, 1000), /unsigned/);
  const instructions = TransactionMessage.decompile(tipped.message).instructions;
  assert.ok(instructions.at(-1)!.programId.equals(SystemProgram.programId));
});
const candidate = () => ({ mint: Keypair.generate().publicKey.toBase58(), symbol: "FIX", name: "Fixture",
  status: "watching", risks: [], reasoning: "", priceUsd: 1, liquidityUsd: 10000, volume24hUsd: 100000,
  volume5mUsd: 1500, buys5m: 40, sells5m: 5, change5mPct: 5, change24hPct: 5, ageMinutes: 1,
  observedTop10Pct: 5, curveProgressPct: 50, score: null, updatedAt: new Date().toISOString() }) as Candidate;
test("confidence widens a qualified curve to 10–60% but cannot override hard concentration/missing proof", () => {
  const settings = { ...initialState().settings, riskMode: "crazy" as const }, c = candidate();
  assert.ok(confidence(c, settings).high); assert.equal(curveProgressAllowed(c, settings, 50), true);
  assert.equal(curveProgressAllowed(c, settings, 61), false);
  assert.equal(confidence({ ...c, observedTop10Pct: 25 }, settings).high, false);
  assert.equal(confidence({ ...c, observedTop10Pct: undefined }, settings).high, false);
  assert.equal(confidence({ ...c, updatedAt: new Date(Date.now() - 60000).toISOString() }, settings).high, false);
  assert.equal(positionBudget(settings, 100, c, "sniper"), 15);
  assert.equal(positionBudget(settings, 100, c, "momentum"), 8);
});
test("registry reconciliation removes stale watching labels, expires once and preserves deadlines", () => {
  const s = initialState(), c = candidate(), at = Date.now();
  s.candidates = [c]; reconcilePipeline(s, at);
  assert.equal(c.pipelineStatus, "observed"); assert.equal(c.status, "discovered");
  s.watchlist[c.mint] = { startedAt: new Date(at - 10000).toISOString(), expiresAt: new Date(at + 10000).toISOString() };
  reconcilePipeline(s, at); assert.equal(c.pipelineStatus, "active-watch");
  const deadline = s.watchlist[c.mint].expiresAt;
  reconcilePipeline(s, at + 10000); assert.equal(c.pipelineStatus, "rejected-permanent");
  assert.equal(c.watchExpiresAt, null); assert.equal(s.watchlist[c.mint].expiresAt, deadline);
});
test("equity risk and new retention defaults never rewrite existing protected balances", () => {
  const s = initialState(); s.cashSol = 1; s.solPriceUsd = 100; s.dailyStartEquity = 100; s.settings.dailyLossLimitUsd = 100;
  assert.equal(dailyLossLimit(s), 20);
  const old = { rawInitial: "1000000", rawRemaining: "1000000" } as Position;
  assert.equal(protectedTokens(old), 10000n);
  const fresh = { rawInitial: "1000000", rawRemaining: "1000000", retentionPct: 0.1 } as Position;
  assert.equal(protectedTokens(fresh), 1000n);
  fresh.retentionPct = 0; assert.equal(protectedTokens(fresh), 1000n, "snapshotted protected raw is immutable");
  assert.equal(protectedTokens({ rawInitial: "10000", rawRemaining: "10000", retentionPct: 0 } as Position), 0n);
  s.positions = [old]; const normalized = normalize(s);
  assert.equal(normalized.positions[0].retainedRaw, "10000");
});
test("adaptive tiers use original amounts; trailing and volatility can tighten but not widen hard stops", () => {
  const p = { rawInitial: "10000", rawRemaining: "10000", entryPriceUsd: 1, highWaterPriceUsd: 4,
    highWaterPriceSol: 4, exitPlan: snapshotExitPlan(initialState().settings) } as Position;
  assert.deepEqual(moonbagDecision(p, 60, 1.6), { tier: 0 }); assert.equal(tierAmount(p, 0), 2000n);
  p.rawRemaining = "8000"; markExitFill(p);
  assert.deepEqual(moonbagDecision(p, 100, 2), { tier: 1 }); assert.equal(tierAmount(p, 1), 5000n);
  p.rawRemaining = "3000"; markExitFill(p); assert.equal(tierAmount(p, 2), 2000n);
  p.rawRemaining = "1000"; markExitFill(p); assert.match(moonbagDecision(p, 200, 3.6)?.full ?? "", /8%/);
  for (let n = 0; n < 6; n++) volatilityStop(p, 1 + n * 0.001, 20, n * 15000);
  assert.equal(volatilityStop(p, 1.006, 20, 90000), 8);
  assert.equal(volatilityStop({ ...p, exitPlan: { ...p.exitPlan!, adaptive: false } }, 0.1, 20), 20);
});
test("advisory AI REJECT leaves Crazy watch deadline intact; deterministic rejection remains permanent", () => {
  const s = initialState(), c = candidate(); s.settings.riskMode = "crazy"; s.candidates = [c];
  const at = Date.now(); s.watchlist[c.mint] = { startedAt: new Date(at).toISOString(), expiresAt: new Date(at + 900000).toISOString() };
  applyWatchDecision(s, c.mint, "REJECT", "advisory", at, "ai");
  assert.equal(c.permanentlyRejectedAt, undefined); assert.equal(s.watchlist[c.mint].rejectedAt, undefined);
  applyWatchDecision(s, c.mint, "REJECT", "hard deterministic failure", at, "deterministic");
  assert.ok(c.permanentlyRejectedAt);
});
test("journal flush is idempotent and independent of the 500-entry activity buffer", async () => {
  const s = initialState(); const writes: unknown[][] = [];
  metric(s, "fixture", null, { reason: "test" });
  const query = async (sql: string, params: any[]) => { assert.match(sql, /ON CONFLICT/); writes.push(params); };
  await flushMetrics(s, "fixture-owner", query);
  await flushMetrics(s, "fixture-owner", query);
  assert.deepEqual(writes[0], writes[1]); metricsSaved(s);
  await flushMetrics(s, "fixture-owner", query); assert.equal(writes.length, 2);
});
