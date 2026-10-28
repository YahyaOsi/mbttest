import { type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useOwnerSession } from '@/lib/owner-session';
import { useToast } from '@/hooks/use-toast';
import { LayoutDashboard, Radar, Layers, ScrollText, SlidersHorizontal, Plug, ListChecks, LogOut } from 'lucide-react';
import { useDash } from '@/hooks/use-sentinel';
import { Dot, Pill } from '@/components/kit';
import { ago } from '@/lib/format';

const base = import.meta.env.BASE_URL.replace(/\/$/, '');
const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/scanner', label: 'Scanner', icon: Radar },
  { to: '/positions', label: 'Positions', icon: Layers },
  { to: '/activity', label: 'Activity', icon: ScrollText },
  { to: '/strategy', label: 'Strategy', icon: SlidersHorizontal },
  { to: '/connections', label: 'Connections', icon: Plug },
  { to: '/setup', label: 'Setup', icon: ListChecks },
];

export function Brand({ dark = true }: { dark?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5" data-testid="link-brand">
      <img src={`${base}/logo.svg`} alt="" className="h-7 w-7 rounded-md" />
      <span className={`text-lg font-extrabold tracking-tight ${dark ? 'text-sidebar-accent-foreground' : ''}`}>Sentinel</span>
    </Link>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const { lock } = useOwnerSession();
  const { toast } = useToast();
  const signOut = () => lock().catch(() => toast({ title: 'Could not revoke session', description: 'Check the connection and try locking again.', variant: 'destructive' }));
  const { data: d } = useDash();
  return (
    <div className="min-h-[100dvh] md:pl-60">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col bg-sidebar p-4 text-sidebar-foreground md:flex">
        <Brand />
        <div className="sweep mt-5 rounded-md border border-sidebar-border bg-sidebar-accent/60 p-3" data-testid="panel-bot-status">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold text-sidebar-accent-foreground">
              <Dot tone={d?.running ? 'ok' : 'warn'} live={!!d?.running} />
              {d ? (d.running ? 'Running' : 'Paused') : 'Connecting'}
            </span>
            {d && <Pill tone={d.mode === 'live' ? 'bad' : 'info'}>{d.mode === 'live' ? 'Mainnet' : 'Paper'}</Pill>}
          </div>
          <p className="mono mt-2 text-[10.5px] text-sidebar-foreground/70">worker {d ? ago(d.workerHeartbeatAt) : '—'}</p>
        </div>
        <nav className="mt-5 flex flex-1 flex-col gap-0.5">
          {NAV.map(({ to, label, icon: I }) => {
            const on = loc === to;
            return (
              <Link key={to} href={to} data-testid={`link-nav-${label.toLowerCase()}`}
                className={`press group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors ${on ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_2px_0_0_hsl(var(--sidebar-primary))]' : 'hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'}`}>
                <I className={`h-4 w-4 transition-transform group-hover:translate-x-0.5 ${on ? 'text-sidebar-primary' : ''}`} />{label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-sidebar-border pt-3">
          <p className="mono truncate text-[11px]">Personal owner · console unlocked</p>
          <button type="button" onClick={signOut} data-testid="button-sign-out"
            className="press mt-2 flex items-center gap-2 text-xs font-medium text-sidebar-foreground/80 hover:text-sidebar-primary">
            <LogOut className="h-3.5 w-3.5" />Lock console
          </button>
        </div>
      </aside>
      <div className="sticky top-0 z-20 border-b border-sidebar-border bg-sidebar md:hidden">
        <div className="flex items-center justify-between px-3 pt-2.5"><Brand />
          <span className="flex items-center gap-2 text-xs text-sidebar-foreground"><Dot tone={d?.running ? 'ok' : 'warn'} live={!!d?.running} />{d ? (d.running ? 'Running' : 'Paused') : '…'}</span></div>
        <nav className="flex gap-1 overflow-x-auto px-2 py-2">
          {NAV.map(({ to, label }) => (
            <Link key={to} href={to} className={`whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium ${loc === to ? 'bg-sidebar-accent text-sidebar-primary' : 'text-sidebar-foreground'}`}>{label}</Link>
          ))}
          <button type="button" onClick={signOut} className="whitespace-nowrap px-2.5 py-1.5 text-xs text-sidebar-foreground">Lock console</button>
        </nav>
      </div>
      <main className="mx-auto max-w-[1200px] px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
