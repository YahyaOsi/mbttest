import { useEffect, useState } from 'react';
import type { RpcEndpointHealth } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetRpcConnection, getGetRpcConnectionQueryKey, useTestRpcConnection, useUpdateRpcConnection, useResetRpcConnection,
} from '@workspace/api-client-react';
import { useInvalidateAll } from '@/hooks/use-sentinel';
import { Confirm, ErrorBlock, Panel, Pill, Skeleton } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { errMsg } from '@/lib/format';

const SRC = { app: 'Custom (saved in app)', environment: 'Environment secret', public: 'Public RPC' } as const;

function failText(e: unknown) {
  const s = (e as { status?: number } | null)?.status;
  if (s === 429) return 'Too many attempts. Wait a minute and try again.';
  return errMsg(e);
}

function validUrl(v: string) {
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && (!u.port || u.port === '443'); } catch { return false; }
}

export function RpcConnection() {
  const qc = useQueryClient();
  const inv = useInvalidateAll();
  const { toast } = useToast();
  const q = useGetRpcConnection({ query: { queryKey: getGetRpcConnectionQueryKey(), refetchInterval: 15000 } });
  const [url, setUrl] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => () => { setUrl(''); setExtra([]); }, []);

  const refresh = () => { qc.invalidateQueries({ queryKey: getGetRpcConnectionQueryKey() }); inv(); };
  const test = useTestRpcConnection({ mutation: {
    onSuccess: r => setResult({ ok: r.success, text: r.message }),
    onError: e => setResult({ ok: false, text: failText(e) }),
  } });
  const save = useUpdateRpcConnection({ mutation: {
    onSuccess: r => { setUrl(''); setExtra([]); setResult({ ok: true, text: r.message }); toast({ title: 'RPC saved', description: 'Entries remain paused. Nothing starts automatically.' }); refresh(); },
    onError: e => setResult({ ok: false, text: failText(e) }),
  } });
  const reset = useResetRpcConnection({ mutation: {
    onSuccess: r => { setUrl(''); setExtra([]); setResult({ ok: true, text: r.message }); toast({ title: 'RPC reverted', description: 'Entries remain paused.' }); refresh(); },
    onError: e => setResult({ ok: false, text: failText(e) }),
  } });

  const st = q.data;
  const trimmed = url.trim();
  const extras = extra.map(x => x.trim()).filter(Boolean);
  const extraBad = extras.some(x => !validUrl(x));
  const dup = new Set([trimmed, ...extras]).size !== extras.length + 1;
  const invalid = (trimmed !== '' && !validUrl(trimmed)) || extraBad || dup;
  const body = { url: trimmed, ...(extras.length ? { additionalUrls: extras } : {}) };
  const busy = test.isPending || save.isPending || reset.isPending;
  const blocked = !st?.canChange || !st?.encryptionReady;

  return (
    <Panel title="Solana RPC connection" className="mb-4" aside={st && <Pill tone={st.source === 'public' ? 'warn' : 'ok'} testid="status-rpc-source">{SRC[st.source]}</Pill>}>
      {q.isLoading ? <Skeleton rows={3} /> : q.error || !st ? <ErrorBlock error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground" data-testid="text-rpc-message">{st.message}</p>
          <p className="text-xs text-muted-foreground">The third saved endpoint is reserved for wallet checks, priority quotes and swaps. With fewer than three, endpoint 1 is primary. Discovery, watchlist and AI evidence use backups only; configure at least two endpoints. A single endpoint cannot run background scanning.</p>
          <p className="text-xs text-muted-foreground">
            Custom configured: <span className="mono">{st.configured ? 'yes' : 'no'}</span> · Updated: <span className="mono" data-testid="text-rpc-updated">{st.updatedAt ? new Date(st.updatedAt).toLocaleString() : 'never'}</span> · Entries: <span className="mono">{st.paused ? 'paused' : 'running'}</span>
          </p>
          {st.websocketAlerts
            ? <p className="text-xs text-muted-foreground" data-testid="text-rpc-ws">Websocket alert subscriptions are supported. Custom hosts are re-resolved and pinned to public IPv4 addresses; 15-second exit polling remains active as a fallback. Event delivery and alert coverage are best effort, not guaranteed.</p>
            : <p className="text-xs text-muted-foreground" data-testid="text-rpc-ws">Websocket alerts are unavailable for this host. Polling remains active.</p>}
          {!st.encryptionReady && <p role="alert" className="text-xs text-destructive">Encryption key is not configured on the server; a custom RPC cannot be stored.</p>}
          {!st.canChange && <p role="alert" className="text-xs text-destructive">Pause entries and wait for pending transactions to settle before changing RPC.</p>}
          <form className="space-y-2" autoComplete="off" onSubmit={e => { e.preventDefault(); if (!busy && !blocked && trimmed && !invalid) { setResult(null); save.mutate({ data: body }); } }}>
            <fieldset disabled={busy || !st.canChange} className="space-y-2">
            {st.endpoints && st.endpoints.length > 0 && <Health eps={st.endpoints} fetching={q.isFetching} />}
            <label htmlFor="rpc-url" className="block text-xs font-medium">Endpoint 1 mainnet RPC URL (hidden; may contain an API key)</label>
            <Input id="rpc-url" type="password" value={url} onChange={e => { setUrl(e.target.value); setResult(null); }} autoComplete="off" spellCheck={false}
              placeholder="https://…" aria-invalid={invalid} maxLength={4096}
              className={invalid ? 'border-destructive' : ''} data-testid="input-rpc-url" />
            {extra.map((x, i) => (
              <div key={i} className="flex gap-2">
                <Input type="password" aria-label={`Additional RPC URL ${i + 1}`} value={x} autoComplete="off" spellCheck={false} maxLength={4096} placeholder={`Additional https://… (${i + 2} of 6)`}
                  onChange={e => { const v = [...extra]; v[i] = e.target.value; setExtra(v); setResult(null); }}
                  className={x.trim() && !validUrl(x.trim()) ? 'min-w-0 flex-1 border-destructive' : 'min-w-0 flex-1'} data-testid={`input-rpc-extra-${i}`} />
                <Button type="button" variant="ghost" size="sm" onClick={() => { setExtra(extra.filter((_, j) => j !== i)); setResult(null); }} data-testid={`button-rpc-extra-remove-${i}`}>Remove</Button>
              </div>))}
            {extra.length < 5 && <Button type="button" variant="ghost" size="sm" className="px-0 text-xs" onClick={() => setExtra([...extra, ''])} data-testid="button-rpc-extra-add">+ Add backup endpoint ({extra.length}/5)</Button>}
            {invalid && <p role="alert" className="text-[11px] text-destructive">{dup ? 'Each endpoint must be different.' : 'Enter full HTTPS URLs without a password or fragment. Blank extra fields are ignored.'}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy || !trimmed || invalid} onClick={() => { setResult(null); test.mutate({ data: body }); }} data-testid="button-rpc-test">{test.isPending ? 'Testing…' : 'Test only'}</Button>
              <Button type="submit" size="sm" disabled={busy || !trimmed || invalid || blocked} data-testid="button-rpc-save">{save.isPending ? 'Verifying and saving…' : 'Verify and save'}</Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy || !st.configured || !st.canChange} onClick={() => setConfirm(true)} data-testid="button-rpc-reset">{reset.isPending ? 'Reverting…' : 'Revert to fallback'}</Button>
            </div>
            </fieldset>
          </form>
          {result && <p role="status" aria-live="polite" className={`text-xs ${result.ok ? 'text-[hsl(150_45%_30%)]' : 'text-destructive'}`} data-testid="text-rpc-result">{result.text}</p>}
          <p className="text-xs leading-relaxed text-muted-foreground">Test is read-only. Save verifies every endpoint (mainnet genesis, slot and balance) on the server, encrypts them and replaces the whole pool atomically, leaving entries paused. Nothing is started or published automatically.</p>
          <p className="text-xs leading-relaxed text-muted-foreground" data-testid="text-rpc-pool">With several endpoints, reads rotate round-robin; the fastest node is reserved for trading when alternatives are healthy. Each signed transaction is sent identically to up to 3 healthy endpoints at once. It is the same signature, so it can land at most once and never creates duplicate orders. Inclusion is still not guaranteed.</p>
        </div>
      )}
      <Confirm open={confirm} onOpenChange={setConfirm} title="Revert RPC to fallback?" confirmLabel="Revert" danger onConfirm={() => { setResult(null); reset.mutate(); }}>
        <p>The saved custom RPC will be deleted. The server verifies the fallback before applying it, and entries stay paused.</p>
        {st && !st.environmentAvailable && <p className="font-semibold text-destructive">No environment RPC is available. The fallback is the public RPC, which is not adequate for live trading.</p>}
      </Confirm>
    </Panel>
  );
}

