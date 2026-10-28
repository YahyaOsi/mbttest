import {
  useGetHighRiskStatus, getGetHighRiskStatusQueryKey, type TradingSettings,
} from '@workspace/api-client-react';
import { ErrorBlock, Panel, Pill, Skeleton } from '@/components/kit';

type Strat = NonNullable<TradingSettings['crazyStrategy']>;
const STRATS: { id: Strat; label: string; body: string }[] = [
  { id: 'sniper', label: 'Sniper', body: 'Pool no older than 5 minutes, with recent buying and verified mint/holder checks. Supported executable venues and enabled native curves can qualify; LP burn proof is not required.' },
  { id: 'momentum', label: 'Momentum', body: 'Can qualify on the first observation: at least $500 five-minute USD volume, 10 buys, 1.3× buy/sell bias and a +2% to +40% price move. Alternatively, a 1.3× observed volume breakout with positive buying. No AI score or win-probability claim.' },
  { id: 'dip', label: 'Dip hunter', body: 'Observes a 30% drop, then waits for a 5–15% recovery rather than buying a falling price. New Crazy fills sell half at +100% net SOL gain, then trail the sellable remainder by 15%; loss and liquidity-drop protections remain.' },
  { id: 'whale', label: 'Whale copy', body: 'Manual Copy Trade watches configured wallet targets without public FOMO polling. Track FOMO & User Handles separately enables linked X/FOMO targets and the independent top-10 FOMO leaderboard in Crazy Mode. Dedicated secondary wallet WebSockets require acknowledged subscriptions; no wallet-history polling. Confirmed transactions verify signer, swap and SOL settlement. Delivery is best effort, not guaranteed instant. Maximum chase 15%, per-wallet allocation cap, and demotion after 3 losing copies remain. Existing copy exits stay monitored when new tracking is off. Background discovery runs every 2 minutes.' },
];
const input = 'h-9 w-full rounded-md border border-input bg-background px-2.5 mono text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20';
const short = (w: string) => (w.length > 11 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

function Num({ id, label, min, max, step, value, onSet }: { id: string; label: string; min: number; max: number; step: number; value: number; onSet: (n: number) => void }) {
  const bad = !Number.isFinite(value) || value < min || value > max;
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-xs font-medium"><span>{label}</span><span className="mono text-[10px] text-muted-foreground">{min}–{max} %</span></span>
      <input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ''} aria-invalid={bad}
        onChange={(e) => onSet(e.target.value === '' ? NaN : Number(e.target.value))} data-testid={`input-${id}`} className={`${input} mt-1 ${bad ? 'border-destructive' : ''}`} />
      {bad && <span role="alert" className="text-[11px] text-destructive">Must be between {min} and {max}</span>}
    </label>
  );
}

