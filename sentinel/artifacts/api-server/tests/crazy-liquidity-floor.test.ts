import test from "node:test";
import assert from "node:assert/strict";
import { getSettingsResponseCrazyMinLiquidityUsdDefault, getSettingsResponseCrazyMinLiquidityUsdMin } from "@workspace/api-zod";
import { initialState, normalize } from "../src/lib/sentinel/store";
import { crazyMarketFilters } from "../src/lib/sentinel/crazy-policy";
import type { Candidate, Position } from "../src/lib/sentinel/types";

test("Crazy entries accept exactly $1,000 reserves, reject below it and respect stricter saved floors", () => {
  const s = initialState();
  s.settings.riskMode = "crazy"; s.settings.crazyAcknowledged = true;
  assert.equal(s.settings.crazyMinLiquidityUsd, 1000);
  assert.equal(getSettingsResponseCrazyMinLiquidityUsdDefault, 1000);
  assert.equal(getSettingsResponseCrazyMinLiquidityUsdMin, 400, "API supports the explicit hunt soft floor; ordinary Crazy still enforces 1000");
  const c = { updatedAt: new Date().toISOString(), priceUsd: 1, liquidityUsd: 1000,
    buys5m: 3, volume24hUsd: 0 } as Candidate;
  assert.deepEqual(crazyMarketFilters(c, s.settings), []);
  assert.match(crazyMarketFilters({ ...c, liquidityUsd: 999.99 }, s.settings).join(), /Liquidity/);
  s.settings.crazyMinLiquidityUsd = 1500;
  assert.match(crazyMarketFilters(c, s.settings).join(), /Liquidity/);
  assert.deepEqual(crazyMarketFilters({ ...c, liquidityUsd: 1500 }, s.settings), []);
});

test("saved $2,500 floor migrates once without starting/stopping, changing conservative limits or altering pending/existing exposure", () => {
  const s = initialState(); delete s.crazyLiquidityFloorVersion;
  s.running = true; s.settings.crazyMinLiquidityUsd = 2500;
  s.pending = { id: "synthetic-pending" } as any;
  s.positions = [{ id: "existing", status: "open", walletAddress: null,
    exitPlan: { firstTargetPct: 60, secondTargetPct: 150, firstSellPct: 50, secondSellPct: 30, trailingStopPct: 15 } } as Position];
  const migrated = normalize(s);
  assert.equal(migrated.settings.crazyMinLiquidityUsd, 1000);
  assert.equal(migrated.settings.minLiquidityUsd, s.settings.minLiquidityUsd);
  assert.equal(migrated.settings.minVolumeUsd, s.settings.minVolumeUsd);
  assert.equal(migrated.running, true);
  assert.deepEqual(migrated.pending, s.pending);
  assert.deepEqual(migrated.positions, s.positions);
  migrated.settings.crazyMinLiquidityUsd = 2000;
  assert.equal(normalize(migrated).settings.crazyMinLiquidityUsd, 2000, "later owner changes remain saved");
  s.running = false;
  assert.equal(normalize(s).running, false);
});

test("old policy and legacy-settlement migrations cannot restore a $2,500 Crazy floor", () => {
  const s = initialState(); delete s.crazyLiquidityFloorVersion; delete s.crazyPolicyVersion;
  s.settings.crazyMinLiquidityUsd = 2500;
  assert.equal(normalize(s).settings.crazyMinLiquidityUsd, 1000);
  (s as any).version = 1;
  assert.equal(normalize(s).settings.crazyMinLiquidityUsd, 1000);
});
