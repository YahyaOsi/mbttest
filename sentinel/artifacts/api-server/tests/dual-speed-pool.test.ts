import test from "node:test";
import assert from "node:assert/strict";
import { RpcPool } from "../src/lib/sentinel/rpc-pool";
import { SOLANA_MAINNET_GENESIS } from "../src/lib/sentinel/network-policy";
import { applyWatchDecision, stageCandidate, mergeCandidates } from "../src/lib/sentinel/watchlist";
import { validateSweepItems } from "../src/lib/sentinel/ai-sweeps";
import { initialState, normalize } from "../src/lib/sentinel/store";
import type { Candidate } from "../src/lib/sentinel/types";

const endpoints = Array.from({ length: 6 }, (_, i) => ({ id: `RPC ${i + 1}`, url: `https://node${i}.invalid`, pinned: false }));
test("RPC read failover rotates secondary nodes, verifies mainnet and keeps credentials out of status", async () => {
  const calls: string[] = [];
  const pool = new RpcPool(() => endpoints, async (e, init) => {
    const req = JSON.parse(String(init.body)); calls.push(`${e.id}:${req.method}`);
    if (e.id === "RPC 1") return new Response("quota", { status: 429 });
    return Response.json({ result: req.method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS : 100 });
  });
  const r = await pool.read({ body: JSON.stringify({ method: "getSlot" }) }, "background");
  assert.equal((await r.json() as any).result, 100);
  assert.ok(calls.some(c => c === "RPC 2:getSlot")); assert.ok(!calls.some(c => c.startsWith("RPC 3:")));
  assert.equal(pool.status()[0].healthy, false);
  assert.ok(!JSON.stringify(pool.status()).includes("https"));
});
test("broadcast uses only dedicated endpoint three and accepts only the expected signature", async () => {
  const sent: string[] = [];
  const pool = new RpcPool(() => endpoints, async (_e, init) => {
    assert.equal(_e.id, "RPC 3");
    const req = JSON.parse(String(init.body));
    if (req.method === "getGenesisHash") return Response.json({ result: SOLANA_MAINNET_GENESIS });
    sent.push(req.params[0]); assert.equal(req.params[1].maxRetries, 0);
    return Response.json({ result: "fixture-signature" });
  });
  assert.equal(await pool.broadcast(new Uint8Array([1, 2, 3]), "fixture-signature"), "fixture-signature");
  assert.equal(sent.length, 1); assert.equal(new Set(sent).size, 1);
  assert.equal(sent[0], "AQID");
});
test("wrong-cluster providers are never used for query or broadcast", async () => {
  let sends = 0;
  const pool = new RpcPool(() => endpoints, async (_e, init) => {
    const req = JSON.parse(String(init.body));
    if (req.method !== "getGenesisHash") sends++;
    return Response.json({ result: "devnet" });
  });
  await assert.rejects(pool.read({ body: JSON.stringify({ method: "getBalance" }) }));
  await assert.rejects(pool.broadcast(new Uint8Array([1]), "sig"));
  assert.equal(sends, 0);
});
test("watchlist REJECT is immediate and survives refresh/restart; invalid binary output never authorizes", () => {
  let s = initialState();
  const c = { mint: "fixture", status: "watching", risks: [], buys5m: 10, priceUsd: 1, liquidityUsd: 50000 } as unknown as Candidate;
  s.candidates = [c]; stageCandidate(c, s, Date.now(), true);
  assert.equal(applyWatchDecision(s, c.mint, "REJECT", "Weakening momentum"), true);
  s = normalize(JSON.parse(JSON.stringify(s)));
  mergeCandidates(s, [{ ...c, status: "eligible", permanentlyRejectedAt: null }]);
  assert.equal(s.candidates[0].status, "rejected");
  assert.equal(applyWatchDecision(s, c.mint, "BUY", "later"), false);
  assert.throws(() => validateSweepItems({ items: [{ mint: "fixture", score: 90, reasoning: "ok", decision: "HOLD" }] }, ["fixture"], "watching"));
  assert.throws(() => validateSweepItems({ items: [{ mint: "other", score: 90, reasoning: "ok", decision: "BUY" }] }, ["fixture"], "watching"));
});
test("AI BUY cannot resurrect expired or already-held watches", () => {
  const s = initialState(), at = Date.now();
  const c = { mint: "fixture", status: "watching", risks: [], buys5m: 10 } as unknown as Candidate;
  s.candidates = [c]; stageCandidate(c, s, at, true);
  assert.equal(applyWatchDecision(s, c.mint, "BUY", "ok", at + 900000), false);
  s.positions = [{ mint: c.mint, status: "open" }] as any;
  assert.equal(applyWatchDecision(s, c.mint, "REJECT", "no longer applies", at), false);
});
test("automatic staging requires minor near-threshold failures, not discovery or authority hazards", () => {
  const s = initialState(); s.settings.minLiquidityUsd = 10000; s.settings.minVolumeUsd = 100000;
  const c = { mint: "fixture", status: "discovered", priceUsd: 1, liquidityUsd: 9000,
    volume24hUsd: 60000, buys5m: 5, risks: [] } as unknown as Candidate;
  stageCandidate(c, s); assert.equal(s.watchlist?.[c.mint], undefined);
  c.status = "rejected"; c.risks = ["Mint authority is active"];
  stageCandidate(c, s); assert.equal(s.watchlist?.[c.mint], undefined);
  c.risks = ["Liquidity below limit", "24h volume below limit"];
  stageCandidate(c, s); assert.equal(c.status, "watching"); assert.ok(s.watchlist?.[c.mint]);
});
test("provider outages open a cooldown and recover without changing owner run state", async () => {
  let at = 10000, down = true, calls = 0;
  const pool = new RpcPool(() => endpoints.slice(0, 1), async () => {
    calls++; if (down) throw new Error("secret-bearing transport error must not escape");
    return Response.json({ result: 42 });
  }, () => at);
  await assert.rejects(pool.read({}, "wallet"), /Primary RPC/);
  await assert.rejects(pool.read({}, "wallet")); assert.equal(calls, 1);
  at += 2100; down = false;
  await pool.read({}, "wallet"); assert.equal(pool.status()[0].healthy, true);
});
