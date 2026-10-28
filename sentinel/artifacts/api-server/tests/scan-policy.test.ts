import test from "node:test";
import assert from "node:assert/strict";
import { initialState, normalize } from "../src/lib/sentinel/store";
import { assessmentQueue, recordCandidateCheck, scanFilterSummary } from "../src/lib/sentinel/scan-policy";
import type { Candidate, Position } from "../src/lib/sentinel/types";

const candidate = (mint: string, status = "watching") =>
  ({ mint, status, risks: [], reasoning: "" } as unknown as Candidate);

test("screening rotates across scans, excludes market rejects, open positions and cooldowns", () => {
  const s = initialState();
  s.candidates = ["a", "b", "c", "d", "e"].map(m => candidate(m));
  s.candidates[2].status = "rejected";
  s.positions = [{ mint: "d", status: "open" } as Position];
  const at = Date.now();
  s.cooldowns.e = new Date(at).toISOString();
  assert.deepEqual(assessmentQueue(s, at).map(c => c.mint), ["a", "b"]);
  recordCandidateCheck(s, "a", at);
  assert.deepEqual(assessmentQueue(s, at).map(c => c.mint), ["b", "a"]);
  recordCandidateCheck(s, "b", at + 1);
  assert.deepEqual(assessmentQueue(s, at + 1).map(c => c.mint), ["a", "b"]);
  const restored = normalize(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(assessmentQueue(restored, at + 1).map(c => c.mint), ["a", "b"]);
});

test("entry-floor upgrade is one-time, invalidates ambiguous AI cache and leaves trading controls unchanged", () => {
  const s = initialState();
  delete s.entryEvidenceVersion;
  s.settings.minLiquidityUsd = 20000; s.settings.minVolumeUsd = 250000;
  s.settings.curveMinLiquidityUsd = 5000;
  s.settings.minAiScore = 92; s.settings.maxAiCallsPerDay = 1440;
  s.assessments.test = {} as any;
  const updated = normalize(s);
  assert.equal(updated.settings.minLiquidityUsd, 10000);
  assert.equal(updated.settings.curveMinLiquidityUsd, 10000);
  assert.equal(updated.settings.minVolumeUsd, 100000);
  assert.deepEqual(updated.assessments, {});
  assert.equal(updated.settings.maxAiCallsPerDay, 100);
  for (const key of ["mode", "positionSizeUsd", "maxPositions", "maxEntriesPerDay", "minAiScore", "solReserve"] as const) {
    assert.equal(updated.settings[key], s.settings[key], key);
  }
  assert.equal(updated.running, s.running);
  updated.settings.minVolumeUsd = 200000;
  assert.equal(normalize(updated).settings.minVolumeUsd, 200000, "future user choices must not be overwritten");
});

test("scan summary reports overlapping filter failures instead of implying buy eligibility", () => {
  const a = candidate("a", "rejected"), b = candidate("b", "rejected");
  a.risks = ["24h volume below limit", "Liquidity below limit"];
  b.risks = ["24h volume below limit"];
  assert.equal(scanFilterSummary([a, b, candidate("c")]), "24h volume below limit: 2; Liquidity below limit: 1");
});
