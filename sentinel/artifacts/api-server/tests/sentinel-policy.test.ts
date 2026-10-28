import test from "node:test";
import assert from "node:assert/strict";
import { aiDue, cachedAssessment, marketUnchanged, ASSESSMENT_POLICY_VERSION, excludedVerificationFlag, currentCandidateWarnings } from "../src/lib/sentinel/cost-policy";
import { assertNativeSwap, nativeSwapDelta, solFill, solReturnPct } from "../src/lib/sentinel/native-accounting";
import type { Candidate, State } from "../src/lib/sentinel/types";

const time = Date.parse("2026-10-26T12:00:00Z");
const c = {
  mint: "example", name: "Example", symbol: "MEME", priceUsd: 0.000001,
  liquidityUsd: 150000, volume24hUsd: 100000, change5mPct: 2, change24hPct: 10,
  buys5m: 100, sells5m: 50, score: 90, status: "eligible", risks: [], reasoning: "Facts",
} as Candidate;
function state() {
  return {
    settings: { maxAiCallsPerDay: 12, aiIntervalMinutes: 60, aiCacheMinutes: 60 },
    aiCalls: 0, lastAiAt: null, assessments: {},
  } as State;
}
test("low-cost AI has a global hourly interval, not one interval per token", () => {
  const s = state();
  assert.equal(aiDue(s, time), true);
  s.lastAiAt = new Date(time).toISOString();
  assert.equal(aiDue(s, time + 59 * 60000), false);
  assert.equal(aiDue(s, time + 60 * 60000), true);
});
test("hard daily cap and zero budget prevent all new paid requests", () => {
  const s = state(); s.aiCalls = 12;
  assert.equal(aiDue(s, time), false);
  s.aiCalls = 0; s.settings.maxAiCallsPerDay = 0;
  assert.equal(aiDue(s, time), false);
});
test("one-minute and twice-hourly schedules are supported", () => {
  const s = state(); s.lastAiAt = new Date(time).toISOString();
  s.settings.aiIntervalMinutes = 1;
  assert.equal(aiDue(s, time + 60000), true);
  s.settings.aiIntervalMinutes = 30;
  assert.equal(aiDue(s, time + 29 * 60000), false);
  assert.equal(aiDue(s, time + 30 * 60000), true);
});
test("cached evidence expires at its configured TTL", () => {
  const s = state();
  s.assessments[c.mint] = { at: new Date(time).toISOString(), snapshot: c, candidate: c, decimals: 6, staged: false, topPct: 2, policyVersion: ASSESSMENT_POLICY_VERSION };
  assert.ok(cachedAssessment(s, c, time + 59 * 60000));
  assert.equal(cachedAssessment(s, c, time + 60 * 60000), null);
  delete s.assessments[c.mint].policyVersion;
  assert.equal(cachedAssessment(s, c, time + 1000), null, "old social/lock policy scores must be reassessed");
});
test("excluded verification warnings cannot block entries, but actual hazards remain", () => {
  assert.equal(excludedVerificationFlag("Social authenticity and liquidity locks not verified"), true);
  assert.equal(excludedVerificationFlag("LP burn not verified"), true);
  assert.equal(excludedVerificationFlag("Observed liquidity drain"), false);
  assert.equal(excludedVerificationFlag("Active mint authority"), false);
  assert.equal(excludedVerificationFlag("Top-10 concentration exceeds limit"), false);
  assert.equal(excludedVerificationFlag("Liquidity locks unknown and wash trading observed"), false);
  const prior = { ...c, status: "rejected", score: 30, risks: ["Social authenticity and liquidity locks not verified"],
    reasoning: "LP burn gate: LP mint supply is not burned" } as typeof c;
  const fresh = currentCandidateWarnings(prior);
  assert.deepEqual(fresh.risks, []);
  assert.equal(fresh.status, "watching", "removed flags must not auto-authorize an entry");
  assert.equal(fresh.score, null);
});
test("tiny memecoin price changes are relative, never rounded up to a dollar", () => {
  assert.equal(marketUnchanged(c, { ...c, priceUsd: c.priceUsd * 10 }), false);
  assert.equal(marketUnchanged(c, { ...c, priceUsd: c.priceUsd * 1.02 }), true);
});
test("liquidity and sell-pressure changes invalidate cached evidence", () => {
  assert.equal(marketUnchanged(c, { ...c, liquidityUsd: c.liquidityUsd * 0.7 }), false);
  assert.equal(marketUnchanged(c, { ...c, sells5m: c.sells5m * 2 }), false);
  assert.equal(marketUnchanged(c, { ...c, symbol: "OTHER" }), false);
});
test("SOL buy simulation separates authorized principal from fees and ATA rent", () => {
  const principal = 10_000_000, fee = 5000, rent = 2_039_280;
  const before = 100_000_000, after = before - principal - fee - rent;
  const delta = nativeSwapDelta(before, after, fee, rent);
  assert.equal(delta, -BigInt(principal));
  assert.doesNotThrow(() => assertNativeSwap("buy", delta, 500_000n, BigInt(principal), 490_000n));
  assert.equal(solFill("buy", before, after), (principal + fee + rent) / 1e9);
});
test("SOL sell simulation handles fees and rent refunds without mistaking them for swap proceeds", () => {
  const output = 20_000_000, fee = 5000, rentRefund = 2_039_280;
  const before = 100_000_000, after = before + output - fee + rentRefund;
  const delta = nativeSwapDelta(before, after, fee, -rentRefund);
  assert.equal(delta, BigInt(output));
  assert.doesNotThrow(() => assertNativeSwap("sell", delta, -500_000n, 500_000n, 19_000_000n));
  assert.equal(solFill("sell", before, after), (output - fee + rentRefund) / 1e9);
});
test("overspending, token approvals hidden as balance changes and insufficient output are refused", () => {
  assert.throws(() => assertNativeSwap("buy", -11_000_000n, 500_000n, 10_000_000n, 490_000n));
  assert.throws(() => assertNativeSwap("buy", -10_000_000n, 480_000n, 10_000_000n, 490_000n));
  assert.throws(() => assertNativeSwap("sell", 20_000_000n, -600_000n, 500_000n, 19_000_000n));
  assert.throws(() => assertNativeSwap("sell", 18_000_000n, -500_000n, 500_000n, 19_000_000n));
});
test("zero/negative native settlement cannot be reconciled as a successful fill", () => {
  assert.throws(() => solFill("buy", 10, 10));
  assert.throws(() => solFill("sell", 10, 9));
});
test("profit targets use SOL returns, not a USD gain caused only by SOL appreciation", () => {
  assert.ok(solReturnPct(0.01, 0.009) < 0);
  assert.ok(Math.abs(solReturnPct(0.01, 0.012) - 20) < 1e-8);
  assert.equal(solReturnPct(0, 0), 0);
});