function Health({ eps, fetching }: { eps: RpcEndpointHealth[]; fetching: boolean }) {
  return (
    <div className="rounded-md border border-border" data-testid="list-rpc-health">
      <p className="mono flex items-center justify-between border-b border-border px-3 py-1.5 text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">Endpoint health<span className={fetching ? 'skel px-1' : ''}>{fetching ? 'refreshing' : 'observed'}</span></p>
      {eps.map((e, i) => (
        <div key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-3 py-2 text-xs last:border-0" data-testid={`row-rpc-endpoint-${e.id}`}>
          <span className="font-medium">Endpoint {i + 1}</span>
          <span className="mono text-muted-foreground">{e.role}</span>
          <Pill tone={e.healthy ? 'ok' : 'bad'}>{e.healthy ? 'healthy' : 'unhealthy'}</Pill>
          <span className="mono">{e.latencyMs == null ? 'latency unknown' : `${Math.round(e.latencyMs)} ms`}</span>
          {e.failures > 0 && <span className="mono text-muted-foreground">{e.failures} failures</span>}
          {e.retryAt && <span className="mono text-muted-foreground">retry {new Date(e.retryAt) > new Date() ? `at ${new Date(e.retryAt).toLocaleTimeString()}` : 'due'}</span>}
        </div>))}
    </div>
  );
}
