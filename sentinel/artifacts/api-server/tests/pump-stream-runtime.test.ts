import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { ingestPumpLogs, recentPumpCreations, observePumpTrade, setPumpCreatorBaseline, pumpPanic, observePumpProgress, pumpCreatorCheckpoint } from "../src/lib/sentinel/pump-observations";
import { PUMP_PROGRAM, pumpCurveAddress } from "../src/lib/sentinel/curve-policy";
import { launchpadExitPreset, snapshotExitPlan, moonbagDecision, tierAmount } from "../src/lib/sentinel/exit-policy";
import { initialState, normalize } from "../src/lib/sentinel/store";
import { checkRuntimeGoal } from "../src/lib/sentinel/runtime-goal";

test("legacy Pump creation is observed without REST/indexing and spoofed program data is ignored", () => {
  const mint = Keypair.generate().publicKey, user = Keypair.generate().publicKey;
  const tag = createHash("sha256").update("event:CreateEvent").digest().subarray(0, 8);
  const bytes = Buffer.concat([tag, Buffer.alloc(12), mint.toBuffer(), pumpCurveAddress(mint).toBuffer(), user.toBuffer()]);
  const data = `Program data: ${bytes.toString("base64")}`;
  ingestPumpLogs({ signature: "spoof", err: null, logs: [data] }, 123);
  assert.ok(!recentPumpCreations().some(c => c.mint === mint.toBase58()));
  ingestPumpLogs({ signature: "real", err: null, logs: [`Program ${PUMP_PROGRAM} invoke [1]`, data, `Program ${PUMP_PROGRAM} success`] }, 124);
  const seen = recentPumpCreations().find(c => c.mint === mint.toBase58())!;
  assert.equal(seen.slot, 124); assert.equal(seen.createdAt, null); assert.equal(seen.hintOnly, true);
});

test("creator sales aggregate within a single block, reject older slots, and preserve the pre-block baseline", () => {
  const mint = Keypair.generate().publicKey.toBase58(), creator = Keypair.generate().publicKey.toBase58();
  setPumpCreatorBaseline(mint, creator, 1000n, 10);
  observePumpTrade(mint, creator, 9, false, 1000n); assert.equal(pumpPanic(mint), null);
  observePumpTrade(mint, creator, 11, false, 300n); assert.equal(pumpPanic(mint), null);
  observePumpTrade(mint, creator, 11, false, 201n); assert.match(pumpPanic(mint)!, /over 50%.*slot 11/);
  const other = Keypair.generate().publicKey.toBase58();
  setPumpCreatorBaseline(other, creator, 1000n, 10);
  observePumpTrade(other, creator, 11, false, 300n);
  observePumpTrade(other, creator, 12, false, 300n);
  assert.equal(pumpPanic(other), null, "different blocks are not mislabeled as a single-block dump");
  const checkpoint = JSON.parse(JSON.stringify(pumpCreatorCheckpoint(other)));
  const restored = Keypair.generate().publicKey.toBase58();
  setPumpCreatorBaseline(restored, checkpoint.address, BigInt(checkpoint.balanceRaw), checkpoint.slot);
  observePumpTrade(restored, creator, 13, false, 201n);
  assert.match(pumpPanic(restored)!, /over 50%/, "restart uses the latest durable holdings, not the original stale balance");
});

test("rapid curve reversal triggers a panic but gradual movement does not", () => {
  const mint = Keypair.generate().publicKey.toBase58(), slow = Keypair.generate().publicKey.toBase58();
  observePumpProgress(mint, 30, 1000); observePumpProgress(mint, 24, 4000);
  // Synthetic timestamps are deliberately old: use current time for the retained panic.
  const at = Date.now();
  observePumpProgress(mint, 30, at); observePumpProgress(mint, 24, at + 100);
  assert.match(pumpPanic(mint)!, /5 percentage/);
  observePumpProgress(slow, 30, at); observePumpProgress(slow, 20, at + 20000);
  assert.equal(pumpPanic(slow), null);
});

test("existing 50%/+60%, 30%/+150% snapshots retain their tiers and 15% trail", () => {
  const plan = snapshotExitPlan({ ...initialState().settings, ...launchpadExitPreset, takeProfitPct: 60, secondSellPct: 30 })!;
  const p: any = { exitPlan: plan, rawInitial: "10000", rawRemaining: "10000", firstTierDone: false, secondTierDone: false, highWaterPriceSol: 2 };
  assert.equal(moonbagDecision(p, 59.9, 1.6), null);
  assert.equal(moonbagDecision(p, 60, 1.6)?.tier, 1); assert.equal(tierAmount(p, 1), 5000n);
  p.rawRemaining = "5000"; p.firstTierDone = true;
  assert.equal(moonbagDecision(p, 150, 2.5)?.tier, 2); assert.equal(tierAmount(p, 2), 3000n);
  p.rawRemaining = "2000"; p.secondTierDone = true;
  assert.match(moonbagDecision(p, 40, 1.7)?.full!, /trailing/);
});

test("5x run goal is durable, does not trigger below target or on pending orders, and only stops new work", () => {
  const s = initialState(); s.running = true; s.cashUsd = 10;
  checkRuntimeGoal(s); assert.equal(s.runtimeGoal?.targetEquityUsd, 50);
  s.cashUsd = 49.99; checkRuntimeGoal(s); assert.equal(s.running, true);
  s.cashUsd = 50; s.pending = {} as any; checkRuntimeGoal(s); assert.equal(s.running, true);
  s.pending = null; checkRuntimeGoal(s); assert.equal(s.running, false); assert.ok(s.runtimeGoal?.reachedAt);
  assert.match(s.activity[0].message, /exits.*1%/);
});

test("existing v2 settings migrate to requested launchpad defaults exactly once without changing run intent or old exit plans", () => {
  const s = initialState(); s.running = true; delete s.launchStrategyVersion;
  s.settings.takeProfitPct = 100; s.settings.secondTakeProfitPct = 300; s.settings.trailingStopPct = 8;
  const oldPlan = snapshotExitPlan(s.settings);
  s.positions = [{ exitPlan: oldPlan, status: "retained", walletAddress: null } as any];
  const updated = normalize(s);
  assert.equal(updated.running, true);
  assert.equal(updated.settings.takeProfitPct, 100); assert.equal(updated.settings.secondTakeProfitPct, 150);
  assert.equal(updated.settings.trailingStopPct, 15); assert.equal(updated.settings.crazyTop10Pct, 25);
  assert.equal(updated.positions[0].exitPlan?.firstTargetPct, 100);
  updated.settings.takeProfitPct = 120;
  assert.equal(normalize(updated).settings.takeProfitPct, 120, "later owner customization is preserved");
});
