import { Fragment, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, Search, ScanSearch, Sparkles } from 'lucide-react';
import { useAnalyzeToken, useRunScan, getGetCandidatesQueryKey, type Candidate } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useCands, useDash, useInvalidateAll, useNow } from '@/hooks/use-sentinel';
import { Disclosure, EmptyState, ErrorBlock, PageHeader, Panel, Pill, Skeleton, type Tone } from '@/components/kit';
import { age, ago, compact, errMsg, pct, price } from '@/lib/format';
import { useScannerPage } from '@/hooks/use-scanner-page';

export const statusTone: Record<string, Tone> = { eligible: 'ok', watching: 'info', rejected: 'mute', error: 'bad', discovered: 'warn' };
const fmtLeft = (ms: number) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

export function WatchClock({ c, now }: { c: Candidate; now: number }) {
  if (c.permanentlyRejectedAt) return <span className="mono text-[11px] text-[hsl(8_68%_40%)]" data-testid={`text-rejected-${c.mint}`}>Rejected {ago(c.permanentlyRejectedAt)}</span>;
  if (!c.watchExpiresAt) return <span className="mono text-[11px] text-muted-foreground">Not staged</span>;
  const exp = new Date(c.watchExpiresAt).getTime(); const start = c.watchStartedAt ? new Date(c.watchStartedAt).getTime() : exp - 900000;
  const left = exp - now; const frac = Math.min(1, Math.max(0, left / Math.max(1, exp - start)));
  if (left <= 0) return <span className="mono text-[11px] text-muted-foreground" data-testid={`text-expired-${c.mint}`}>Window expired</span>;
  return (
    <div className="min-w-[72px]" data-testid={`text-countdown-${c.mint}`}>
      <span className="mono text-[12px] font-semibold tabular-nums">{fmtLeft(left)}</span>
      <div className="mt-1 h-1 w-full bg-muted"><div className="h-1 origin-left bg-primary transition-transform duration-1000 ease-linear" style={{ transform: `scaleX(${frac})` }} /></div>
    </div>
  );
}

function LiveWatchClock({ c }: { c: Candidate }) {
  const now = useNow(1000);
  return <WatchClock c={c} now={now} />;
}

const chg = (n: number) => <span className={n > 0 ? 'text-[hsl(150_45%_28%)]' : n < 0 ? 'text-[hsl(8_68%_40%)]' : ''}>{pct(n)}</span>;

