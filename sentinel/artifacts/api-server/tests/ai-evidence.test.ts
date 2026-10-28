import test from "node:test";
import assert from "node:assert/strict";
import { sweepEvidence } from "../src/lib/sentinel/ai-evidence";
import { rpcTask } from "../src/lib/sentinel/rpc-context";
import { DISCOVERY_INTERVAL_MS, WATCH_AI_INTERVAL_MS } from "../src/lib/sentinel/scan-schedule";
import type { Candidate } from "../src/lib/sentinel/types";

const at = 1800000000000;
const candidate = (mint: string, age = 0) => ({
  mint, priceUsd: 1, updatedAt: new Date(at - age).toISOString(), status: "watching",
}) as Candidate;

test("two-minute discovery is independent of five-minute watch AI; fresh evidence avoids duplicate RPC requests", async () => {
  assert.equal(DISCOVERY_INTERVAL_MS, 120000);
  assert.equal(WATCH_AI_INTERVAL_MS, 300000);
  const rows = [candidate("one"), candidate("two", 45000)];
  const evidence = await sweepEvidence(rows, async () => { throw new Error("must not fetch already fresh data"); }, () => at);
  assert.deepEqual(evidence, rows);
  assert.notEqual(evidence[0], rows[0], "evidence is a snapshot, not a mutable candidate reference");
});
test("only stale watchlist rows are fetched and all evidence lookup remains on background scope", async () => {
  let requested: string[] = [];
  const result = await sweepEvidence([candidate("fresh"), candidate("stale", 45001)], async mints => {
    requested = mints; assert.equal(rpcTask()?.mission, "background");
    return [candidate("stale")];
  }, () => at);
  assert.deepEqual(requested, ["stale"]);
  assert.equal(result.length, 2);
  assert.equal(result[1].updatedAt, new Date(at).toISOString());
  assert.equal(rpcTask(), undefined);
});
test("stalled AI evidence is bounded and cannot replace stale data with an invented fresh timestamp", async () => {
  const old = candidate("stale", 120000);
  await assert.rejects(sweepEvidence([old], () => new Promise<never>(() => {}), () => at, 10), /timed out/);
  assert.equal(old.updatedAt, new Date(at - 120000).toISOString());
  await assert.rejects(sweepEvidence([old], async () => [], () => at), /Fresh AI market evidence unavailable/);
});
test("invalid or implausibly future timestamps and zero prices are never treated as fresh AI evidence", async () => {
  for (const c of [
    { ...candidate("bad"), updatedAt: "invalid" },
    candidate("future", -60000),
    { ...candidate("zero"), priceUsd: 0 },
  ]) {
    await assert.rejects(sweepEvidence([c], async () => [c], () => at), /Fresh AI market evidence unavailable/);
  }
});
