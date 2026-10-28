import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { initialState, normalize } from "../src/lib/sentinel/store";
import { stageCandidate, mergeCandidates, WATCH_MS } from "../src/lib/sentinel/watchlist";
import { reserveAiSweep } from "../src/lib/sentinel/ai-sweeps";
import { discoveryMints } from "../src/lib/sentinel/discovery-policy";
import { entryBudgetAvailable } from "../src/lib/sentinel/entry-policy";
import { snapshotExitPlan, moonbagDecision, markExitFill } from "../src/lib/sentinel/exit-policy";
import type { Candidate, Position } from "../src/lib/sentinel/types";

const candidate = (mint = Keypair.generate().publicKey.toBase58()) => ({
  mint, symbol: "TEST", name: "Fixture", status: "discovered", priceUsd: 1, liquidityUsd: 9000, volume24hUsd: 70000,
  buys5m: 5, sells5m: 1, change5mPct: 3, change24hPct: 10, ageMinutes: 60, updatedAt: new Date().toISOString(),
  marketDataStatus: "market_data_available", missingMarketData: [], score: null, risks: [], reasoning: "Near threshold", discoverySource: "fixture",
}) as Candidate;

test("watch windows survive refresh/restart and expire permanently at precisely 15 minutes", () => {
  let s = initialState(), c = candidate(), at = Date.now();
  c.status = "watching";
  stageCandidate(c, s, at); assert.equal(c.status, "watching");
  const deadline = c.watchExpiresAt;
  s.candidates = [c]; s = normalize(JSON.parse(JSON.stringify(s)));
  mergeCandidates(s, [{ ...c, status: "eligible", liquidityUsd: 20000 }], at + 100000);
  assert.equal(s.candidates[0].watchExpiresAt, deadline); assert.equal(s.candidates[0].status, "eligible");
  stageCandidate(s.candidates[0], s, at + WATCH_MS);
  assert.equal(s.candidates[0].status, "rejected"); assert.ok(s.candidates[0].permanentlyRejectedAt);
  mergeCandidates(s, [{ ...c, status: "eligible", watchStartedAt: null, watchExpiresAt: null }], at + WATCH_MS + 5000);
  assert.equal(s.candidates[0].status, "rejected"); assert.equal(s.candidates[0].watchExpiresAt, null);
  assert.equal(s.watchlist[c.mint].expiresAt, deadline);
});

test("CA enrollment stages any mint, does not reset a deadline, and purchased positions leave Watching", () => {
  const s = initialState(), c = candidate(), at = Date.now();
  c.buys5m = 0; c.volume24hUsd = 0; c.liquidityUsd = 0;
  stageCandidate(c, s, at, true); assert.equal(c.status, "watching");
  stageCandidate(c, s, at + 60000, true); assert.equal(Date.parse(c.watchStartedAt!), at);
  s.positions = [{ mint: c.mint, status: "open" }] as Position[];
  stageCandidate(c, s, at + WATCH_MS + 1); assert.equal(c.watchExpiresAt, null);
  assert.notEqual(c.status, "watching"); assert.equal(c.permanentlyRejectedAt, undefined);
});

test("known discovery arrays and staging merge have no 10/120 token truncation", () => {
  const mints = Array.from({ length: 151 }, () => Keypair.generate().publicKey.toBase58());
  assert.equal(discoveryMints([mints, mints]).length, 151);
  const s = initialState(); mergeCandidates(s, mints.map(candidate)); mergeCandidates(s, [candidate()]);
  assert.equal(s.candidates.length, 152);
});

test("AI queues reserve shared paid budget durably, retain all pages, and alternate sources", () => {
  const s = initialState(), at = Date.now(); s.running = true;
  s.settings.maxAiCallsPerDay = 1440; s.settings.minLiquidityUsd = 8000;
  s.candidates = Array.from({ length: 45 }, () => ({ ...candidate(), status: "watching" as const }));
  mergeCandidates(s, s.candidates, at);
  const first = reserveAiSweep(s, at)!; assert.equal(first.kind, "watching"); assert.equal(first.batch.length, 20);
  assert.equal(s.aiSweeps!.watching.pending.length, 45, "reservation is retained until validated completion");
  assert.equal(s.aiCalls, 1);
  assert.equal(reserveAiSweep(s, at)!.kind, "general");
  s.aiCalls = 1439; assert.ok(reserveAiSweep(s, at)); assert.equal(s.aiCalls, 1440);
  assert.equal(reserveAiSweep(s, at), undefined);
});

test("AI schedules use 10/5 minutes and survive restart without resetting either clock", () => {
  let s = initialState(), at = Date.now(); s.running = true; s.candidates = [{ ...candidate(), status: "watching" }];
  s.settings.minLiquidityUsd = 8000; mergeCandidates(s, s.candidates, at);
  reserveAiSweep(s, at);
  assert.equal(s.aiSweeps!.general.nextAt, at + 600000); assert.equal(s.aiSweeps!.watching.nextAt, at + 300000);
  s.aiSweeps!.general.pending = []; s.aiSweeps!.watching.pending = [];
  s = normalize(JSON.parse(JSON.stringify(s)));
  assert.equal(reserveAiSweep(s, at + 299999), undefined);
  assert.equal(reserveAiSweep(s, at + 300000)?.kind, "watching");
  s.aiSweeps!.watching.pending = [];
  assert.equal(reserveAiSweep(s, at + 600000)?.kind, "general");
});

test("migration keeps owner run/loss settings and existing snapshots, applies 100 AI and nonzero second tier once", () => {
  const s = initialState(); delete s.pipelineVersion; s.running = true; s.settings.maxAiCallsPerDay = 12;
  s.settings.dailyLossLimitUsd = 7; s.positions = [{ exitPlan: { firstTargetPct: 60 }, status: "open" }] as Position[];
  const next = normalize(s); assert.equal(next.running, true); assert.equal(next.settings.dailyLossLimitUsd, 7);
  assert.equal(next.settings.maxAiCallsPerDay, 100); assert.equal(next.settings.takeProfitPct, 100);
  assert.equal(next.settings.secondSellPct, 20); assert.equal(next.positions[0].exitPlan!.firstTargetPct, 60);
  next.settings.maxAiCallsPerDay = 33; assert.equal(normalize(next).settings.maxAiCallsPerDay, 33);
  next.settings.maxEntriesPerDay = 1; assert.equal(entryBudgetAvailable(next), true);
});

test("legacy opt-out plan sells half at 2x then trails the remainder, with no second fixed sale", () => {
  const p = { rawInitial: "10000", rawRemaining: "10000", exitPlan: snapshotExitPlan({ ...initialState().settings, adaptiveExitsEnabled: false, secondSellPct: 0 }),
    firstTierDone: false, secondTierDone: false, highWaterPriceSol: 2 } as Position;
  assert.equal(moonbagDecision(p, 99, 2), null);
  assert.deepEqual(moonbagDecision(p, 100, 2), { tier: 1 });
  p.rawRemaining = "5000"; markExitFill(p);
  assert.equal(p.firstTierDone, true); assert.equal(p.secondTierDone, true);
  assert.equal(moonbagDecision(p, 200, 2), null);
  assert.equal(moonbagDecision(p, 70, 1.7)?.full, "Moon bag trailing stop");
});