export function Evidence({ c }: { c: Candidate }) {
  return (
    <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
      <div>
        <p className="mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">Reasoning</p>
        <p className="mt-1 text-sm leading-relaxed">{c.reasoning || 'No analysis recorded yet. Analyze enrolls a 15-minute watch and may spend one AI call from the shared daily budget.'}</p>
        <p className="mono mt-3 break-all text-[11px] text-muted-foreground">{c.mint}</p>
        <p className="mt-2 text-xs text-muted-foreground">Source: {c.discoverySource ?? 'DEX Screener'} · Launchpad: {c.launchpad ?? 'not reported'} · Venue: {c.venue ?? 'not reported'} · Market cap: {c.marketCapUsd == null ? 'unknown' : compact(c.marketCapUsd)} · Organic activity: {c.organicScore == null ? 'unknown' : `${c.organicScore.toFixed(1)}/100`}</p>
        {c.marketDataStatus === 'awaiting_market_data' && <p className="mt-2 text-sm text-amber-700" data-testid={`missing-market-${c.mint}`}>Awaiting market data: {c.missingMarketData?.join(', ') || 'unavailable'}. Analysis and entries are blocked; a verified creation is not safety clearance.</p>}
        <p className="mt-1 break-all text-xs text-muted-foreground">Token program (provider-reported): {c.tokenProgram ?? 'checked on-chain before entry'}. Launchpad labels are not safety endorsements.</p>
      </div>
      <div>
        <p className="mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">Risks flagged</p>
        {c.risks.length ? <ul className="mt-1 space-y-1 text-sm">{c.risks.map((r, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-destructive" />{r}</li>)}</ul> : <p className="mt-1 text-sm text-muted-foreground">None recorded. That is not a clearance.</p>}
        <p className="mono mt-3 text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">Scheduled AI evaluation</p>
        <p className="mt-1 text-sm" data-testid={`text-ai-sweep-${c.mint}`}>{c.aiSweepReason?.startsWith('Deterministic budget fallback') ? c.aiSweepReason : c.lastAiSweepAt ? <>Last evaluated {ago(c.lastAiSweepAt)}. {c.aiSweepReason || 'No reasoning returned.'}</> : 'Not yet evaluated by a scheduled sweep.'}</p>
        <p className="mono mt-3 text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">Liquidity evidence</p>
        {c.lpVerification ? <p className="mt-1 break-all text-xs" data-testid={`text-lp-${c.mint}`}>LP {c.lpVerification.protectedPct.toFixed(2)}% burned or inaccessible, independently verified {ago(c.lpVerification.verifiedAt)} · pool {c.lpVerification.pool} · program {c.lpVerification.program}</p>
          : c.launchpadVerification && c.launchpadVerification.phase !== 'graduated' ? <p className="mt-1 break-all text-xs" data-testid={`text-curve-${c.mint}`}>Native curve ({c.launchpadVerification.phase ?? 'unknown phase'}) verified {ago(c.launchpadVerification.verifiedAt)} · program {c.launchpadVerification.program}{c.curveProgressPct != null ? ` · progress ${c.curveProgressPct.toFixed(1)}%` : ''}. Active curves need no traditional LP lock.</p>
          : <p className="mt-1 text-xs text-muted-foreground">No verified LP burn or native curve evidence. Entries stay blocked; provider lock badges are not accepted.</p>}
        <p className="mt-3 text-xs text-muted-foreground">On-chain safety checks: {c.safetyChecked ? 'completed' : 'not run yet'} · updated {ago(c.updatedAt)}</p>
        <a href={c.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" data-testid={`link-market-${c.mint}`}>Market page <ExternalLink className="h-3 w-3" /></a>
      </div>
    </div>
  );
}

export default function Scanner() {
  const { data, isLoading, error, refetch } = useCands();
  const { data: d } = useDash();
  const qc = useQueryClient();
  const inv = useInvalidateAll();
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [st, setSt] = useState('all');
  const [tab, setTab] = useState<'all' | 'watching' | 'rejected'>(() => (localStorage.getItem('scanner-tab') as 'all' | 'watching' | 'rejected') || 'all');
  const pickTab = (t: 'all' | 'watching' | 'rejected') => { setTab(t); localStorage.setItem('scanner-tab', t); };
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const analyze = useAnalyzeToken({
    mutation: {
      onSuccess: (c) => {
        qc.setQueryData<Candidate[]>(getGetCandidatesQueryKey(), (old) => old?.map((x) => (x.mint === c.mint ? c : x)));
        setOpen(c.mint); inv();
        toast({ title: `${c.symbol} enrolled for 15-minute watch`, description: c.score === null ? 'No score yet. This does not buy.' : `Evidence score ${c.score}/100. This does not buy.` });
      },
      onError: (e) => toast({ title: 'Analysis failed', description: errMsg(e), variant: 'destructive' }),
    },
  });
  const scan = useRunScan({
    mutation: { onSuccess: (r) => { toast({ title: r.success ? 'Scan requested' : 'Scan not run', description: r.message }); inv(); }, onError: (e) => toast({ title: 'Scan failed', description: errMsg(e), variant: 'destructive' }) },
  });
  const PAGE = 50;
  const { shown, total, pages, pg, counts, busy, workerError } = useScannerPage(data, { q, status: st, tab, page });
  useEffect(() => { setPage(0); }, [q, st, tab]);
  const budget = d ? d.aiCallLimit - d.aiCallsToday : null;

  return (
    <>
      <PageHeader kicker="Discovery" title="Scanner"
        actions={<Button variant="outline" onClick={() => scan.mutate()} disabled={scan.isPending} data-testid="button-scan"><ScanSearch className="h-4 w-4" />{scan.isPending ? 'Scanning…' : 'Scan now'}</Button>}>
        Background discovery runs every 2 minutes by default; live signals can request immediate screening. Coverage is not exhaustive. AI sweeps discovery every 10 minutes and active watches every 5 minutes, sharing {d ? `${d.aiCallLimit}` : '100'} requests per day{budget !== null ? ` (${Math.max(0, budget)} left today)` : ''}. AI is advisory in Crazy Mode, not a hard veto. Hard safety ceilings and the original 15-minute watch deadline remain. Deterministic checks continue at budget exhaustion. Qualifying first-scan tokens need not wait for AI. AI has no social or web search access.
      </PageHeader>
      <Panel title="Enroll any Solana token" className="mb-4">
        <p className="text-sm text-muted-foreground">Paste a contract address to stage it on a persistent 15-minute watch. Enrolling never buys by itself; an automatic entry can happen later only while you have started the bot and every guard passes, including daily loss protection. Active verified Pump.fun and Moonit curves use native curve evidence and need no traditional LP lock. Supported Raydium SOL pools require independently verified burned or permanently inaccessible LP. Unsupported lock protocols stay blocked regardless of provider badges.</p>
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={e => {
          e.preventDefault();
          const mint = String(new FormData(e.currentTarget).get('mint') ?? '').trim();
          if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) analyze.mutate({ mint });
          else toast({ title: 'Enter a valid Solana mint address', variant: 'destructive' });
        }}>
          <input name="mint" aria-label="Solana mint address to analyze" placeholder="Paste any Solana token contract address" data-testid="input-mint-lookup" required minLength={32} maxLength={128} className="h-9 min-w-0 flex-1 rounded-md border border-input bg-card px-3 text-sm" />
          <Button type="submit" variant="outline" disabled={analyze.isPending} data-testid="button-mint-lookup">{analyze.isPending ? 'Enrolling…' : 'Enroll and watch'}</Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">Enrollment persists for 15 minutes, then the token is kept or rejected with a recorded reason. Exact mint identity matters—not a “pump” or “BAGS” suffix.</p>
      </Panel>
      <div className="mb-3 flex gap-5 border-b border-border" role="tablist">{(['all', 'watching', 'rejected'] as const).map((t) => {
        const n = counts[t];
        return <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => pickTab(t)} data-testid={`tab-${t}`} className={`mono -mb-px border-b-2 px-1 pb-2 text-[11px] uppercase tracking-[0.14em] ${tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{t} <span className="tabular-nums opacity-70">{n}</span></button>;
      })}</div>
      <div className="mb-3 flex flex-wrap gap-2">
        <label className="relative min-w-[200px] flex-1"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Symbol, name or mint" data-testid="input-search" className="h-9 w-full rounded-md border border-input bg-card pl-8 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" /></label>
        <div className="flex gap-1 overflow-x-auto">{['all', 'observed', 'awaiting-market', 'active-watch', 'eligible', 'rejected-permanent', 'order-attempted', 'filled'].map((s) => (
          <button key={s} type="button" onClick={() => setSt(s)} data-testid={`filter-${s}`} className={`press mono rounded-md border px-2.5 py-1.5 text-[11px] uppercase tracking-wider ${st === s ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}>{s}</button>))}</div>
      </div>
      {busy && <p role="status" className="mb-2 text-xs text-muted-foreground">Updating scanner display…</p>}
      {workerError ? <ErrorBlock error={workerError} /> : isLoading || (busy && !shown.length) ? <Skeleton rows={8} /> : error ? <ErrorBlock error={error} onRetry={() => refetch()} /> : total === 0 ? (
        <EmptyState title={data?.length ? 'No tokens match these filters' : 'No candidates discovered yet'}>{data?.length ? 'Clear the search or status filter.' : tab === 'all' ? 'Candidates appear after a scan completes, or enroll a contract address above.' : tab === 'watching' ? 'Nothing staged. Enroll a contract address to start a 15-minute watch.' : 'No rejections recorded.'}</EmptyState>
      ) : (
        <div className="rise rounded-md border border-card-border bg-card"><div className="overflow-x-auto">
          <table className="w-full min-w-[940px] text-sm">
            <thead><tr className="mono border-b border-border text-left text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
              {['Token', 'Price', 'Liquidity', 'Vol 24h', '5m', '24h', 'Age', 'Buys/Sells 5m', 'Status', 'Watch', 'Evidence', ''].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {shown.map((c) => {
                const on = open === c.mint; const busy = analyze.isPending && analyze.variables?.mint === c.mint;
                return (
                  <Fragment key={c.mint}>
                    <tr className="rowrail cursor-pointer border-b border-border/70" onClick={() => setOpen(on ? null : c.mint)} data-testid={`row-candidate-${c.mint}`}>
                      <td className="px-3 py-2.5"><div className="flex items-center gap-2"><ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${on ? 'rotate-90' : ''}`} />
                        {c.imageUrl ? <img src={c.imageUrl} alt="" loading="lazy" decoding="async" className="h-6 w-6 rounded-sm object-cover" /> : <span className="grid h-6 w-6 place-items-center rounded-sm bg-muted text-[10px] font-bold">{c.symbol.slice(0, 2)}</span>}
                        <div><div className="font-semibold">{c.symbol}</div><div className="max-w-[130px] truncate text-[11px] text-muted-foreground">{c.name}</div><div className="max-w-[130px] truncate text-[10px] text-muted-foreground">{c.launchpad ?? c.venue ?? 'Solana'}</div></div></div></td>
                      <td className="mono px-3">{c.missingMarketData?.includes('price') ? 'Unknown' : price(c.priceUsd)}</td><td className="mono px-3">{c.missingMarketData?.includes('liquidity') ? 'Unknown' : compact(c.liquidityUsd)}</td><td className="mono px-3">{c.missingMarketData?.includes('volume') ? 'Unknown' : compact(c.volume24hUsd)}</td>
                      <td className="mono px-3">{c.missingMarketData?.includes('priceChange') ? 'Unknown' : chg(c.change5mPct)}</td><td className="mono px-3">{c.marketDataStatus === 'awaiting_market_data' ? 'Unknown' : chg(c.change24hPct)}</td><td className="mono px-3">{c.missingMarketData?.includes('age') ? 'Unknown' : age(c.ageMinutes)}</td>
                      <td className="mono px-3">{c.missingMarketData?.includes('activity') ? 'Unknown' : `${c.buys5m}/${c.sells5m}`}</td>
                      <td className="px-3"><Pill tone={c.pipelineStatus === 'active-watch' ? 'warn' : statusTone[c.status] ?? 'mute'}>{c.pipelineStatus ?? c.status}</Pill></td>
                      <td className="px-3"><LiveWatchClock c={c} /></td>
                      <td className="mono px-3">{c.score === null ? <span className="text-muted-foreground">unscored</span> : <span className="font-semibold">{c.score}<span className="text-muted-foreground">/100</span></span>}</td>
                      <td className="px-3 text-right"><Button size="sm" variant="outline" disabled={busy || c.marketDataStatus === 'awaiting_market_data'} onClick={(e) => { e.stopPropagation(); analyze.mutate({ mint: c.mint }); }} data-testid={`button-analyze-${c.mint}`}><Sparkles className="h-3.5 w-3.5" />{busy ? 'Analyzing…' : 'Analyze'}</Button></td>
                    </tr>
                    {on && <tr className="border-b border-border bg-muted/40"><td colSpan={12} className="px-6 py-4"><Evidence c={c} /></td></tr>}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground" data-testid="pagination-scanner">
          <span data-testid="text-page-range">Showing {pg * PAGE + 1}–{Math.min(total, (pg + 1) * PAGE)} of {total} matching ({data?.length ?? 0} known). Display paging only; it does not limit what the scanner tracks.</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={pg === 0} onClick={() => setPage(pg - 1)} data-testid="button-page-prev">Previous</Button>
            <span className="mono tabular-nums" data-testid="text-page">{pg + 1} / {pages}</span>
            <Button size="sm" variant="outline" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)} data-testid="button-page-next">Next</Button>
          </div>
        </div>
        </div>
      )}
      <div className="mt-4"><Disclosure /></div>
    </>
  );
}
