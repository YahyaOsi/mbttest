import { useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { useClosePosition, useRefreshWalletBalances, type Position } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useInvalidateAll, usePositionsQ } from '@/hooks/use-sentinel';
import { Confirm, Disclosure, EmptyState, ErrorBlock, PageHeader, Pill, Skeleton, type Tone } from '@/components/kit';
import { ago, errMsg, pct, price, shortMint, signedUsd } from '@/lib/format';

const tone: Record<string, Tone> = { open: 'info', pending: 'warn', closed: 'mute', error: 'bad', retained: 'info', transferred: 'mute' };
const pnl = (n: number) => (n > 0 ? 'text-[hsl(150_45%_28%)]' : n < 0 ? 'text-[hsl(8_68%_40%)]' : '');

export default function Positions() {
  const { data, isLoading, error, refetch } = usePositionsQ();
  const inv = useInvalidateAll();
  const { toast } = useToast();
  const [tab, setTab] = useState<'open' | 'history'>('open');
  const [target, setTarget] = useState<Position | null>(null);
  const close = useClosePosition({
    mutation: {
      onSuccess: (r) => { toast({ title: r.success ? 'Close submitted' : 'Close not completed', description: r.message, variant: r.success ? undefined : 'destructive' }); inv(); },
      onError: (e) => toast({ title: 'Close failed', description: errMsg(e), variant: 'destructive' }),
    },
  });
  const refresh = useRefreshWalletBalances({
    mutation: {
      onSuccess: r => { toast({ title: 'Wallet refreshed', description: r.message }); inv(); },
      onError: e => toast({ title: 'Refresh failed — previous balances preserved', description: errMsg(e), variant: 'destructive' }),
    },
  });
  const all = data ?? [];
  const openRows = all.filter((p) => ['open', 'pending', 'retained'].includes(p.status));
  const hist = all.filter((p) => ['closed', 'error', 'transferred'].includes(p.status));
  const rows = tab === 'open' ? openRows : hist;

  return (
    <>
      <PageHeader kicker="Exposure" title="Positions">All sells preserve a fixed 1% of each original purchase, including manual and emergency exits. Transfers are reconciled without recording a sale. Slippage applies and exits may fail.</PageHeader>
      <div className="mb-3 flex gap-1">
        {([['open', `Open (${openRows.length})`], ['history', `History (${hist.length})`]] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} data-testid={`tab-${k}`} className={`press mono rounded-md border px-3 py-1.5 text-[11px] uppercase tracking-wider ${tab === k ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground'}`}>{l}</button>
        ))}
      </div>
      {isLoading ? <Skeleton rows={5} /> : error ? <ErrorBlock error={error} onRetry={() => refetch()} /> : rows.length === 0 ? (
        <EmptyState title={tab === 'open' ? 'No open positions' : 'No closed positions yet'}>{tab === 'open' ? 'When the bot enters a token, the position and its exit plan show up here.' : 'Closed trades and their exit reasons will be listed here.'}</EmptyState>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => {
            const busy = close.isPending && close.variables?.id === p.id;
            return (
              <article key={p.id} className="rise rowrail rounded-md border border-card-border bg-card p-4" data-testid={`card-position-${p.id}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-lg font-bold">{p.symbol}</h3>
                  <Pill tone={tone[p.status]}>{p.status}</Pill><Pill tone={p.mode === 'live' ? 'bad' : 'info'}>{p.mode}</Pill>
                  <span className="mono text-[11px] text-muted-foreground">stage {p.stage} · {shortMint(p.mint)}{p.walletAddress ? ` · wallet ${shortMint(p.walletAddress)}` : ''}</span>
                  <div className="ml-auto text-right"><div className={`mono text-xl font-semibold ${pnl(p.pnlPct)}`}>{pct(p.pnlPct)}</div></div>
                  {(p.status === 'open' || p.status === 'pending') && <Button size="sm" variant="destructive" disabled={busy || p.status === 'pending'} onClick={() => setTarget(p)} data-testid={`button-close-${p.id}`}><X className="h-3.5 w-3.5" />{busy ? 'Closing…' : 'Sell · keep 1%'}</Button>}
                </div>
                <dl className="mono mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4 lg:grid-cols-6">
                  {[['Entry', price(p.entryPriceUsd)], ['Current', price(p.currentPriceUsd)], ['Cost in', `${p.originalCostSol.toFixed(6)} SOL`], ['Remaining', `${p.remainingCostSol.toFixed(6)} SOL`], ['Realized SOL', `${p.realizedPnlSol >= 0 ? '+' : ''}${p.realizedPnlSol.toFixed(6)} SOL`], ['Realized USD', signedUsd(p.realizedPnlUsd)], ['Unrealized', signedUsd(p.unrealizedPnlUsd)], ['Opened', ago(p.openedAt)], ['Closed', p.closedAt ? ago(p.closedAt) : '—']].map(([k, v]) => (
                    <div key={k}><dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt><dd className="mt-0.5 text-sm">{v}</dd></div>))}
                </dl>
                <div className="mt-3 space-y-2 border-t border-border pt-2 text-xs text-muted-foreground break-words">
                  <p>Tracked tokens: {p.quantity.toLocaleString(undefined, { maximumSignificantDigits: 8 })} · Protected: {p.retainedQuantity?.toLocaleString(undefined, { maximumSignificantDigits: 8 }) ?? '1% of original fill'}{p.walletSyncedAt ? ` · Wallet checked ${ago(p.walletSyncedAt)}` : ''}.</p>
                  {!!p.externallyTransferredQuantity && <p>Externally removed: {p.externallyTransferredQuantity.toLocaleString(undefined, { maximumSignificantDigits: 8 })} tokens. Not a bot sale or realized trading loss.</p>}
                  {p.status === 'retained' && <p className="font-semibold">Permanent 1% holdback. No bot exit or Close action can sell these tokens. They can still lose all value.</p>}
                  <p>{p.executionVenue ? `Execution: ${p.executionVenue}. ` : ''}{p.fastCrazyExit
                    ? `Crazy two-stage plan: 50% at +50% net SOL gain (${p.firstTierDone ? 'filled' : 'waiting'}), then 15% trailing stop on the remaining half. Stop loss −20%; liquidity-drop protection 25%. Protective/leader exits can occur earlier.`
                    : p.exitPlan
                    ? `Original-quantity plan: ${p.exitPlan.firstSellPct}% at +${p.exitPlan.firstTargetPct}% (${p.firstTierDone ? 'filled' : 'waiting'}), ${p.exitPlan.secondSellPct}% at +${p.exitPlan.secondTargetPct}% (${p.secondTierDone ? 'filled' : 'waiting'}), ${100 - p.exitPlan.firstSellPct - p.exitPlan.secondSellPct}% moon bag with ${p.exitPlan.trailingStopPct}% trailing stop.`
                    : 'Legacy full/staged/adaptive exit plan; not reinterpreted as 50 / 30 / 20.'}</p>
                  {p.mode === 'live' && p.status === 'open' && <p data-testid={`risk-monitor-${p.id}`}>{p.riskMonitoring ?? 'RPC alert coverage not yet confirmed. Best-effort 15-second polling remains active.'}</p>}
                </div>
                {(p.exitReason || p.txSignature) && (
                  <p className="mt-3 border-t border-border pt-2 text-sm">{p.exitReason && <><span className="text-muted-foreground">Exit reason: </span>{p.exitReason}</>}
                    {p.txSignature && <a className="mono ml-3 text-xs text-primary hover:underline" href={`https://solscan.io/tx/${p.txSignature}`} target="_blank" rel="noreferrer">tx {shortMint(p.txSignature)}</a>}</p>)}
              </article>
            );
          })}
        </div>
      )}
      <div className="mt-5 rounded-md border border-border bg-card p-4">
        <Button variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending} data-testid="button-refresh-wallet">
          <RefreshCw className={`h-4 w-4 ${refresh.isPending ? 'animate-spin' : ''}`} />{refresh.isPending ? 'Refreshing wallet…' : 'Refresh wallet balances'}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">Reads finalized SOL and token balances from the verified trading wallet. Reconciles transfers and stops selling missing tokens. Does not sign, submit a trade or change Start/Stop. Pending transactions must settle first; paper balances are not replaced.</p>
      </div>
      <div className="mt-4"><Disclosure /></div>
      <Confirm open={!!target} onOpenChange={(o) => !o && setTarget(null)} title={`Sell ${target?.symbol ?? ''}, keep 1%?`} confirmLabel="Sell available tokens" danger onConfirm={() => { if (target) close.mutate({ id: target.id }); setTarget(null); }}>
        <p>Sells only the available balance above the fixed 1% original-purchase reserve. The reserve is never included, even in an emergency. Fees and slippage apply{target?.mode === 'live' ? ' and this uses real funds' : ''}.</p><p>If tokens were transferred away, holdings are reconciled instead. Failed exits retry without switching the bot off.</p>
      </Confirm>
    </>
  );
}
