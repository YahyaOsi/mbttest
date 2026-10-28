import type { TradingSettings } from '@workspace/api-client-react';
import { Panel } from '@/components/kit';
import { Button } from '@/components/ui/button';

export function PumpHuntSettings({ form, onChange }: { form: TradingSettings; onChange: (s: TradingSettings) => void }) {
  return <Panel title="Pump.fun quick-profit hunt">
    <p className="mb-3 text-sm text-muted-foreground">Aggressive, small-position preset. $600 preferred liquidity; $400–$600 only with ≥3 buys, 1.3:1 buy bias and ≥$200 five-minute volume. One observed buy can nominate a normal entry. Missing trade data is not an observed zero.</p>
    <p className="mb-3 text-sm text-muted-foreground">Verified active Pump curves: 0–95% progress with buy bias; score ≥40 after safety proof; top-10 ≤40% with a score penalty above 30%. Creator ≤10%, revoked authorities, benign extensions, permanent graduated LP protection and one pending signature remain required.</p>
    <Button variant="outline" data-testid="button-pump-hunt-preset" onClick={() => onChange({ ...form,
      pumpHuntEnabled: true, mode: 'live', riskMode: 'crazy', crazyStrategy: 'all',
      crazyMinLiquidityUsd: 600, crazyMinVolumeUsd: 0, crazyTop10Pct: 40, maxTopHolderPct: 40,
      confidenceThreshold: 40, normalEquityPct: 6, snipeEquityPct: 12,
      crazyMaxPositions: 3, dailyLossEquityPct: 20, crazySlippageBps: 1000,
      snipePriorityMultiplier: 2, readFailoverEnabled: true, adaptiveExitsEnabled: true,
      exitStrategy: 'moonbag', earlyTakeProfitPct: 60, earlySellPct: 45,
      takeProfitPct: 100, firstSellPct: 30, secondSellPct: 0, secondTakeProfitPct: 150,
      trailingStopPct: 15, stopLossPct: 20, maxHoldMinutes: 60, retainedTokenPct: 0.1,
    })}>Apply Pump hunt preset</Button>
    <label className="ml-4 inline-flex items-center gap-2 text-sm">
      <input type="checkbox" checked={form.pumpHuntEnabled ?? false} data-testid="check-pump-hunt"
        onChange={e => onChange({ ...form, pumpHuntEnabled: e.target.checked })} />Enable hunt rules
    </label>
    <p className="mt-3 text-xs text-muted-foreground">This prepares unsaved settings; it does not start trading. Review risks, save while paused, then use Start on Dashboard. Normal size 6%, qualified early snipe up to 12%, three concurrent positions, daily loss 20%. New exits: 45% at +60%, 30% at +100%, then 15% trailing from the first tier; 20% hard stop, maximum 45 minutes for snipes and 60 minutes otherwise. Existing positions retain their plans. No guaranteed gains or fills.</p>
  </Panel>;
}
