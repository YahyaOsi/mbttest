import { ExternalLink } from 'lucide-react';
import { useConnectionsQ } from '@/hooks/use-sentinel';
import { EmptyState, ErrorBlock, PageHeader, Pill, Skeleton, type Tone } from '@/components/kit';

const tone: Record<string, Tone> = { connected: 'ok', available: 'info', missing: 'bad', optional: 'mute', error: 'bad' };

export default function Connections() {
  const { data, isLoading, error, refetch } = useConnectionsQ();
  return (
    <>
      <PageHeader kicker="Providers" title="Connections">Status reported by the backend for each provider Sentinel depends on. Credentials are configured as server secrets, never in this browser.</PageHeader>
      {isLoading ? <Skeleton rows={5} /> : error ? <ErrorBlock error={error} onRetry={() => refetch()} /> : !data?.length ? (
        <EmptyState title="No providers reported">The backend returned no connection entries.</EmptyState>
      ) : (
        <ul className="rise divide-y divide-border rounded-md border border-card-border bg-card">
          {data.map((c) => (
            <li key={c.id} className="rowrail flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3.5" data-testid={`row-connection-${c.id}`}>
              <div className="min-w-[180px] flex-1"><p className="font-semibold">{c.name}</p><p className="text-sm text-muted-foreground">{c.description}</p></div>
              {c.requiredForLive && <Pill tone="warn">Required for live</Pill>}
              <Pill tone={tone[c.status]} testid={`status-connection-${c.id}`}>{c.status}</Pill>
              {c.url && <a href={c.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline" data-testid={`link-connection-${c.id}`}>Docs <ExternalLink className="h-3 w-3" /></a>}
            </li>))}
        </ul>
      )}
    </>
  );
}
