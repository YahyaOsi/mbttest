import { type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { errMsg } from '@/lib/format';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute';
const toneCls: Record<Tone, string> = {
  ok: 'bg-[hsl(150_35%_88%)] text-[hsl(150_45%_22%)]',
  warn: 'bg-[hsl(38_90%_86%)] text-[hsl(28_80%_26%)]',
  bad: 'bg-[hsl(8_70%_91%)] text-[hsl(8_68%_34%)]',
  info: 'bg-[hsl(188_40%_87%)] text-[hsl(188_62%_18%)]',
  mute: 'bg-muted text-muted-foreground',
};
export const toneText: Record<Tone, string> = {
  ok: 'text-[hsl(150_45%_26%)]', warn: 'text-[hsl(28_80%_34%)]', bad: 'text-[hsl(8_68%_40%)]',
  info: 'text-primary', mute: 'text-muted-foreground',
};

export function Pill({ tone = 'mute', children, testid }: { tone?: Tone; children: ReactNode; testid?: string }) {
  return (
    <span data-testid={testid} className={`mono inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wider ${toneCls[tone]}`}>
      {children}
    </span>
  );
}

export function Dot({ tone = 'mute', live }: { tone?: Tone; live?: boolean }) {
  const c = { ok: 'bg-[hsl(150_45%_36%)]', warn: 'bg-accent', bad: 'bg-destructive', info: 'bg-primary', mute: 'bg-muted-foreground/50' }[tone];
  return <span className={`relative inline-block h-2 w-2 rounded-full ${c} ${live ? 'beat' : ''}`} />;
}

export function PageHeader({ kicker, title, children, actions }: { kicker: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="rise mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
      <div className="max-w-2xl">
        <p className="mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{kicker}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{title}</h1>
        {children && <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{children}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ title, aside, children, className = '', pad = true }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`rise rounded-md border border-card-border bg-card ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{title}</h2>
          {aside}
        </div>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone = 'mute', testid }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; testid?: string }) {
  return (
    <div className="rise bg-card px-4 py-3" data-testid={testid}>
      <p className="mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className={`mono mt-1 text-2xl font-semibold ${tone === 'mute' ? '' : toneText[tone]}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function Meter({ value, max, tone = 'info' }: { value: number; max: number; tone?: Tone }) {
  const p = Math.min(100, max > 0 ? (value / max) * 100 : 0);
  const c = { ok: 'bg-[hsl(150_45%_36%)]', warn: 'bg-accent', bad: 'bg-destructive', info: 'bg-primary', mute: 'bg-muted-foreground' }[p > 85 ? 'bad' : p > 60 ? 'warn' : tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full origin-left rounded-full transition-transform duration-700 ${c}`} style={{ transform: `scaleX(${p / 100})` }} />
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border bg-card/50 p-6">
      <div className="mb-1 h-0.5 w-8 bg-accent" />
      <p className="font-semibold">{title}</p>
      <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-[hsl(8_70%_96%)] p-4 text-sm">
      <span className="flex items-center gap-2 text-[hsl(8_68%_32%)]"><AlertTriangle className="h-4 w-4" />{errMsg(error)}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry} data-testid="button-retry"><RefreshCw className="h-3.5 w-3.5" />Retry</Button>}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skel h-11" style={{ animationDelay: `${i * 120}ms` }} />)}
    </div>
  );
}

export function Confirm({ open, onOpenChange, title, children, confirmLabel, danger, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild><div className="space-y-2 text-sm">{children}</div></AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-confirm-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} data-testid="button-confirm-ok" className={danger ? 'bg-destructive text-destructive-foreground' : ''}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Disclosure() {
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      Automation does not guarantee profit. Every trade pays fees and slippage, thin-liquidity exits can fail or fill far from the quote, and AI evidence scores are a ranking aid, not a probability of winning.
    </p>
  );
}
