import type { TradingSettings } from '@workspace/api-client-react';
import { Panel, Pill } from '@/components/kit';
import { usd } from '@/lib/format';
import { effectiveTradingRules } from '@/lib/effective-rules';

export function EffectiveTradingRules({ settings, equityUsd, preview = false }: {
  settings: TradingSettings; equityUsd?: number; preview?: boolean;
}) {
  const rules = effectiveTradingRules(settings, equityUsd);
  const money = (n: number) => Number.isFinite(n) ? usd(n) : 'Invalid value';
  return (
    <Panel title={preview ? 'Effective rules · unsaved preview' : 'Effective trading rules'}
      aside={<Pill tone={rules.crazy ? 'warn' : 'ok'}>{rules.crazy ? 'Crazy Mode' : 'Conservative'}</Pill>}>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="effective-trading-rules">
        <div><dt className="text-xs text-muted-foreground">Minimum liquidity / curve reserves</dt>
          <dd className="mono mt-1 text-lg font-semibold" data-testid="effective-liquidity">{money(rules.liquidityUsd)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Position sizing</dt>
          <dd className="mono mt-1 text-lg font-semibold" data-testid="effective-sizing">
            {rules.crazy ? `${rules.positionPercent}% equity` : money(rules.fixedPositionUsd!)}
          </dd>
          {rules.crazy && <p className="mt-1 text-xs text-muted-foreground">
            No dollar cap{rules.projectedPositionUsd !== null ? ` · current budget ${money(rules.projectedPositionUsd)}` : ''}
            {' · balance, reserve and allocation checks still apply.'}
          </p>}
        </div>
        <div><dt className="text-xs text-muted-foreground">Minimum 24h volume</dt>
          <dd className="mono mt-1 text-lg font-semibold" data-testid="effective-volume">{money(rules.volumeUsd)}</dd>
          <p className="mt-1 text-xs text-muted-foreground">Live activity or verified copy signals still required.</p></div>
        <div><dt className="text-xs text-muted-foreground">Background discovery</dt>
          <dd className="mono mt-1 text-lg font-semibold">{rules.scanMinutes} minutes</dd>
          <p className="mt-1 text-xs text-muted-foreground">Live wallet and mint events are separate.</p></div>
      </dl>
      {rules.crazy && <p className="mt-4 text-xs text-muted-foreground">
        These Crazy Mode overrides apply instead of conservative liquidity, fixed position size, volume and scan settings.
      </p>}
    </Panel>
  );
}
