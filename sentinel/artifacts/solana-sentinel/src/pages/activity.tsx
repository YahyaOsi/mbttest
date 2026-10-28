import { useState } from 'react';
import { useActivityQ } from '@/hooks/use-sentinel';
import { Dot, EmptyState, ErrorBlock, PageHeader, Skeleton, type Tone } from '@/components/kit';
import { shortMint, stamp } from '@/lib/format';

const tone: Record<string, Tone> = { error: 'bad', warning: 'warn', success: 'ok', info: 'mute' };

export default function Activity() {
  const { data, isLoading, error, refetch } = useActivityQ();
  const [lvl, setLvl] = useState('all');
  const [q, setQ] = useState('');
  const rows = (data ?? []).filter((a) => (lvl === 'all' || a.level === lvl) && `${a.category} ${a.message} ${a.mint ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader kicker="Audit trail" title="Activity">Every buy, skip, exit and failure with the reason the bot recorded, newest first.</PageHeader>
      <div className="mb-3 flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by text, category or mint" data-testid="input-filter" className="h-9 min-w-[200px] flex-1 rounded-md border border-input bg-card px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" />
        <div className="flex gap-1">{['all', 'success', 'info', 'warning', 'error'].map((l) => (
          <button key={l} type="button" onClick={() => setLvl(l)} data-testid={`filter-level-${l}`} className={`press mono rounded-md border px-2.5 py-1.5 text-[11px] uppercase tracking-wider ${lvl === l ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground'}`}>{l}</button>))}</div>
      </div>
      {isLoading ? <Skeleton rows={8} /> : error ? <ErrorBlock error={error} onRetry={() => refetch()} /> : rows.length === 0 ? (
        <EmptyState title={data?.length ? 'No entries match' : 'No activity recorded'}>{data?.length ? 'Adjust the level or text filter.' : 'The log fills as soon as the bot scans, decides or trades.'}</EmptyState>
      ) : (
        <ol className="rise relative ml-2 border-l border-border">
          {rows.map((a) => (
            <li key={a.id} className="rowrail relative py-2.5 pl-6 pr-3" data-testid={`row-activity-${a.id}`}>
              <span className="absolute -left-[5px] top-4"><Dot tone={tone[a.level]} /></span>
              <div className="mono flex flex-wrap gap-x-3 text-[11px] text-muted-foreground"><span>{stamp(a.time)}</span><span className="uppercase tracking-wider">{a.category}</span><span className="uppercase">{a.level}</span>{a.mint && <span>{shortMint(a.mint)}</span>}</div>
              <p className="mt-0.5 text-sm leading-relaxed">{a.message}</p>
            </li>))}
        </ol>
      )}
    </>
  );
}