export function HighRiskSettings({ form, onChange }: { form: TradingSettings; onChange: (next: TradingSettings) => void }) {
  const risk = form.riskMode ?? 'conservative';
  const eq = form.normalEquityPct ?? 8;
  const top10 = form.crazyTop10Pct ?? 30;
  const alloc = form.crazyWalletAllocationPct ?? 20;
  const ack = form.crazyAcknowledged ?? false;
  const crazy = risk === 'crazy';
  const q = useGetHighRiskStatus({ query: { enabled: crazy, queryKey: getGetHighRiskStatusQueryKey(), refetchInterval: 15000 } });
  const st = q.data;
  const set = (p: Partial<TradingSettings>) => onChange({ ...form, ...p });

  return (
    <Panel title="Risk mode" className="mb-4" aside={crazy ? <Pill tone="bad">High risk</Pill> : <Pill tone="info">Current strategy</Pill>}>
      <div role="radiogroup" aria-label="Risk mode" className="grid gap-2 sm:grid-cols-2">
        {([['conservative', 'Conservative', 'Your current strategy, unchanged. This is the default.'], ['crazy', 'Crazy (High risk)', 'Faster, speculative entries using deterministic signals. Can lose the whole position.']] as const).map(([id, t, d]) => (
          <button key={id} type="button" role="radio" aria-checked={risk === id} onClick={() => set({ riskMode: id, ...(id === 'crazy' ? { crazyStrategy: 'all' as const } : {}) })} data-testid={`risk-${id}`}
            className={`press rounded-md border p-3 text-left ${risk === id ? (id === 'crazy' ? 'border-destructive bg-[hsl(8_70%_96%)]' : 'border-primary bg-primary/5') : 'border-border bg-card'}`}>
            <span className="block text-sm font-semibold">{t}</span><span className="block text-xs text-muted-foreground">{d}</span>
          </button>))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Nothing changes until you press Save on this page.</p>

      {crazy && (
        <div className="mt-4 space-y-4">
          <div className="text-xs leading-relaxed text-muted-foreground">
            <p>Deterministic entries with optional advisory AI. Mint/freeze, extensions, creator and holder checks stay on. {form.pumpHuntEnabled ? 'Pump hunt prefers $600 reserves, allowing $400–$600 only with strong activity; observed top-10 ceiling is 40%, scored down above 30%. Hunt snipes can be up to 10 minutes old.' : 'Ordinary Crazy defaults to $1,000 real reserves and a 25% top-10 ceiling.'} The 24h-volume floor is off by default. Active verified curves need no traditional LP lock. Ordinary pools still need permanent on-chain LP protection. Daily loss, SOL reserve and pending-order protection remain active.</p>
            <p className="mt-2">Normal position is {eq}% of current equity; high-confidence snipes may use up to {form.snipeEquityPct ?? 15}%. Discovery runs every 2 minutes and watchlist AI every 5 minutes on secondary RPCs. Deterministic checks continue at budget exhaustion. Verified secondary wallet/safety read failover is separate from primary-only broadcast and reconciliation. Entry screening never guarantees success.</p>
            <p className="mt-2">You control Start/Stop; the requested 5× starting USD-equity goal also stops scanning/new entries while protective exits continue. Errors, unresolved transactions and the daily loss limit can block new buys, but scanning and recovery retries stay on. A service outage can still interrupt operation; no software can guarantee uninterrupted execution.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              ['crazyMinLiquidityUsd', 'Preferred liquidity (USD)', form.pumpHuntEnabled ? 400 : 1000, 100000000, 100, form.pumpHuntEnabled ? 600 : 1000],
              ['crazyMinVolumeUsd', 'Minimum 24h volume (USD; 0 = off)', 0, 100000000, 1000, 0],
              ['crazyMaxPositions', 'Maximum open positions', 1, 5, 1, 3],
              ['crazySlippageBps', 'Slippage cap (bps; 1000 = 10%)', 100, 1500, 50, 1000],
            ] as const).map(([key, label, min, max, step, fallback]) => (
              <label key={key} className="block text-xs font-medium">
                {label}
                <input type="number" className={`${input} mt-1`} min={min} max={max} step={step}
                  value={Number.isFinite(form[key] ?? fallback) ? form[key] ?? fallback : ''}
                  data-testid={`input-${key}`}
                  onChange={e => set({ [key]: e.target.value === '' ? NaN : Number(e.target.value) })} />
              </label>
            ))}
          </div>

          <fieldset>
            <legend className="text-xs font-medium">All four strategies run together</legend>
            <div role="list" aria-label="Concurrent high-risk strategies" className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {STRATS.map((s) => (
                <div key={s.id} role="listitem" data-testid={`crazy-${s.id}`} className="rounded-md border border-primary/30 bg-primary/5 p-3">
                  <div className="flex items-center justify-between gap-2"><span className="mono text-xs uppercase tracking-wider">{s.label}</span><Pill tone="info">Enabled</Pill></div>
                  <p className="mt-2 text-xs text-muted-foreground">{s.body}</p>
                </div>))}
            </div>
            <p className="mt-2 text-sm text-muted-foreground" data-testid="text-crazy-strategy">All four strategies run together. Parallel screening, one order at a time, no duplicate mint positions. No daily trade-count cap; the daily loss stop and SOL reserve remain active.</p>
            <p className="mt-1 text-xs text-muted-foreground">New positions snapshot the configured profit tiers and holdback. Adaptive exits add an early profit tier, tighten the trail after large moves and use a bounded volatility stop. Existing positions keep their own plans. No guaranteed exit price.</p>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-3">
            <p className="text-xs text-muted-foreground">Entry percentages are configured in Reliability & equity-aware risk below.</p>
            <Num id="crazyTop10Pct" label="Max top-10 holders" min={1} max={50} step={1} value={top10} onSet={(n) => set({ crazyTop10Pct: n })} />
            <Num id="crazyWalletAllocationPct" label="Per-wallet allocation" min={1} max={30} step={1} value={alloc} onSet={(n) => set({ crazyWalletAllocationPct: n })} />
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" checked={ack} onChange={(e) => set({ crazyAcknowledged: e.target.checked })} data-testid="check-crazy-ack" className="mt-1 h-4 w-4 accent-[hsl(188_62%_20%)]" />
            <span>I understand high-risk mode is speculative, can lose the entire position, and guarantees nothing. Fees, slippage and failed exits are possible.</span>
          </label>
          {!ack && <p role="alert" className="text-sm text-destructive" data-testid="text-crazy-ack-required">Acknowledgement is required to save high-risk mode.</p>}

          <div className="border-t border-border pt-3" aria-live="polite">
            <h3 className="mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Live status</h3>
            {q.isLoading ? <div className="mt-2"><Skeleton rows={3} /></div>
              : q.error || !st ? <div className="mt-2"><ErrorBlock error={q.error} onRetry={() => q.refetch()} /></div>
              : (
                <div className="mt-2 space-y-2 text-sm" data-testid="status-high-risk">
                  <p className="text-xs text-muted-foreground">Source: <span className="mono">{st.source}</span> · Status: <span className="mono">{st.status}</span> · Updated: <span className="mono">{st.updatedAt ? new Date(st.updatedAt).toLocaleString() : 'never'}</span></p>
                  <p>Projected position: <span className="mono font-medium" data-testid="text-projected-size">${st.positionSizeUsd.toFixed(2)}</span> <span className="text-xs text-muted-foreground">(saved equity percentage; no dollar cap)</span></p>
                  {st.notices.length > 0 && <ul className="list-disc pl-5 text-xs text-muted-foreground">{st.notices.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                  {st.leaders.length === 0 ? <p className="text-xs text-muted-foreground">No leader wallets reported.</p> : (
                    <ul className="divide-y divide-border rounded-md border border-border">
                      {st.leaders.map((l) => (
                        <li key={l.wallet} data-testid={`row-leader-${l.rank}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                          <span className="mono w-6 text-muted-foreground">#{l.rank}</span>
                          <span className="font-medium">{l.handle}</span>
                          <span className="mono text-muted-foreground" title={l.wallet}>{short(l.wallet)}</span>
                          <span className="ml-auto mono">{l.losingCopies} losing</span>
                          <span className="mono">${l.allocatedUsd.toFixed(2)}</span>
                          {l.demoted && <Pill tone="warn">Demoted</Pill>}
                        </li>))}
                    </ul>)}
                </div>)}
          </div>
        </div>
      )}
    </Panel>
  );
}
