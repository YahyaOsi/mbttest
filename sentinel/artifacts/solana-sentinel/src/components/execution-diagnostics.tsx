import { useGetSentinelDiagnostics } from '@workspace/api-client-react';
import { Panel } from '@/components/kit';

const money = (v: unknown) => typeof v === 'number' ? `$${v.toFixed(2)}` : '—';
export function ExecutionDiagnostics() {
  const q = useGetSentinelDiagnostics({ query: { refetchInterval: 30000 } });
  return <Panel title="Execution health & durable funnel">
    {q.isLoading ? <p>Loading diagnostics…</p> : q.error ? <p role="alert">Diagnostics unavailable. Trading controls are unchanged.</p> : q.data ? <>
      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <p>Equity <strong>{money(q.data.risk.equityUsd)}</strong></p>
        <p>Open risk estimate <strong>{money(q.data.risk.openRiskUsd)}</strong></p>
        <p>Daily loss remaining <strong>{money(q.data.risk.dailyLossRemainingUsd)}</strong></p>
        <p>Primary <strong>{q.data.rpc.primaryAvailable ? 'Available' : 'Unavailable / cooling'}</strong>{!q.data.rpc.primaryVerified && ' · unverified'}</p>
        <p>Balance failures / attempts <strong>{String(q.data.rpc.balanceFailures)} / {String(q.data.rpc.balanceAttempts)}</strong></p>
        <p>Read failovers <strong>{String(q.data.rpc.failoverReads)}</strong></p>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">RPC counters cover this process lifetime. Funnel counts below cover the last 24 hours of the new durable journal, not older rolling history. Open risk is a stop-distance estimate, not a loss guarantee.</p>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        {Object.entries(q.data.pipeline).map(([k, v]) => <span key={k}>{k}: <strong>{String(v)}</strong></span>)}
      </div>
      <div className="mt-3 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>24-hour event</th><th>Count</th></tr></thead><tbody>
        {q.data.funnel.map((r, i) => <tr key={i}><td className="py-1">{String(r.kind)}{r.policy ? ` · ${String(r.policy)}` : ''}</td><td>{String(r.count)}</td></tr>)}
      </tbody></table></div>
      <details className="mt-3"><summary className="cursor-pointer text-sm">Latest 50 durable decisions and orders</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify(q.data.recent, null, 2)}</pre>
      </details>
    </> : null}
  </Panel>;
}
