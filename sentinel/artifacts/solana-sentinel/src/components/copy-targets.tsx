import { Plus, Trash2 } from 'lucide-react';
import {
  useGetHighRiskStatus, getGetHighRiskStatusQueryKey, type CopyTarget, type TradingSettings,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { ErrorBlock, Panel, Pill, Skeleton } from '@/components/kit';

const MAX = 10;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const input = 'h-9 w-full rounded-md border border-input bg-background px-2.5 mono text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20';
const short = (w: string) => (w.length > 11 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);
const PLATFORMS: { id: CopyTarget['platform']; label: string }[] = [
  { id: 'wallet', label: 'Wallet' }, { id: 'x', label: 'X' }, { id: 'fomo', label: 'Fomo' },
];

export function targetError(t: CopyTarget): string | null {
  const w = t.wallet.trim();
  if (t.username.length > 64) return 'Username is limited to 64 characters.';
  if (t.platform !== 'wallet' && !t.username.trim()) return 'Username is required.';
  if (!w) return t.platform === 'fomo' ? null : t.platform === 'x' ? 'X targets need an owner-supplied linked wallet.' : 'Wallet is required.';
  if (!B58.test(w)) return 'Not a valid Solana address (base58, 32–44 characters).';
  return null;
}
export function copyTargetsInvalid(form: TradingSettings): boolean {
  const list = form.copyTargets ?? [];
  return list.length > MAX || list.some((t) => targetError(t) !== null);
}

export function CopyTargets({ form, onChange }: { form: TradingSettings; onChange: (next: TradingSettings) => void }) {
  const enabled = form.copyTradingEnabled ?? false;
  const tracking = form.trackFomoHandles ?? false;
  const list = form.copyTargets ?? [];
  const q = useGetHighRiskStatus({ query: { enabled: enabled || tracking, queryKey: getGetHighRiskStatusQueryKey(), refetchInterval: 15000 } });
  const st = q.data;
  const setList = (next: CopyTarget[]) => onChange({ ...form, copyTargets: next });
  const patch = (i: number, p: Partial<CopyTarget>) => setList(list.map((t, j) => (j === i ? { ...t, ...p } : t)));

  return (
    <Panel title="Target wallets and X / Fomo usernames" className="mb-4" aside={enabled || tracking ? <Pill tone="bad" testid="pill-copy-enabled">Tracking enabled</Pill> : <Pill tone="mute">Off</Pill>}>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => onChange({ ...form, copyTradingEnabled: e.target.checked })} data-testid="check-copy-enabled" className="mt-1 h-4 w-4 accent-[hsl(188_62%_20%)]" />
        <span><span className="font-medium">Manual Copy Trade</span><span className="block text-muted-foreground">Copies explicitly configured wallet targets in either risk mode without public FOMO polling. Position sizing, pending-order lock, daily loss stop and safety checks remain. Copying can lose the whole position.</span></span>
      </label>
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
        <input type="checkbox" checked={tracking} onChange={e => onChange({ ...form, trackFomoHandles: e.target.checked })} data-testid="check-fomo-handles" className="mt-1 h-4 w-4 accent-[hsl(188_62%_20%)]" />
        <span><span className="font-medium">Track FOMO &amp; User Handles</span><span className="block text-muted-foreground">Enables X/FOMO linked-wallet targets and automatic FOMO leaders in Crazy Mode. Off skips public leaderboard requests and handle tracking. Existing copied-position exits stay monitored. X posts are not a trading feed.</span></span>
      </label>
      <p className="mt-2 text-xs text-muted-foreground">Wallet: copies the address you enter. X: you must supply the linked wallet yourself; posts are never traded and identities are never inferred. Fomo: wallet optional; a blank wallet resolves only from a verified wallet link on the fresh public top-10 Fomo leaderboard, otherwise it stays unresolved and nothing is bought. Pause the bot before saving edits. The server validates every address.</p>

      <div className="mt-3 space-y-2" data-testid="list-copy-targets">
        {list.length === 0 && <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No targets. Add up to {MAX}.</p>}
        {list.map((t, i) => {
          const err = targetError(t);
          return (
            <div key={i} data-testid={`row-copy-target-${i}`} className={`grid gap-2 rounded-md border p-2 sm:grid-cols-[auto_1fr_1.4fr_auto] sm:items-start ${err ? 'border-destructive/60' : 'border-border'}`}>
              <div className="flex overflow-hidden rounded-md border border-border" role="group" aria-label="Platform">
                {PLATFORMS.map((p) => (
                  <button key={p.id} type="button" onClick={() => patch(i, { platform: p.id })} data-testid={`button-platform-${p.id}-${i}`}
                    className={`press mono px-2.5 py-2 text-[11px] uppercase tracking-wider ${t.platform === p.id ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground'}`}>{p.label}</button>))}
              </div>
              <input className={input} maxLength={64} placeholder={t.platform === 'wallet' ? 'Label (optional)' : t.platform === 'x' ? 'X username' : 'Fomo username'}
                value={t.username} onChange={(e) => patch(i, { username: e.target.value })} data-testid={`input-copy-username-${i}`} />
              <div>
                <input className={`${input} ${err ? 'border-destructive' : ''}`} maxLength={44} aria-invalid={!!err}
                  placeholder={t.platform === 'fomo' ? 'Wallet (blank = resolve from leaderboard)' : 'Solana wallet address'}
                  value={t.wallet} onChange={(e) => patch(i, { wallet: e.target.value.trim() })} data-testid={`input-copy-wallet-${i}`} />
                {err && <span role="alert" className="text-[11px] text-destructive">{err}</span>}
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label="Remove target" onClick={() => setList(list.filter((_, j) => j !== i))} data-testid={`button-remove-target-${i}`}><Trash2 className="h-4 w-4" /></Button>
            </div>);
        })}
      </div>
      <Button type="button" variant="outline" className="mt-3" disabled={list.length >= MAX} onClick={() => setList([...list, { platform: 'wallet', username: '', wallet: '' }])} data-testid="button-add-target">
        <Plus className="h-4 w-4" />Add target <span className="mono text-xs text-muted-foreground">{list.length}/{MAX}</span>
      </Button>

      {(enabled || tracking) && (
        <div className="mt-4 border-t border-border pt-3" aria-live="polite">
          <h3 className="mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Target status</h3>
          {q.isLoading ? <div className="mt-2"><Skeleton rows={2} /></div>
            : q.error || !st ? <div className="mt-2"><ErrorBlock error={q.error} onRetry={() => q.refetch()} /></div>
            : (
              <div className="mt-2 space-y-2 text-sm" data-testid="status-copy-targets">
                <p className="text-xs text-muted-foreground">Status: <span className="mono" data-testid="text-copy-status">{st.status}</span> · Updated: <span className="mono">{st.updatedAt ? new Date(st.updatedAt).toLocaleString() : 'never'}</span></p>
                {st.notices.length > 0 && <ul className="list-disc pl-5 text-xs text-muted-foreground">{st.notices.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                {st.leaders.length === 0 ? <p className="text-xs text-muted-foreground">No active wallets reported. Unresolved targets do not buy.</p> : (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {st.leaders.map((l) => (
                      <li key={l.wallet} data-testid={`row-copy-leader-${l.rank}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                        <span className="font-medium">{l.handle}</span>
                        <span className="mono text-muted-foreground" title={l.wallet}>{short(l.wallet)}</span>
                        <span className="ml-auto mono">{l.losingCopies} losing</span>
                        {l.demoted ? <Pill tone="warn">Demoted</Pill> : <Pill tone="ok">Active</Pill>}
                      </li>))}
                  </ul>)}
              </div>)}
        </div>)}
    </Panel>
  );
}
