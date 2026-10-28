import { useState } from 'react';
import { Link } from 'wouter';
import { Play, Pause, OctagonAlert, RotateCcw, ScanSearch } from 'lucide-react';
import { useControlBot, useRunScan, BotCommandAction } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useDash, useInvalidateAll, useNow, useSettingsQ } from '@/hooks/use-sentinel';
import { Confirm, Disclosure, Dot, EmptyState, ErrorBlock, Meter, PageHeader, Panel, Pill, Skeleton, Stat } from '@/components/kit';
import { ago, errMsg, signedUsd, stamp, usd } from '@/lib/format';
import { EffectiveTradingRules } from '@/components/effective-trading-rules';

type Act = (typeof BotCommandAction)[keyof typeof BotCommandAction];

function Spark({ pts }: { pts: number[] }) {
  const min = Math.min(...pts), max = Math.max(...pts), r = max - min || 1;
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * 300},${56 - ((v - min) / r) * 52}`).join(' ');
  return <svg viewBox="0 0 300 60" className="h-16 w-full" preserveAspectRatio="none"><polyline points={d} fill="none" stroke="hsl(188 62% 20%)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

export default function Dashboard() {
  const { data: d, isLoading, error, refetch } = useDash();
  const settingsQuery = useSettingsQ();
  const { toast } = useToast();
  const inv = useInvalidateAll();
  const now = useNow();
  const [confirm, setConfirm] = useState<Act | null>(null);
  const done = {
    onSuccess: (r: { success: boolean; message: string }) => { toast({ title: r.success ? 'Done' : 'Not applied', description: r.message, variant: r.success ? undefined : 'destructive' }); inv(); },
    onError: (e: unknown) => toast({ title: 'Command failed', description: errMsg(e), variant: 'destructive' }),
  };
  const ctl = useControlBot({ mutation: done });
  const scan = useRunScan({ mutation: done });
  const run = (action: Act) => { setConfirm(null); ctl.mutate({ data: { action } }); };
  const press = (action: Act) => (action === 'emergency' || action === 'reset-paper' || (action === 'start' && d?.mode === 'live') ? setConfirm(action) : run(action));

  if (isLoading) return <><PageHeader kicker="Overview" title="Dashboard" /><Skeleton rows={6} /></>;
  if (error || !d) return <ErrorBlock error={error} onRetry={() => refetch()} />;
  const next = d.nextScanAt ? Math.max(0, Math.round((new Date(d.nextScanAt).getTime() - now) / 1000)) : null;
  const pts = d.equity.map((p) => p.valueUsd);
  const live = d.mode === 'live';
  const busy = ctl.isPending;

  return (
    <>
      <PageHeader kicker={live ? 'Mainnet · real funds' : 'Paper trading · simulated funds'} title="Dashboard"
        actions={<>
          {d.running
            ? <Button variant="outline" onClick={() => press('pause')} disabled={busy} data-testid="button-pause"><Pause className="h-4 w-4" />Pause entries</Button>
            : <Button onClick={() => press('start')} disabled={busy} data-testid="button-start"><Play className="h-4 w-4" />Start bot</Button>}
          <Button variant="outline" onClick={() => scan.mutate()} disabled={scan.isPending || d.scanning} data-testid="button-run-scan"><ScanSearch className="h-4 w-4" />{d.scanning || scan.isPending ? 'Scanning…' : 'Scan now'}</Button>
          <Button variant="destructive" onClick={() => press('emergency')} disabled={busy} data-testid="button-emergency"><OctagonAlert className="h-4 w-4" />Emergency</Button>
        </>}>
        Pause stops new entries but keeps managing exits. Emergency attempts to close every position, then stops entries.
      </PageHeader>

      <div className="rise mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-card-border bg-card px-4 py-3 text-sm">
        <span className="flex items-center gap-2 font-semibold"><Dot tone={d.running ? 'ok' : 'warn'} live={d.running} />{d.running ? 'Running' : 'Paused'}</span>
        <span className="mono text-xs text-muted-foreground">last scan {ago(d.lastScanAt)}</span>
        <span className="mono text-xs text-muted-foreground">{d.running ? (next !== null ? `next scan in ${next}s` : 'next scan pending') : 'scheduler idle'}</span>
        <span className="mono text-xs text-muted-foreground">worker {ago(d.workerHeartbeatAt)}</span>
        <span className="mono text-xs text-muted-foreground">source: {d.sourceStatus}</span>
        <span className="ml-auto text-xs text-muted-foreground">scans every {d.scanIntervalSeconds}s while running · protective exit checks continue independently, best effort; provider delays apply</span>
      </div>
      {d.running && !!d.entryBlocks?.length && (
        <div role="status" className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <p className="font-semibold">Running — scanning and retrying</p>
          <p className="mt-1">New buys are temporarily blocked, not stopped. No restart is needed when these conditions recover.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">{d.entryBlocks.map(reason => <li key={reason}>{reason}</li>)}</ul>
        </div>
      )}
      {d.lastError && <div className="mb-4"><ErrorBlock error={{ message: `Last error: ${d.lastError}` }} /></div>}

      <div className="mb-4 grid gap-px overflow-hidden rounded-md border border-card-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Equity" value={usd(d.equityUsd)} sub={d.cashSol === null ? 'SOL balance initializes on start' : `${d.cashSol.toFixed(6)} SOL cash · ${usd(d.cashUsd)}`} testid="stat-equity" />
        <Stat label="Realized P&L" value={signedUsd(d.realizedPnlUsd)} tone={d.realizedPnlUsd > 0 ? 'ok' : d.realizedPnlUsd < 0 ? 'bad' : 'mute'} sub={`${d.closedTrades} closed`} testid="stat-realized" />
        <Stat label="Unrealized" value={signedUsd(d.unrealizedPnlUsd)} tone={d.unrealizedPnlUsd > 0 ? 'ok' : d.unrealizedPnlUsd < 0 ? 'bad' : 'mute'} sub={`${d.openPositions} open`} testid="stat-unrealized" />
        <Stat label="Token checks" value={d.candidatesScanned} sub="Includes repeat scans; not unique tokens or buy signals" testid="stat-scanned" />
      </div>

      <div className="mb-4">
        {settingsQuery.data ? <EffectiveTradingRules settings={settingsQuery.data} equityUsd={d.equityUsd} />
          : settingsQuery.error ? <ErrorBlock error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} />
            : <p className="text-sm text-muted-foreground">Loading effective trading rules…</p>}
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-4">
          <Panel title="Guard rails">
            <div className="space-y-4">
              <div><div className="mb-1.5 flex justify-between text-sm"><span>Daily loss</span><span className="mono">{usd(d.dailyLossUsd)} / {usd(d.dailyLossLimitUsd)}</span></div><Meter value={d.dailyLossUsd} max={d.dailyLossLimitUsd} /></div>
              <div><div className="mb-1.5 flex justify-between text-sm"><span>AI calls today (daily budget)</span><span className="mono">{d.aiCallsToday} / {d.aiCallLimit}</span></div><Meter value={d.aiCallsToday} max={d.aiCallLimit} /></div>
              <p className="text-xs text-muted-foreground">Paid AI at most every {d.aiIntervalMinutes}m · reuse similar evidence for {d.aiCacheMinutes}m · last request {ago(d.lastAiAt)}. Filters and cache hits do not call AI. The score is not a win probability.</p>
              <p className="text-xs text-muted-foreground">Native SOL settlement · protected reserve {d.reserveSol} SOL. No browser-wallet connection or USDC balance needed. Change schedules in <Link href="/strategy" className="text-primary underline">Strategy</Link>.</p>
            </div>
          </Panel>
          <Panel title="Equity">
            {pts.length >= 2 ? <Spark pts={pts} /> : <p className="text-sm text-muted-foreground">No equity curve yet. A chart appears only once the backend reports at least two equity points.</p>}
          </Panel>
          <Panel title="Mainnet readiness" aside={<Pill tone={d.liveReady ? 'ok' : 'warn'}>{d.liveReady ? 'Ready' : `${d.blockers.length} blocker${d.blockers.length === 1 ? '' : 's'}`}</Pill>}>
            {d.blockers.length === 0 ? <p className="text-sm text-muted-foreground">No blockers reported{d.walletAddress ? <> · wallet <span className="mono">{d.walletAddress}</span></> : ''}.</p> : (
              <ul className="space-y-1.5 text-sm">{d.blockers.map((b, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />{b}</li>)}</ul>
            )}
            <Link href="/setup" className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline" data-testid="link-setup">Open setup guide</Link>
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel title="Recent activity" aside={<Link href="/activity" className="text-xs font-medium text-primary hover:underline" data-testid="link-all-activity">All</Link>} pad={false}>
            {d.recentActivity.length === 0 ? <div className="p-4"><EmptyState title="Nothing logged yet">Decisions to buy, skip or sell are recorded here with the reason.</EmptyState></div> : (
              <ul className="divide-y divide-border">{d.recentActivity.slice(0, 10).map((a) => (
                <li key={a.id} className="rowrail px-4 py-2.5 text-sm"><div className="mono flex items-center gap-2 text-[10.5px] text-muted-foreground"><Dot tone={a.level === 'error' ? 'bad' : a.level === 'warning' ? 'warn' : a.level === 'success' ? 'ok' : 'mute'} />{stamp(a.time)} · {a.category}</div><p className="mt-0.5">{a.message}</p></li>
              ))}</ul>
            )}
          </Panel>
          <Panel title="Read this before enabling"><Disclosure /></Panel>
        </div>
      </div>

      <Confirm open={confirm === 'emergency'} onOpenChange={(o) => !o && setConfirm(null)} title="Trigger emergency stop?" confirmLabel="Close all and stop" danger onConfirm={() => run('emergency')}>
        <p>Sentinel will attempt to close every open position, then stop new entries.</p><p>Exits can fail or fill at poor prices in thin liquidity. Check Positions afterwards.</p>
      </Confirm>
      <Confirm open={confirm === 'start'} onOpenChange={(o) => !o && setConfirm(null)} title="Start on mainnet?" confirmLabel="Start with real funds" danger onConfirm={() => run('start')}>
        <p>The server-held burner key signs native SOL → token buys and token → SOL sells without browser approvals. The wallet must retain its configured SOL reserve. Fees and account rent affect actual wallet movements.</p><p>AI usage and hosting are charged separately. No outcome is guaranteed; you can lose the entire dedicated wallet balance.</p>
      </Confirm>
      <Confirm open={confirm === 'reset-paper'} onOpenChange={(o) => !o && setConfirm(null)} title="Reset paper account?" confirmLabel="Reset paper" onConfirm={() => run('reset-paper')}>
        <p>Paper cash and history return to the starting balance. Refused if any position is open.</p>
      </Confirm>
      {!live && (
        <div className="mt-4"><Button variant="ghost" size="sm" onClick={() => press('reset-paper')} disabled={busy} data-testid="button-reset-paper"><RotateCcw className="h-3.5 w-3.5" />Reset paper account</Button></div>
      )}
    </>
  );
}
