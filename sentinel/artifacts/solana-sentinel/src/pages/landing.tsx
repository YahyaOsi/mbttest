import { Link } from 'wouter';
import { ArrowRight, Lock } from 'lucide-react';
import { useGetCandidates, getGetCandidatesQueryKey } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Brand } from '@/components/shell';
import { EmptyState, ErrorBlock, Pill, Skeleton } from '@/components/kit';
import { age, compact, pct, price } from '@/lib/format';
import { statusTone } from '@/pages/scanner';

const ROWS = [
  ['Bought', 'The filters it passed, the evidence score, the size, and the slippage it accepted.'],
  ['Skipped', 'Which rule rejected the token: liquidity, holder concentration, price impact or score.'],
  ['Sold', 'The exit trigger, whether the sell filled or failed, and what it cost you.'],
];

export default function Landing() {
  const { data, isLoading, error, refetch } = useGetCandidates({ query: { queryKey: getGetCandidatesQueryKey(), refetchInterval: 30000 } });
  const rows = (data ?? []).slice(0, 8);
  return (
    <div className="min-h-[100dvh]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <span className="rounded-md bg-sidebar px-3 py-1.5"><Brand /></span>
        <div className="flex gap-2">
          <Button asChild variant="ghost"><Link href="/sign-in" data-testid="link-sign-in">Sign in</Link></Button>
          <Button asChild><Link href="/sign-up" data-testid="link-sign-up">Create account</Link></Button>
        </div>
      </header>
      <section className="mx-auto max-w-6xl px-5 pb-12 pt-10 md:pt-16">
        <p className="mono rise text-[11px] uppercase tracking-[0.24em] text-muted-foreground">Private Solana automation console</p>
        <h1 className="rise mt-4 max-w-4xl text-5xl font-extrabold leading-[0.98] tracking-tight md:text-7xl" style={{ animationDelay: '80ms' }}>Know exactly why it acted<span className="text-accent">.</span></h1>
        <p className="rise mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground" style={{ animationDelay: '160ms' }}>Sentinel watches Solana memecoins for you and writes down every decision. When you wake up, you read the reasons, not just the balance.</p>
        <div className="rise mt-7 flex flex-wrap gap-3" style={{ animationDelay: '240ms' }}>
          <Button asChild size="lg"><Link href="/sign-in" data-testid="link-hero-sign-in">Sign in to console <ArrowRight className="h-4 w-4" /></Link></Button>
          <Button asChild size="lg" variant="outline"><Link href="/sign-up" data-testid="link-hero-sign-up">Create account</Link></Button>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-14">
        <div className="overflow-hidden rounded-md border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-[0_20px_50px_-24px_hsl(200_30%_10%/.6)]">
          <div className="sweep flex flex-wrap items-center justify-between gap-2 border-b border-sidebar-border px-4 py-2.5">
            <span className="mono text-[11px] uppercase tracking-[0.18em] text-sidebar-accent-foreground">Discovery · read-only preview</span>
            <span className="flex items-center gap-2"><Pill tone="warn">Signed out</Pill><span className="mono flex items-center gap-1 text-[11px]"><Lock className="h-3 w-3" />Controls, positions and strategy need sign-in</span></span>
          </div>
          <div className="p-3">
            {isLoading ? <div className="opacity-60"><Skeleton rows={5} /></div> : error ? <ErrorBlock error={error} onRetry={() => refetch()} /> : rows.length === 0 ? (
              <div className="p-3 text-sm"><EmptyState title="No tokens discovered yet">Nothing has been found by a scan right now. This preview shows real discovery data only.</EmptyState></div>
            ) : (
              <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
                <thead><tr className="mono text-left text-[10.5px] uppercase tracking-[0.14em] text-sidebar-foreground/60">{['Token', 'Price', 'Liquidity', 'Vol 24h', '24h', 'Age', 'Status'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                <tbody>{rows.map((c) => (
                  <tr key={c.mint} className="border-t border-sidebar-border/70 transition-colors hover:bg-sidebar-accent/60" data-testid={`row-preview-${c.mint}`}>
                    <td className="px-3 py-2.5 font-semibold text-sidebar-accent-foreground">{c.symbol} <span className="font-normal text-sidebar-foreground/60">{c.name.slice(0, 18)}</span></td>
                    <td className="mono px-3">{price(c.priceUsd)}</td><td className="mono px-3">{compact(c.liquidityUsd)}</td><td className="mono px-3">{compact(c.volume24hUsd)}</td>
                    <td className="mono px-3">{pct(c.change24hPct)}</td><td className="mono px-3">{age(c.ageMinutes)}</td><td className="px-3"><Pill tone={statusTone[c.status] ?? 'mute'}>{c.status}</Pill></td>
                  </tr>))}</tbody></table></div>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-10 px-5 pb-16 md:grid-cols-[1fr_1.4fr]">
        <h2 className="text-3xl font-bold tracking-tight">An audit trail for decisions made while you sleep.</h2>
        <ol className="divide-y divide-border border-y border-border">
          {ROWS.map(([t, b], i) => (
            <li key={t} className="rowrail flex gap-5 py-5"><span className="mono text-sm text-accent">0{i + 1}</span><div><p className="text-lg font-semibold">{t}</p><p className="text-muted-foreground">{b}</p></div></li>))}
        </ol>
      </section>

      <section className="bg-sidebar text-sidebar-foreground">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-14 md:grid-cols-2">
          <div><p className="mono text-[11px] uppercase tracking-[0.2em] text-sidebar-primary">Plain terms</p><h2 className="mt-2 text-3xl font-bold text-sidebar-accent-foreground">This is a tool, not a promise.</h2></div>
          <ul className="space-y-3 text-sm leading-relaxed">
            <li>Nothing here guarantees profit. Memecoins can go to zero and you can lose everything you allocate.</li>
            <li>Every trade pays fees and slippage. Both are set in your strategy and shown in the log.</li>
            <li>Exits can fail in thin liquidity. Stops are targets, not guarantees.</li>
            <li>AI analysis is capped by a daily call budget and produces an evidence score, not a win probability.</li>
            <li>It starts paused in paper mode. Mainnet stays locked until real setup blockers are cleared.</li>
          </ul>
        </div>
      </section>
      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-8">
        <span className="text-sm text-muted-foreground">Sentinel is private software for a single trader. Not financial advice.</span>
        <Button asChild><Link href="/sign-in" data-testid="link-footer-sign-in">Sign in</Link></Button>
      </footer>
    </div>
  );
}
