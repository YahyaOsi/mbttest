import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { ownerId } from "../src/lib/owner-auth";
import { initialState } from "../src/lib/sentinel/store";
import { tick } from "../src/lib/sentinel/engine";
import { emptyLaunchDiscovery } from "../src/lib/sentinel/launch-discovery";
import { entryRestrictions } from "../src/lib/sentinel/worker-policy";
import { SOL } from "../src/lib/sentinel/discovery-policy";

test("RPC outages, loss limits and reconciliation errors keep scanning; only owner stop changes running", async () => {
  process.env.SOLANA_RPC_URL = "https://continuous.test.invalid";
  process.env.SENTINEL_APP_PASSWORD = "synthetic-fixture-password-only";
  const originalFetch = globalThis.fetch, query = pool.query, connect = pool.connect;
  let s = initialState(), halted = false, failing = true, feedRequests = 0, controlWrites = 0;
  s.running = true; s.settings.riskMode = "crazy"; s.settings.crazyAcknowledged = true;
  s.cashSol = 1; s.solPriceUsd = 100; s.dailyStartEquity = 100;
  s.launchDiscovery = { ...emptyLaunchDiscovery(), lastPollAt: Date.now() };
  const databaseQuery = async (sql: string, params?: any[]) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    if (sql.startsWith("SELECT state")) return { rows: [{ state: structuredClone(s) }] };
    if (sql.startsWith("SELECT halted")) return { rows: [{ halted, emergency_requested: false }] };
    if (sql.startsWith("UPDATE trading_accounts SET state=")) s = JSON.parse(params![1]);
    if (sql.includes("SET halted=")) controlWrites++;
    return { rows: [] };
  };
  (pool as any).query = databaseQuery;
  (pool as any).connect = async () => ({ query: databaseQuery, release() {} });
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === "continuous.test.invalid") {
      const req = JSON.parse(String(init!.body));
      assert.ok(!/send|simulate/i.test(req.method), "no execution during verification");
      throw new Error("fixture RPC unavailable");
    }
    assert.equal(init?.method, undefined, "no signing, broadcasts or paid AI");
    if (u.pathname.endsWith(`/${SOL}`)) {
      if (failing) throw new Error("fixture price outage");
      return Response.json([{ chainId: "solana", baseToken: { address: SOL }, priceUsd: "100", liquidity: { usd: 1000000 } }]);
    }
    feedRequests++;
    if (failing) throw new Error("fixture discovery outage");
    return Response.json([]);
  };
  try {
    await tick(ownerId());
    assert.equal(s.running, true);
    assert.ok(feedRequests > 0, "discovery attempted despite failed pricing");
    assert.ok(s.entryBlocks?.some(r => r.includes("SOL/USD")));
    assert.equal(controlWrites, 0, "no automatic owner-stop writes");
    failing = false; s.nextWorkerScanAt = 0;
    s.lastScanAt = null;
    await tick(ownerId());
    assert.equal(s.running, true);
    assert.deepEqual(s.entryBlocks, [], "recovered critical checks clear transient entry blocks");
    assert.equal(s.lastError, null, "background RPC outages cannot persist a fatal wallet banner");
    s.dailyStartEquity = 1000; s.lastScanAt = null;
    s.nextWorkerScanAt = 0;
    s.launchDiscovery!.lastPollAt = Date.now();
    await tick(ownerId());
    assert.equal(s.running, true); assert.ok(s.lastScanAt, "loss limit does not prevent market scan");
    assert.ok(s.entryBlocks?.some(r => /Daily loss/.test(r)));
    s.dailyStartEquity = 0; s.nextWorkerScanAt = 0; s.lastScanAt = null;
    s.positions = [{ id: "fixture", symbol: "FIX", mint: SOL, status: "pending", mode: "paper" } as any];
    s.pending = { positionId: "fixture", signature: "fixture", createdAt: new Date().toISOString() } as any;
    s.launchDiscovery!.lastPollAt = Date.now();
    await tick(ownerId());
    assert.equal(s.running, true); assert.ok(s.pending, "unknown signature is retained, not replaced");
    assert.ok(s.lastScanAt, "pending reconciliation does not stop market scanning");
    assert.ok(entryRestrictions(s).some(r => /reconciliation/.test(r)));
    halted = true;
    await tick(ownerId());
    assert.equal(s.running, false, "explicit owner stop remains authoritative");
    assert.equal(controlWrites, 0);
  } finally { globalThis.fetch = originalFetch; pool.query = query; pool.connect = connect; }
});
