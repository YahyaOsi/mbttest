import { randomUUID } from "node:crypto";
import type { State, Candidate } from "./types";

type Sample = { id: string; time: string; kind: string; mint: string | null; data: Record<string, unknown> };
const queues = new WeakMap<State, Sample[]>();
export function metric(s: State, kind: string, mint: string | null, data: Record<string, unknown>) {
  const queue = queues.get(s) ?? [];
  queue.push({ id: randomUUID(), time: new Date().toISOString(), kind, mint,
    data: { policy: s.settings.pumpHuntEnabled && s.settings.riskMode === "crazy" ? "pump-hunt" : "standard", ...data } });
  queues.set(s, queue);
}
export function decisionMetric(s: State, c: Candidate, outcome: string, reason = c.reasoning) {
  metric(s, "candidate", c.mint, { outcome, reason: reason.slice(0, 1500), liquidityUsd: c.liquidityUsd,
    top10Pct: c.observedTop10Pct ?? null, curveProgressPct: c.curveProgressPct ?? null,
    confidence: c.confidenceScore ?? null, scoreReasons: c.confidenceReasons ?? [],
    burst: c.confidenceReasons?.some(r => r.startsWith("burst=") && Number(r.split("=")[1]) > 0) ?? null,
    buys5m: c.buys5m, sells5m: c.sells5m, volume5mUsd: c.volume5mUsd ?? null,
    missingEvidence: c.missingMarketData ?? [],
    aiScore: c.score, marketAgeMs: Date.now() - Date.parse(c.updatedAt) });
}
/** Called inside the same DB transaction as the account snapshot. Retries are
 * idempotent; no telemetry loss on a partial save and no duplicate dispatch. */
export async function flushMetrics(s: State, userId: string, query: (sql: string, values: any[]) => Promise<unknown>) {
  const rows = queues.get(s) ?? [];
  if (!rows.length) return;
  await query(`INSERT INTO sentinel_diagnostics(id,user_id,time,kind,mint,data)
    SELECT r.id,$1,r.time::timestamptz,r.kind,r.mint,r.data
    FROM jsonb_to_recordset($2::jsonb) AS r(id text,time text,kind text,mint text,data jsonb)
    ON CONFLICT(id) DO NOTHING`, [userId, JSON.stringify(rows)]);
}
export function metricsSaved(s: State) { queues.delete(s); }
