import { Check } from 'lucide-react';
import { useState } from 'react';
import { useVerifyOwnerWallet } from '@workspace/api-client-react';
import { useSetupQ, useInvalidateAll, useDash } from '@/hooks/use-sentinel';
import { ErrorBlock, PageHeader, Panel, Pill, Skeleton } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { errMsg } from '@/lib/format';
import { RpcConnection } from '@/components/rpc-connection';

export default function Setup() {
  const { data, isLoading, error, refetch } = useSetupQ();
  const { data: dash } = useDash();
  const [address, setAddress] = useState('');
  const inv = useInvalidateAll();
  const { toast } = useToast();
  const verify = useVerifyOwnerWallet({ mutation: {
    onSuccess: r => { toast({ title: 'Wallet verified', description: r.message }); setAddress(''); inv(); },
    onError: e => toast({ title: 'Wallet not verified', description: errMsg(e), variant: 'destructive' }),
  } });
  return (
    <>
      <PageHeader kicker="Mainnet" title="Setup" actions={data && <Pill tone={data.liveReady ? 'ok' : 'warn'}>{data.liveReady ? 'Live ready' : 'Live locked'}</Pill>}>
        Mainnet stays locked until every blocker below is cleared. Steps and blockers come straight from the backend.
      </PageHeader>
      <RpcConnection />
      {isLoading ? <Skeleton rows={6} /> : error || !data ? <ErrorBlock error={error} onRetry={() => refetch()} /> : (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <ol className="space-y-2">
            {data.steps.map((s) => (
              <li key={s.number} className="rise flex gap-4 rounded-md border border-card-border bg-card p-4" data-testid={`step-${s.number}`}>
                <span className={`mono grid h-8 w-8 shrink-0 place-items-center rounded-full border text-sm transition-colors ${s.complete ? 'border-[hsl(150_45%_30%)] bg-[hsl(150_45%_30%)] text-white' : 'border-border'}`}>{s.complete ? <Check className="h-4 w-4" /> : s.number}</span>
                <div><p className="font-semibold">{s.title}</p><p className="mt-0.5 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{s.description}</p></div>
              </li>))}
          </ol>
          <div className="space-y-4">
            <Panel title="Blockers" aside={<Pill tone={data.blockers.length ? 'bad' : 'ok'}>{data.blockers.length}</Pill>}>
              {data.blockers.length ? <ul className="space-y-2 text-sm">{data.blockers.map((b, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-destructive" />{b}</li>)}</ul> : <p className="text-sm text-muted-foreground">No blockers reported.</p>}
            </Panel>
            {data.warnings.length > 0 && <Panel title="Warnings"><ul className="space-y-2 text-sm">{data.warnings.map((w, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-accent" />{w}</li>)}</ul></Panel>}
            <Panel title="One active burner wallet" aside={<Pill tone={data.walletVerified ? 'ok' : 'warn'}>{data.walletVerified ? 'Verified' : 'Unverified'}</Pill>}>
              <p className="text-xs text-muted-foreground">Configured public address</p>
              <p className="mono mt-1 break-all text-sm" data-testid="text-wallet">{data.walletAddress ?? 'No wallet configured'}</p>
              {data.boundWalletAddress && data.boundWalletAddress !== data.walletAddress && <p className="mt-3 break-all text-sm text-destructive">Ledger is bound to {data.boundWalletAddress}. Restore its key for any open positions before switching.</p>}
              {!data.walletVerified && data.walletAddress && <form className="mt-4 space-y-3" onSubmit={e => { e.preventDefault(); verify.mutate({ data: { address } }); }}>
                <label htmlFor="wallet-address-confirm" className="block text-sm font-semibold">Repeat the independently verified public address</label>
                <Input id="wallet-address-confirm" value={address} onChange={e => setAddress(e.target.value.trim())} maxLength={44} autoComplete="off" placeholder="Public address only — never a private key" data-testid="input-wallet-confirm" />
                <Button type="submit" disabled={verify.isPending || !!dash?.running || address !== data.walletAddress} data-testid="button-verify-wallet">{verify.isPending ? 'Verifying…' : 'Confirm burner address'}</Button>
              </form>}
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">To switch: pause → close all live positions with the old key → reconcile pending transactions → replace SOLANA_TRADING_PRIVATE_KEY in Secrets → restart API → verify the new public address here. No wallet connection is required, and no funds are transferred by this action.</p>
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
