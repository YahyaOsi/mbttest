import { useState, type FormEvent } from 'react';
import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { useOwnerSession } from '@/lib/owner-session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errMsg } from '@/lib/format';

const base = import.meta.env.BASE_URL.replace(/\/$/, '');
export default function LockPage() {
  const { session, loading, error: statusError, unlock } = useOwnerSession();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await unlock(password); }
    catch (e) { setError(errMsg(e)); }
    finally { setPassword(''); setBusy(false); }
  }
  return <main className="grid min-h-[100dvh] place-items-center bg-sidebar px-4 py-10">
    <section className="w-full max-w-md rounded-md border border-card-border bg-background p-6 shadow-xl sm:p-8">
      <div className="flex items-center gap-3"><img src={`${base}/logo.svg`} alt="" className="h-10 w-10 rounded" /><span className="text-xl font-extrabold tracking-tight">Sentinel</span></div>
      <div className="mono mt-8 flex items-center gap-2 text-[11px] uppercase tracking-widest text-primary"><LockKeyhole className="h-4 w-4" />Personal console · one owner</div>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight">Your console is locked.</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">No public accounts, shared dashboards or wallet connection. Unlock with your private console password.</p>
      {loading ? <p className="mt-6 text-sm">Checking lock…</p> : session?.configured ? (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <input type="hidden" name="username" autoComplete="username" value="owner" />
          <div><label htmlFor="owner-password" className="mb-2 block text-sm font-semibold">Password</label>
            <Input id="owner-password" type="password" autoComplete="current-password" maxLength={256} value={password} onChange={e => setPassword(e.target.value)} required disabled={busy} data-testid="input-owner-password" />
          </div>
          {error && <p role="alert" className="text-sm text-destructive" data-testid="text-unlock-error">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy || !password} data-testid="button-unlock">{busy ? 'Unlocking…' : 'Unlock console'}</Button>
        </form>
      ) : <div className="mt-6 rounded border border-card-border bg-card p-4 text-sm" data-testid="panel-password-setup">
        <p className="font-semibold">Password setup required</p>
        <p className="mt-2 text-muted-foreground">Add SENTINEL_APP_PASSWORD in this project’s Secrets using 16–256 characters, then restart the API. A strong SESSION_SECRET is also required. Until configured, every private API remains locked.</p>
      </div>}
      {!!statusError && <p role="alert" className="mt-4 text-sm text-destructive">Cannot reach the lock service. Access remains locked. Reload to retry.</p>}
      <p className="mt-6 flex gap-2 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />Sessions expire after 12 hours. Locking this console does not pause a running bot. Anyone with this password can control the burner wallet; keep it private.</p>
    </section>
  </main>;
}
