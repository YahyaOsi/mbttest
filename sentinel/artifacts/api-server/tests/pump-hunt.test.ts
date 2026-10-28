import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { initialState } from "../src/lib/sentinel/store";
import { pumpHuntPreset, holderCeiling, huntSettingsProblem } from "../src/lib/sentinel/pump-hunt-policy";
import { crazyMarketFilters, positionBudget, positionLimit } from "../src/lib/sentinel/crazy-policy";
import { confidence } from "../src/lib/sentinel/confidence";
import { curveProgressAllowed } from "../src/lib/sentinel/pump-sniping";
import { assessCrazy } from "../src/lib/sentinel/crazy-assessment";
import { evaluateBudgetWatches } from "../src/lib/sentinel/watch-budget";
import { selectLiveTradeTargets } from "../src/lib/sentinel/pump-live-feed";
import { snapshotExitPlan, tierAmount, markExitFill, moonbagDecision } from "../src/lib/sentinel/exit-policy";
import { decisionMetric, flushMetrics } from "../src/lib/sentinel/telemetry";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { PUMP_PROGRAM } from "../src/lib/sentinel/curve-policy";
import type { Candidate, Position } from "../src/lib/sentinel/types";

const state = () => {
  const s = initialState();
  s.settings = { ...s.settings, ...pumpHuntPreset, crazyAcknowledged: true };
  return s;
};
const candidate = (): Candidate => ({
  mint: Keypair.generate().publicKey.toBase58(), symbol: "HUNT", name: "Offline fixture",
  status: "watching", risks: [], reasoning: "", priceUsd: 0.001, liquidityUsd: 600,
  volume24hUsd: 200, volume5mUsd: 0, buys5m: 1, sells5m: 0, change5mPct: 0,
  change24hPct: 0, ageMinutes: 2, score: null, observedTop10Pct: 10,
  launchpad: "Pump.fun", curveProgressPct: 20,
  launchpadVerification: { program: PUMP_PROGRAM.toBase58(), pool: Keypair.generate().publicKey.toBase58(),
    verifiedAt: new Date().toISOString(), phase: "active" },
  updatedAt: new Date().toISOString(),
});
test("explicit hunt preset is API-valid and never exceeds owner equity limits", () => {
  const s = state();
  assert.ok(UpdateSettingsBody.safeParse(s.settings).success);
  assert.equal(huntSettingsProblem(s.settings), null);
  assert.match(huntSettingsProblem({ ...s.settings, snipeEquityPct: 13 })!, /snipe/);
  assert.match(huntSettingsProblem({ ...s.settings, normalEquityPct: 9 })!, /normal/);
  assert.equal(positionLimit({ ...s.settings, crazyMaxPositions: 5 }), 4);
  assert.equal(holderCeiling(s.settings), 40);
});
test("one observed buy can pass hunt market filters; ordinary Crazy policy stays strict", () => {
  const c = candidate(), s = state();
  assert.deepEqual(crazyMarketFilters(c, s.settings), []);
  assert.ok(confidence(c, s.settings).score >= 40);
  assert.ok(crazyMarketFilters(c, { ...s.settings, pumpHuntEnabled: false }).length > 0);
});
test("400–600 liquidity requires strong observed activity; below 400 always fails", () => {
  const c = { ...candidate(), liquidityUsd: 450, buys5m: 3, sells5m: 1, volume5mUsd: 250 };
  assert.deepEqual(crazyMarketFilters(c, state().settings), []);
  assert.ok(crazyMarketFilters({ ...c, liquidityUsd: 399.99 }, state().settings).some(r => /Liquidity/.test(r)));
  assert.ok(crazyMarketFilters({ ...c, buys5m: 1 }, state().settings).some(r => /Liquidity/.test(r)));
  assert.ok(crazyMarketFilters(c, { ...state().settings, crazyMinLiquidityUsd: 1500 }).some(r => /Liquidity/.test(r)), "stricter saved floors are never discounted");
});
test("0–95 curve window requires an actual buy and buy bias, not just volume", () => {
  const c = candidate(), settings = state().settings;
  for (const progress of [0, 2.45, 15, 60, 95]) assert.ok(curveProgressAllowed(c, settings, progress));
  assert.equal(curveProgressAllowed(c, settings, 95.01), false);
  assert.equal(curveProgressAllowed({ ...c, buys5m: 0 }, settings, 20), false);
  assert.equal(curveProgressAllowed({ ...c, sells5m: 2 }, settings, 20), false);
});
test("market freshness is 60 seconds, not an unlimited stale-data override", () => {
  const c = candidate(), settings = state().settings;
  assert.deepEqual(crazyMarketFilters({ ...c, updatedAt: new Date(Date.now() - 59000).toISOString() }, settings), []);
  assert.ok(crazyMarketFilters({ ...c, updatedAt: new Date(Date.now() - 61000).toISOString() }, settings).some(r => /stale/.test(r)));
});
test("scoring penalizes concentration above 30 and reserves 12% only for top early snipes", () => {
  const settings = state().settings, c = candidate();
  assert.ok(confidence({ ...c, observedTop10Pct: 35 }, settings).score < confidence(c, settings).score);
  assert.equal(positionBudget(settings, 18, c, "sniper"), 1.08);
  const strong = { ...c, liquidityUsd: 3000, buys5m: 20, sells5m: 3, volume5mUsd: 1000, observedTop10Pct: 5 };
  assert.ok(confidence(strong, settings).high);
  assert.equal(positionBudget(settings, 18, strong, "sniper"), 2.16);
  assert.equal(positionBudget({ ...settings, snipeEquityPct: 13 }, 18, strong, "sniper"), 0);
});
test("qualifying hunt reaches eligible only after proof; safety failure still rejects", async () => {
  const s = state(), c = candidate();
  const proof = async () => ({ openTime: Date.now() / 1000 - 120, decimals: 6,
    top10Pct: 10, holderAccountsObserved: 20, holderCoveragePct: 40, curve: undefined }) as any;
  const result = await assessCrazy(c, s, proof);
  assert.equal(result.candidate.status, "eligible");
  assert.equal(result.strategy, "sniper");
  const bad = candidate();
  await assessCrazy(bad, s, async () => { throw new Error("Creator holds over 10% of total supply."); });
  assert.equal(bad.status, "rejected");
  assert.match(bad.reasoning, /Creator/);
  const malformed = { ...candidate(), volume5mUsd: NaN };
  await assessCrazy(malformed, s, proof);
  assert.equal(malformed.status, "rejected", "non-finite confidence must never authorize entry");
});
test("budget exhaustion can nominate hunt BUY without AI; missing activity retains deadline", () => {
  const s = state(); s.running = true; s.aiCalls = s.settings.maxAiCallsPerDay;
  const c = candidate(); s.candidates = [c];
  s.watchlist = { [c.mint]: { startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() } };
  evaluateBudgetWatches(s);
  assert.equal(s.watchlist[c.mint].aiDecision, "BUY");
  const unknown = { ...candidate(), buys5m: 0, missingMarketData: ["activity" as const] };
  s.candidates = [unknown];
  const deadline = new Date(Date.now() + 600000).toISOString();
  s.watchlist[unknown.mint] = { startedAt: new Date().toISOString(), expiresAt: deadline };
  evaluateBudgetWatches(s);
  assert.equal(s.watchlist[unknown.mint].rejectedAt, undefined);
  assert.equal(s.watchlist[unknown.mint].expiresAt, deadline);
});
test("free feed rotates targets while keeping newest and high-velocity mints", () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ mint: `fixture-${i}`, observedAt: i, buys: i < 2 ? 20 - i : 0 }));
  const first = selectLiveTradeTargets(rows, 0), next = selectLiveTradeTargets(rows, 10000);
  assert.equal(new Set(first).size, 5);
  for (const mint of ["fixture-14", "fixture-0", "fixture-1"]) assert.ok(first.includes(mint));
  assert.notDeepEqual(first, next);
});
test("hunt exit snapshot sells original 45/30 percentages and trails after first tier", () => {
  const settings = state().settings;
  const p = { exitPlan: snapshotExitPlan(settings), rawInitial: "1000", rawRemaining: "1000",
    entryPriceUsd: 1, highWaterPriceUsd: 2, highWaterPriceSol: 2 } as Position;
  assert.equal(tierAmount(p, 0), 450n);
  p.rawRemaining = "550"; markExitFill(p);
  assert.equal(p.earlyTierDone, true);
  assert.equal(tierAmount(p, 1), 300n);
  assert.match(moonbagDecision(p, 40, 1.6)?.full ?? "", /trailing/);
  assert.equal(snapshotExitPlan({ ...settings, pumpHuntEnabled: false })?.trailAfterEarly, undefined);
});
test("candidate screening journal carries hunt policy, observed buys and exact reason", async () => {
  const s = state(), c = candidate();
  decisionMetric(s, c, "screening-started", "Fresh safety required");
  let rows: any[] = [];
  await flushMetrics(s, "offline-fixture", async (_sql, args) => { rows = JSON.parse(args[1]); });
  assert.equal(rows[0].data.policy, "pump-hunt");
  assert.equal(rows[0].data.buys5m, 1);
  assert.equal(rows[0].data.reason, "Fresh safety required");
});
