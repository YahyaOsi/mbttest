import type { TradingSettings } from '@workspace/api-client-react';
import { Panel } from '@/components/kit';

const fields = [
  ['normalEquityPct', 'Normal Crazy entry (% equity)', 1, 10, 1, 8],
  ['snipeEquityPct', 'High-confidence snipe (% equity)', 1, 15, 1, 15],
  ['dailyLossEquityPct', 'Daily loss cap (% equity)', 1, 25, 1, 20],
  ['retainedTokenPct', 'Permanent token holdback (%)', 0, 1, 0.1, 0.1],
  ['confidenceThreshold', 'Entry confidence (hunt) / high confidence', 35, 95, 1, 80],
  ['snipePriorityMultiplier', 'Snipe priority-fee multiplier', 1, 5, 0.1, 2],
  ['jitoMaxTipPct', 'Jito tip ceiling (% principal)', 0, 1, 0.05, 0.25],
  ['jitoMaxTipLamports', 'Jito absolute tip ceiling (lamports)', 0, 1000000, 1000, 100000],
  ['earlyTakeProfitPct', 'Early profit target (% SOL gain)', 30, 90, 1, 60],
  ['earlySellPct', 'Early sale (% original tokens)', 0, 50, 1, 20],
] as const;
export function ReliabilitySettings({ form, onChange }: { form: TradingSettings; onChange: (s: TradingSettings) => void }) {
  return <Panel title="Reliability & equity-aware risk">
    <p className="mb-4 text-sm text-muted-foreground">Changes apply to new entries after saving while paused. Existing exit plans and protected balances remain unchanged. Scores rank evidence; they are not win probabilities.</p>
    <div className="mb-4 flex flex-wrap gap-4">
      {([
        ['readFailoverEnabled', 'Allow verified secondary RPC read failover', true],
        ['jitoEnabled', 'Optional Jito bundles for Crazy snipes', false],
        ['adaptiveExitsEnabled', 'Adaptive exits and early profit tier', true],
      ] as const).map(([key, label, fallback]) => <label key={key} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form[key] ?? fallback} onChange={e => onChange({ ...form, [key]: e.target.checked })} data-testid={`check-${key}`} />{label}
      </label>)}
    </div>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {fields.map(([key, label, min, max, step, fallback]) => <label key={key} className="text-sm">{label}
        <input className="mt-1 w-full rounded border border-border bg-background p-2 font-mono" type="number"
          min={min} max={max} step={step} value={Number.isFinite(form[key] ?? fallback) ? form[key] ?? fallback : ''} data-testid={`input-${key}`}
          onChange={e => onChange({ ...form, [key]: e.target.value === '' ? NaN : Number(e.target.value) })} />
      </label>)}
    </div>
    <p className="mt-4 text-xs text-muted-foreground">Daily limit is the smaller of the dollar cap and percentage × smaller of current/day-start equity. Priority fees remain capped at 0.001 SOL. Jito tips are capped by both limits above, included atomically in the swap, and remain payable if identical bytes fall back to primary RPC. No bundle acceptance guarantees a fill. Set holdback to 0 to disable it for new positions.</p>
  </Panel>;
}
