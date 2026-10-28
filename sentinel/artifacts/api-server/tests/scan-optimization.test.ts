import test from "node:test";
import assert from "node:assert/strict";
import { initialState, normalize } from "../src/lib/sentinel/store";
import { evaluateBudgetWatches } from "../src/lib/sentinel/watch-budget";
import { applyWatchDecision, stageCandidate } from "../src/lib/sentinel/watchlist";
import { targetLeaders } from "../src/lib/sentinel/copy-targets";
import { latestCopy } from "../src/lib/sentinel/crazy-assessment";
import { crazyState, scanMinutes } from "../src/lib/sentinel/crazy-policy";
import { pollFomo } from "../src/lib/sentinel/fomo";
import { ScannerIndex } from "../../solana-sentinel/src/lib/scanner-index";
import type { Candidate } from "../src/lib/sentinel/types";

function fixture() {
  const s = initialState();
  s.running = true; s.settings.maxAiCallsPerDay = 1; s.aiCalls = 1;
  s.candidates = [{
    mint: "So11111111111111111111111111111111111111112", symbol: "TEST", name: "Fixture",
    priceUsd: 1, liquidityUsd: 50000, volume24hUsd: 200000, ageMinutes: 150,
    buys5m: 20, sells5m: 5, change5mPct: 3, change24hPct: 4,
    updatedAt: new Date().toISOString(), status: "watching", risks: [], score: null,
    missingMarketData: [], marketDataStatus: "market_data_available",
  } as Candidate];
  stageCandidate(s.candidates[0], s);
  return s;
}
test("exhausted AI budget deterministically requests BUY without granting chain clearance or spending AI", () => {
  for (const riskMode of ["conservative", "crazy"] as const) {
    const s = fixture(); s.settings.riskMode = riskMode; s.settings.crazyAcknowledged = true;
    const mint = s.candidates[0].mint, expiry = s.watchlist![mint].expiresAt;
    assert.equal(evaluateBudgetWatches(s).size, 1);
    assert.equal(s.watchlist![mint].aiDecision, "BUY");
    assert.equal(s.watchlist![mint].decisionSource, "deterministic");
    assert.equal(s.watchlist![mint].expiresAt, expiry);
    assert.equal(s.candidates[0].safetyChecked, undefined);
    assert.equal(s.positions.length, 0); assert.equal(s.aiCalls, 1);
    assert.equal(applyWatchDecision(s, mint, "REJECT", "late in-flight AI result"), false);
    assert.equal(s.watchlist![mint].aiDecision, "BUY");
  }
});
test("budget fallback makes failed momentum permanent REJECT and never resets the watch", () => {
  const s = fixture(), c = s.candidates[0];
  c.change5mPct = -1;
  assert.equal(evaluateBudgetWatches(s).size, 1);
  assert.equal(c.status, "rejected"); assert.ok(c.permanentlyRejectedAt);
  assert.match(c.reasoning!, /Deterministic budget fallback REJECT/);
  c.change5mPct = 10;
  assert.equal(evaluateBudgetWatches(s).size, 0);
  assert.equal(s.watchlist![c.mint].aiDecision, "REJECT");
});
test("fallback does not run before budget exhaustion, after owner pause, or for expired watches", () => {
  const s = fixture();
  s.aiCalls = 0; assert.equal(evaluateBudgetWatches(s).size, 0);
  s.aiCalls = 1; s.running = false; assert.equal(evaluateBudgetWatches(s).size, 0);
  s.running = true;
  s.watchlist![s.candidates[0].mint].expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal(evaluateBudgetWatches(s).size, 0);
  assert.ok(s.candidates[0].permanentlyRejectedAt);
});
test("manual wallets and handle targets have independent opt-ins; disabling tracking revokes cached signals", () => {
  const s = fixture(), wallet = s.candidates[0].mint;
  s.settings.copyTargets = [{ platform: "wallet", username: "Manual", wallet },
    { platform: "x", username: "Linked", wallet: "11111111111111111111111111111111" }];
  s.settings.copyTradingEnabled = true;
  assert.deepEqual(targetLeaders(s.settings, []).map(l => l.handle), ["Manual"]);
  s.settings.trackFomoHandles = true;
  assert.equal(targetLeaders(s.settings, []).length, 2);
  s.settings.copyTradingEnabled = false;
  assert.deepEqual(targetLeaders(s.settings, []).map(l => l.handle), ["Linked"]);
  const state = crazyState(s), at = Date.now();
  state.leaders = targetLeaders(s.settings, []);
  state.signals = [{ id: "signal", wallet: state.leaders[0].wallet, handle: "Linked",
    mint: wallet, side: "buy", at, priceSol: 1, fraction: 1 }];
  assert.equal(latestCopy(s, wallet, at)?.id, "signal");
  s.settings.trackFomoHandles = false;
  assert.equal(latestCopy(s, wallet, at), undefined);
});
test("Crazy Mode alone never triggers public leaderboard polling when tracking is off", async () => {
  const s = fixture(); s.settings.riskMode = "crazy";
  assert.equal(await pollFomo(s), false);
  assert.equal(crazyState(s).lastRefreshAt, 0);
  // Manual copy without handle targets must not fetch rankings either.
  s.settings.copyTradingEnabled = true;
  await pollFomo(s);
  assert.equal(crazyState(s).lastRefreshAt, 0);
});
test("two-minute migration applies once and preserves later custom conservative settings", () => {
  const raw = initialState(); delete raw.scanCadenceVersion;
  raw.settings.scanIntervalMinutes = 5;
  const migrated = normalize(raw);
  assert.equal(scanMinutes(migrated.settings), 2);
  migrated.settings.scanIntervalMinutes = 9;
  assert.equal(scanMinutes(normalize(migrated).settings), 9);
  migrated.settings.riskMode = "crazy";
  assert.equal(scanMinutes(migrated.settings), 2);
});
test("scanner worker index pages large datasets in fifties with exact search, counts and clamping", () => {
  const index = new ScannerIndex();
  const records = Array.from({ length: 10001 }, (_, i) => ({
    mint: `mint-${i}`, symbol: `TOKEN${i}`, name: "Fixture", status: i % 2 ? "rejected" : "watching",
    watchExpiresAt: new Date(Date.now() + 900000).toISOString(),
  }));
  index.load(records);
  const all = index.query({ q: "", status: "all", tab: "all", page: 0 });
  assert.equal(all.indices.length, 50); assert.equal(all.total, 10001);
  assert.deepEqual(all.counts, { all: 10001, watching: 5001, rejected: 5000 });
  const last = index.query({ q: "", status: "all", tab: "all", page: 9999 });
  assert.equal(last.pg, 200); assert.deepEqual(last.indices, [10000]);
  assert.equal(index.query({ q: "TOKEN10000", status: "all", tab: "watching", page: 0 }).total, 1);
  assert.equal(index.query({ q: "mint-1", status: "watching", tab: "rejected", page: 0 }).total, 0);
  index.load(records.slice(0, 4));
  assert.equal(index.query({ q: "", status: "all", tab: "all", page: 200 }).pg, 0);
});
