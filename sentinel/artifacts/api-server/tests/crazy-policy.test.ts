import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { initialState, normalize } from "../src/lib/sentinel/store";
import { copyGuard, crazyState, dipSignal, momentumSignal, positionBudget, recordCopyLosses, crazyMarketFilters, executionSettings, scanMinutes } from "../src/lib/sentinel/crazy-policy";
import { entryBudgetAvailable } from "../src/lib/sentinel/entry-policy";
import { candidateOpenTime } from "../src/lib/sentinel/crazy-safety";
import { rankedFomoWallets, leaderSwap } from "../src/lib/sentinel/fomo";
import { latestCopy } from "../src/lib/sentinel/crazy-assessment";
import type { Candidate, CopySignal, Position } from "../src/lib/sentinel/types";

test("8% current-book normal Crazy sizing; conservative dollar sizing is unchanged", () => {
  const s = initialState(); s.settings.riskMode = "crazy";
  assert.equal(positionBudget(s.settings, 32), 2.56);
  assert.equal(positionBudget(s.settings, 20), 1.6);
  assert.equal(positionBudget(s.settings, 1000), 80);
  assert.equal(positionBudget(s.settings, 0), 0);
  assert.equal(positionBudget(s.settings, NaN), 0);
  s.settings.positionSizeUsd = 3;
  assert.equal(positionBudget(s.settings, 100), 8);
  s.settings.normalEquityPct = 10;
  assert.equal(positionBudget(s.settings, 100), 10);
  assert.equal(positionBudget({ ...s.settings, riskMode: "conservative" }, 100), 3);
  assert.equal(initialState().settings.riskMode, "conservative");
});
test("momentum supports first-observation activity or a shorter real baseline; dip still needs recovery", () => {
  const at = Date.now(), c = { buys5m: 25, sells5m: 5, volume5mUsd: 30, change5mPct: 2, priceUsd: 0.735 } as Candidate;
  const history = [240000, 180000, 120000].map(t => ({ at: at - t, price: 1, activity: 10 }));
  assert.equal(momentumSignal(c, history, at), true);
  assert.equal(momentumSignal(c, history.slice(1), at), true);
  assert.equal(momentumSignal(c, history.slice(2), at), false);
  assert.equal(momentumSignal({ ...c, volume5mUsd: 1000 }, [], at), true);
  assert.equal(momentumSignal({ ...c, volume5mUsd: 1000, sells5m: 50 }, [], at), false);
  assert.equal(momentumSignal({ ...c, volume5mUsd: 1000, change5mPct: 90 }, [], at), false);
  assert.equal(momentumSignal({ ...c, volume5mUsd: 7 }, history, at), false);
  assert.equal(momentumSignal({ ...c, volume5mUsd: null }, history, at), false);
  const wick = [{ at: at - 240000, price: 1, activity: 10 },
    { at: at - 180000, price: 0.8, activity: 10 }, { at: at - 60000, price: 0.7, activity: 10 }];
  assert.equal(dipSignal(c, wick, at), true);
  assert.equal(dipSignal({ ...c, priceUsd: 0.65 }, wick, at), false);
  assert.equal(dipSignal({ ...c, priceUsd: 0.9 }, wick, at), false, "do not chase a bounce");
});
test("Crazy floors, daily entry policy and bounded execution settings are mode-specific", () => {
  const s = initialState(); s.settings.riskMode = "crazy"; s.settings.crazyAcknowledged = true;
  const c = { priceUsd: 1, liquidityUsd: 1000, volume24hUsd: 0, buys5m: 3,
    updatedAt: new Date().toISOString(), flaggedSuspicious: false, organicScore: 0, ageMinutes: 1, change5mPct: 3 } as Candidate;
  assert.deepEqual(crazyMarketFilters(c, s.settings), []);
  assert.match(crazyMarketFilters({ ...c, liquidityUsd: 999 }, s.settings).join(), /liquidity/i);
  assert.ok(crazyMarketFilters({ ...c, flaggedSuspicious: true }, s.settings).length);
  assert.ok(crazyMarketFilters(c, { ...s.settings, crazyMinVolumeUsd: 1000 }).length);
  s.positions = Array.from({ length: 100 }, () => ({ mode: "paper", openedAt: new Date().toISOString() } as Position));
  assert.equal(entryBudgetAvailable(s), true);
  assert.equal(entryBudgetAvailable({ ...s, settings: { ...s.settings, riskMode: "conservative" } }), true);
  assert.equal(scanMinutes(s.settings), 2);
  assert.equal(executionSettings(s.settings, c).slippageBps, 1000);
  assert.equal(executionSettings({ ...s.settings, crazySlippageBps: 1500 }, c).slippageBps, 1500);
  assert.equal(executionSettings(s.settings).stopLossPct, 20);
  assert.equal(executionSettings({ ...s.settings, riskMode: "conservative" }).slippageBps, s.settings.slippageBps);
});
test("risk rollout preserves owner running choice, old exits and subsequent owner settings", () => {
  const s = initialState();
  s.settings.riskMode = "crazy"; s.running = true;
  delete s.crazyPolicyVersion;
  s.settings.crazyEquityPct = 10;
  s.positions = [{ status: "open", exitPlan: { firstTargetPct: 100, secondTargetPct: 300, firstSellPct: 50, secondSellPct: 30, trailingStopPct: 8 } } as Position];
  const n = normalize(s);
  assert.equal(n.running, true); assert.equal(n.settings.crazyEquityPct, 20);
  assert.equal(n.positions[0].exitPlan?.firstTargetPct, 100); assert.equal(n.positions[0].fastCrazyExit, undefined);
  n.settings.crazyEquityPct = 12; n.running = true;
  assert.equal(normalize(n).settings.crazyEquityPct, 12); assert.equal(normalize(n).running, true);
});
test("copy skips above 15% chase with wallet/lag available; rejects stale and sold signals", () => {
  const at = Date.now(), wallet = Keypair.generate().publicKey.toBase58();
  const signal: CopySignal = { id: "buy", wallet, handle: "fixture", mint: "mint", side: "buy", at: at - 1000, priceSol: 0.001, fraction: 1 };
  assert.match(copyGuard(signal, 0.0013, at)!, /15%/);
  assert.equal(copyGuard(signal, 0.00115, at), null);
  assert.match(copyGuard({ ...signal, at: at - 40000 }, 0.001, at)!, /stale/);
  const s = initialState(), state = crazyState(s);
  s.settings.riskMode = "crazy";
  s.settings.trackFomoHandles = true;
  state.sourceAt = new Date(at).toISOString();
  state.leaders = [{ wallet, handle: "fixture", rank: 1, active: true, losingCopies: 0, demoted: false, origin: "ranked" }];
  state.signals = [signal];
  assert.equal(latestCopy(s, "mint", at)?.id, "buy");
  state.signals.push({ ...signal, id: "sell", side: "sell", at });
  assert.equal(latestCopy(s, "mint", at), undefined);
  assert.equal(signal.wallet, wallet); assert.equal(at - signal.at, 1000);
});
test("Sniper age evidence ages while quotes run without requiring LP-burn proof", () => {
  const at = Date.now(), c = { ageMinutes: 4.99, updatedAt: new Date(at - 2000).toISOString() } as Candidate;
  assert.ok(at / 1000 - candidateOpenTime(c) > 300);
  assert.throws(() => candidateOpenTime({ ...c, updatedAt: "unknown" }), /age evidence/);
  assert.throws(() => candidateOpenTime({ ...c, ageMinutes: NaN }), /age evidence/);
});
test("demotes after three losing closed copies, is idempotent and survives persisted state", () => {
  const s = initialState(), state = crazyState(s), wallet = "leader";
  state.leaders = [{ wallet, handle: "fixture", rank: 1, losingCopies: 0, demoted: false, active: true }];
  s.positions = [1, 2, 3].map(i => ({ id: String(i), leaderWallet: wallet, status: "closed", realizedPnlSol: -0.01 } as Position));
  recordCopyLosses(s); recordCopyLosses(s);
  assert.equal(state.leaders[0].losingCopies, 3); assert.equal(state.leaders[0].demoted, true);
  assert.equal(JSON.parse(JSON.stringify(s)).crazy.leaders[0].demoted, true);
});
test("Fomo rankings must be fresh Fomo-reported daily data, never silently computed data", () => {
  const at = Date.now(), wallet = Keypair.generate().publicKey.toBase58();
  const q = { source: "fomo", stale: false, window: "24h", board: "fomo-parity", syncedAt: new Date(at).toISOString(),
    data: [{ rank: 1, handle: "fixture", pnlUsd: 10, wallets: [{ chain: "solana", address: wallet }] }] };
  assert.equal(rankedFomoWallets(q, at)[0].wallet, wallet);
  assert.throws(() => rankedFomoWallets({ ...q, source: "computed" }, at));
  assert.throws(() => rankedFomoWallets({ ...q, syncedAt: new Date(at - 3600000).toISOString() }, at));
  assert.throws(() => rankedFomoWallets({ ...q, data: [] }, at));
});
test("leader swap verification excludes transfers and failed txs; cancels ATA rent in entry price", () => {
  const wallet = Keypair.generate().publicKey.toBase58(), mint = Keypair.generate().publicKey.toBase58();
  const tx: any = {
    blockTime: Math.floor(Date.now() / 1000),
    transaction: { message: { accountKeys: [{ pubkey: wallet, signer: true }, { pubkey: "ATA", signer: false }],
      instructions: [{ programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }] } },
    meta: { err: null, fee: 5000, preBalances: [1000000000, 0], postBalances: [897955000, 2040000],
      preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, owner: wallet, mint, uiTokenAmount: { amount: "100000000", decimals: 6 } }] },
  };
  assert.equal(leaderSwap(tx, wallet, "fixture", "sig")?.priceSol, 0.001);
  tx.transaction.message.instructions = [];
  assert.equal(leaderSwap(tx, wallet, "fixture", "sig"), null);
  tx.meta.err = { InstructionError: 1 };
  assert.equal(leaderSwap(tx, wallet, "fixture", "sig"), null);
});
