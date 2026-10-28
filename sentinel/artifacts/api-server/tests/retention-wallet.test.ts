import test from "node:test";
import assert from "node:assert/strict";
import { initialState, equity } from "../src/lib/sentinel/store";
import { protectedTokens, sellableTokens, updateRetention } from "../src/lib/sentinel/retention-policy";
import { applyWalletHoldings } from "../src/lib/sentinel/wallet-reconciliation";
import { assertDbcEntryLiquidity } from "../src/lib/sentinel/dbc-entry-policy";
import type { Position } from "../src/lib/sentinel/types";

function position(): Position {
  return { id: "fixture", mint: "fixture-mint", mode: "live", walletAddress: "fixture-wallet", symbol: "FIX", status: "open",
    rawInitial: "1000", rawRemaining: "1000", decimals: 0, quantity: 1000, remainingCostUsd: 100, originalCostUsd: 100,
    remainingCostSol: 1, originalCostSol: 1, realizedPnlSol: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 20,
    stage: 0, openedAt: new Date().toISOString() } as Position;
}
test("fixed reserve survives repeated partial exits, manual/emergency caps and integer rounding", () => {
  const p = position();
  assert.equal(protectedTokens(p), 10n); assert.equal(sellableTokens(p), 990n);
  p.rawRemaining = "500"; assert.equal(sellableTokens(p), 490n);
  p.rawRemaining = "20"; assert.equal(sellableTokens(p), 10n);
  p.rawRemaining = "10"; updateRetention(p);
  assert.equal(p.status, "retained"); assert.equal(sellableTokens(p), 0n);
  p.rawInitial = "1"; delete p.retainedRaw; p.rawRemaining = "1";
  assert.equal(protectedTokens(p), 1n); assert.equal(sellableTokens(p), 0n);
});
test("external full/partial transfers remove exposure without invented sales or daily trading loss", () => {
  const s = initialState(); s.settings.mode = "live"; s.walletBinding = "fixture-wallet"; s.liveCashSol = 1; s.solPriceUsd = 100;
  const p = position(); s.positions = [p]; s.dailyStartEquity = equity(s);
  p.exitRetryReason = "fixture failing exit";
  applyWalletHoldings(s, new Map([[p.mint, 500n]]));
  assert.equal(p.rawRemaining, "500"); assert.equal(p.remainingCostUsd, 50); assert.equal(p.externallyTransferredQuantity, 500);
  assert.equal(p.exitRetryReason, undefined); assert.equal(p.realizedPnlUsd, 0); assert.equal(s.liveCashSol, 1);
  assert.equal(s.dailyStartEquity, equity(s), "withdrawal is not a daily trading loss");
  applyWalletHoldings(s, new Map([[p.mint, 0n]]));
  assert.equal(p.status, "transferred"); assert.equal(p.rawRemaining, "0"); assert.equal(p.unrealizedPnlUsd, 0);
  assert.equal(p.realizedPnlSol, 0); assert.equal(p.externallyTransferredQuantity, 1000);
  assert.equal(s.dailyStartEquity, equity(s));
});
test("aggregate wallet allocation protects reserves on repeat buys and does not claim external deposits", () => {
  const s = initialState(); s.walletBinding = "fixture-wallet";
  const a = position(), b = position(); b.id = "second"; s.positions = [a, b];
  applyWalletHoldings(s, new Map([[a.mint, 20n]]));
  assert.equal(a.rawRemaining, "10"); assert.equal(b.rawRemaining, "10");
  assert.equal(a.status, "retained"); assert.equal(b.status, "retained");
  applyWalletHoldings(s, new Map([[a.mint, 100000n]]));
  assert.equal(a.rawRemaining, "10"); assert.equal(b.rawRemaining, "10");
});
test("DBC accepts only on-chain verified permanent allocations, not withdrawable or missing fields", () => {
  const locked = { partnerPermanentLockedLiquidityPercentage: 80, creatorPermanentLockedLiquidityPercentage: 20,
    partnerLiquidityPercentage: 0, creatorLiquidityPercentage: 0 };
  assert.doesNotThrow(() => assertDbcEntryLiquidity(locked));
  assert.throws(() => assertDbcEntryLiquidity({ ...locked, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 20 }), /DBC entry blocked/);
  assert.throws(() => assertDbcEntryLiquidity({} as any), /DBC entry blocked/);
  assert.throws(() => assertDbcEntryLiquidity({ ...locked, partnerPermanentLockedLiquidityPercentage: 101 }), /DBC entry blocked/);
});
