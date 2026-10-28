import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { initialState } from "../src/lib/sentinel/store";
import { targetLeaders, validateCopyTargets } from "../src/lib/sentinel/copy-targets";
import { latestCopy } from "../src/lib/sentinel/crazy-assessment";
import { crazyState } from "../src/lib/sentinel/crazy-policy";
import { rankedFomoWallets } from "../src/lib/sentinel/fomo";
import { hotPumpActivity, curveProgressAllowed } from "../src/lib/sentinel/pump-sniping";
import { launchpadExitPreset, markExitFill, moonbagDecision, snapshotExitPlan, tierAmount } from "../src/lib/sentinel/exit-policy";
import type { Candidate, Position } from "../src/lib/sentinel/types";

const wallet = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
test("target contract rejects malformed, duplicate and unbound X identities", () => {
  const s = initialState().settings;
  assert.match(validateCopyTargets({ ...s, copyTargets: [{ platform: "x", username: "leader", wallet: "" }] })!, /linked/);
  assert.match(validateCopyTargets({ ...s, copyTargets: [{ platform: "wallet", username: "", wallet: "bad" }] })!, /valid/);
  assert.match(validateCopyTargets({ ...s, copyTargets: [1, 2].map(() => ({ platform: "wallet", username: "", wallet })) })!, /duplicate/);
  assert.equal(validateCopyTargets({ ...s, copyTargets: [{ platform: "x", username: "@leader", wallet }] }), null);
  assert.equal(validateCopyTargets({ ...s, copyTargets: [{ platform: "fomo", username: "unresolved", wallet: "" }] }), null);
});
test("unresolved FOMO cannot create an active wallet; explicit X wallet is an owner association", () => {
  const s = initialState().settings;
  const settings = { ...s, copyTradingEnabled: false, trackFomoHandles: true, copyTargets: [
    { platform: "fomo" as const, username: "@missing", wallet: "" },
    { platform: "x" as const, username: "@linked", wallet },
  ] };
  assert.deepEqual(targetLeaders(settings, []).map(l => [l.wallet, l.origin]), [[wallet, "target"]]);
  assert.deepEqual(targetLeaders({ ...settings, trackFomoHandles: false }, []), []);
});
test("target linking uses exact handles and preserves loss demotion, not guessed wallet identities", () => {
  const s = initialState().settings;
  const linked = [{ wallet, handle: "Leader", rank: 8, losingCopies: 3, demoted: true }];
  const settings = { ...s, trackFomoHandles: true, copyTargets: [{ platform: "fomo" as const, username: "@leader", wallet: "" }] };
  const result = targetLeaders(settings, linked, linked);
  assert.equal(result[0].origin, "username"); assert.equal(result[0].demoted, true);
  assert.equal(targetLeaders({ ...settings, copyTargets: [{ ...settings.copyTargets[0], username: "different" }] }, [], linked).length, 0);
});
test("public username resolution can use top-ten linked traders independently of positive-PnL top-three selection", () => {
  const at = Date.now();
  const payload = { source: "fomo", stale: false, window: "24h", board: "fomo-parity", syncedAt: new Date(at).toISOString(),
    data: [{ rank: 9, handle: "leader", pnlUsd: -10, wallets: [{ chain: "solana", address: wallet }] }] };
  assert.equal(rankedFomoWallets(payload, at, true)[0].wallet, wallet);
  assert.throws(() => rankedFomoWallets(payload, at));
  assert.throws(() => rankedFomoWallets({ ...payload, source: "computed" }, at, true));
});
test("explicit target buys qualify in either risk mode without a FOMO ranking; disabling immediately invalidates signals", () => {
  for (const riskMode of ["conservative", "crazy"] as const) {
    const s = initialState(), at = Date.now();
    s.settings = { ...s.settings, riskMode, copyTradingEnabled: true, copyTargets: [{ platform: "wallet", username: "", wallet }] };
    const state = crazyState(s);
    state.leaders = targetLeaders(s.settings, []);
    state.signals = [{ id: "buy", wallet, handle: "leader", mint, side: "buy", at, priceSol: 1, fraction: 1 }];
    assert.equal(latestCopy(s, mint, at)?.id, "buy");
    s.settings.copyTradingEnabled = false; assert.equal(latestCopy(s, mint, at), undefined);
    s.settings.copyTradingEnabled = true; s.settings.copyTargets = []; assert.equal(latestCopy(s, mint, at), undefined);
  }
});
test("copy signal is single-use, cancelled by leader sell and expires after thirty seconds", () => {
  const s = initialState(), at = Date.now();
  s.settings = { ...s.settings, copyTradingEnabled: true, copyTargets: [{ platform: "wallet", username: "", wallet }] };
  const state = crazyState(s); state.leaders = targetLeaders(s.settings, []);
  state.signals = [{ id: "buy", wallet, handle: "leader", mint, side: "buy", at, priceSol: 1, fraction: 1 }];
  assert.equal(latestCopy(s, mint, at + 30001), undefined);
  state.consumed = ["buy"]; assert.equal(latestCopy(s, mint, at), undefined);
  state.consumed = []; state.signals.push({ ...state.signals[0], id: "sell", side: "sell" });
  assert.equal(latestCopy(s, mint, at), undefined);
});
test("FOMO-linked usernames lose entry eligibility when their identity source is stale", () => {
  const s = initialState(), at = Date.now();
  s.settings = { ...s.settings, trackFomoHandles: true, copyTargets: [{ platform: "fomo", username: "leader", wallet: "" }] };
  const state = crazyState(s);
  state.leaders = [{ wallet, handle: "leader", rank: 9, losingCopies: 0, demoted: false, origin: "username", active: true }];
  state.signals = [{ id: "buy", wallet, handle: "leader", mint, side: "buy", at, priceSol: 1, fraction: 1 }];
  assert.equal(latestCopy(s, mint, at), undefined);
  state.sourceAt = new Date(at).toISOString(); assert.equal(latestCopy(s, mint, at)?.id, "buy");
});
test("Pump burst supports strict greater-than-three buy ratio, rapid transactions, and real SOL volume without synthetic scores", () => {
  assert.equal(hotPumpActivity({ count: 5, buys: 4, sells: 1, volumeSol: 0.01 }), true);
  assert.equal(hotPumpActivity({ count: 4, buys: 3, sells: 1, volumeSol: 0.01 }), false);
  assert.equal(hotPumpActivity({ count: 12, buys: 7, sells: 5, volumeSol: 0.01 }), true);
  assert.equal(hotPumpActivity({ count: 5, buys: 3, sells: 2, volumeSol: 1 }), true);
  assert.equal(hotPumpActivity({ count: 50, buys: 2, sells: 48, volumeSol: 100 }), false);
  assert.equal(hotPumpActivity({ count: 5, buys: 4, sells: 1, volumeSol: NaN }), false);
});
test("persisted labels alone cannot relax curve progress; ordinary launchpad safeguards remain", () => {
  const settings = { ...initialState().settings, riskMode: "crazy" as const };
  const c = { mint } as Candidate;
  assert.equal(curveProgressAllowed(c, settings, 5), false);
  assert.equal(curveProgressAllowed(c, settings, 25), true);
  assert.equal(curveProgressAllowed(c, settings, 96), false);
  assert.equal(curveProgressAllowed(c, settings, undefined), false);
});
test("aggressive new-fill snapshot sells exactly half at 2x, disables second sale, then trails the sellable remainder", () => {
  const p = { rawInitial: "10000", rawRemaining: "10000", exitPlan: snapshotExitPlan({ ...initialState().settings, ...launchpadExitPreset }),
    firstTierDone: false, secondTierDone: false, highWaterPriceSol: 2, lastExitPriceSol: 2 } as Position;
  assert.equal(moonbagDecision(p, 99, 1.99), null);
  assert.equal(moonbagDecision(p, 100, 2)?.tier, 1);
  assert.equal(tierAmount(p, 1), 5000n);
  p.rawRemaining = "5000"; markExitFill(p);
  assert.equal(p.secondTierDone, true);
  assert.equal(moonbagDecision(p, 110, 1.69)?.full, "Moon bag trailing stop");
});
