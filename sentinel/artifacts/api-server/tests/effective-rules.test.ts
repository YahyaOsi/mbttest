import test from "node:test";
import assert from "node:assert/strict";
import { effectiveTradingRules } from "../../solana-sentinel/src/lib/effective-rules";
import { initialState } from "../src/lib/sentinel/store";
import { positionBudget, scanMinutes } from "../src/lib/sentinel/crazy-policy";

test("displayed Crazy rules use overrides and match execution sizing, not conservative saved fields", () => {
  const settings = { ...initialState().settings, riskMode: "crazy" as const, minLiquidityUsd: 10000,
    positionSizeUsd: 5.5, minVolumeUsd: 100000, crazyMinLiquidityUsd: 1000, crazyEquityPct: 20, crazyMinVolumeUsd: 0 };
  const rules = effectiveTradingRules(settings, 18.023);
  assert.equal(rules.liquidityUsd, 1000);
  assert.equal(rules.positionPercent, 8);
  assert.equal(rules.fixedPositionUsd, null);
  assert.equal(rules.projectedPositionUsd, positionBudget(settings, 18.023));
  assert.equal(rules.scanMinutes, scanMinutes(settings));
  assert.equal(rules.volumeUsd, 0);
});
test("displayed conservative rules retain fixed sizing and ordinary thresholds", () => {
  const settings = { ...initialState().settings, riskMode: "conservative" as const, minLiquidityUsd: 10000, positionSizeUsd: 5.5 };
  const rules = effectiveTradingRules(settings, 18);
  assert.equal(rules.liquidityUsd, 10000);
  assert.equal(rules.projectedPositionUsd, 5.5);
  assert.equal(rules.positionPercent, null);
});
