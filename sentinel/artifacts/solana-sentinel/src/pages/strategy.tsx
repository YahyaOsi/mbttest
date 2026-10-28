import { useEffect, useRef, useState } from 'react';
import { Save, Undo2 } from 'lucide-react';
import { useUpdateSettings, type TradingSettings } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useInvalidateAll, useSettingsQ } from '@/hooks/use-sentinel';
import { Confirm, Disclosure, ErrorBlock, PageHeader, Panel, Pill, Skeleton } from '@/components/kit';
import { errMsg } from '@/lib/format';
import { HighRiskSettings } from '@/components/high-risk-settings';
import { ReliabilitySettings } from '@/components/reliability-settings';
import { ExecutionDiagnostics } from '@/components/execution-diagnostics';
import { CopyTargets, copyTargetsInvalid } from '@/components/copy-targets';
import { EffectiveTradingRules } from '@/components/effective-trading-rules';
import { PumpHuntSettings } from '@/components/pump-hunt-settings';

type NumKey = { [K in keyof TradingSettings]-?: TradingSettings[K] extends number ? K : never }[keyof TradingSettings];
type F = { k: NumKey; label: string; min: number; max: number; step: number; unit: string; hint: string };
const GROUPS: { title: string; fields: F[] }[] = [
  { title: 'Capital and limits', fields: [
    { k: 'paperBalanceUsd', label: 'Paper balance', min: 1, max: 100000, step: 1, unit: 'USD', hint: 'Starting balance for the simulated account.' },
    { k: 'positionSizeUsd', label: 'Conservative position size', min: 0.5, max: 100, step: 0.5, unit: 'USD', hint: 'Crazy Mode uses its equity percentage, without this dollar cap.' },
    { k: 'maxPositions', label: 'Conservative position slots', min: 1, max: 5, step: 1, unit: '', hint: 'Crazy Mode has its own maximum open positions above.' },
    { k: 'solReserve', label: 'Protected SOL reserve', min: 0.003, max: 1, step: 0.001, unit: 'SOL', hint: 'Never spent on new entries. Reserved for network fees, token account rent and exits.' },
    { k: 'dailyLossLimitUsd', label: 'Daily loss limit', min: 0.1, max: 100, step: 0.1, unit: 'USD', hint: 'Equity drawdown from the UTC-day baseline; stops entries and attempts exits.' } ] },
  { title: 'Entry filters', fields: [
    { k: 'minLiquidityUsd', label: 'Conservative min liquidity', min: 10000, max: 100000000, step: 1000, unit: 'USD', hint: 'Crazy Mode uses its separate liquidity floor above.' },
    { k: 'minVolumeUsd', label: 'Conservative min 24h volume', min: 1000, max: 100000000, step: 1000, unit: 'USD', hint: 'Crazy Mode uses its separate volume floor above.' },
    { k: 'minAgeMinutes', label: 'Min token age', min: 30, max: 100000, step: 5, unit: 'min', hint: '' },
    { k: 'maxTopHolderPct', label: 'Max top-holder share', min: 1, max: 40, step: 0.5, unit: '%', hint: 'Ordinary mode maximum 30%; explicit Pump hunt maximum 40%. Creator still cannot hold over 10%.' },
    { k: 'maxPriceImpactPct', label: 'Max price impact', min: 0.1, max: 5, step: 0.1, unit: '%', hint: 'Quoted impact of your own order.' },
    { k: 'curveMinLiquidityUsd', label: 'Launchpad curve min liquidity', min: 1000, max: 100000000, step: 500, unit: 'USD', hint: 'Only for on-chain verified pre-migration curves. Pump.fun and DBC use real SOL reserves, not virtual liquidity.' },
    { k: 'curveMinAgeMinutes', label: 'Launchpad curve min age', min: 1, max: 100000, step: 1, unit: 'min', hint: 'Only for verified pre-migration curves.' },
    { k: 'minAiScore', label: 'Min evidence score', min: 60, max: 99, step: 1, unit: '/100', hint: 'An AI ranking of the evidence, not a win probability.' } ] },
  { title: 'Schedule and AI costs', fields: [
    { k: 'scanIntervalMinutes', label: 'Market scan interval', min: 1, max: 240, step: 1, unit: 'min', hint: 'Cheap market discovery and entry filters. Separate from paid AI calls.' },
    { k: 'aiIntervalMinutes', label: 'Minimum AI interval', min: 1, max: 1440, step: 1, unit: 'min', hint: 'Global spacing between paid requests, including manual Analyze actions. 30 minutes = at most twice per hour.' },
    { k: 'aiCacheMinutes', label: 'Reuse unchanged AI evidence', min: 1, max: 1440, step: 1, unit: 'min', hint: 'Reuse only while market evidence remains similar; fresh entry and on-chain safety checks still apply.' },
    { k: 'maxAiCallsPerDay', label: 'Hard daily AI request cap', min: 0, max: 1440, step: 1, unit: 'calls', hint: 'Default 100/day. Set 0 to disable paid AI; deterministic entries remain available. AI is advisory in Crazy Mode. No automatic billed retries.' } ] },
  { title: 'Execution', fields: [
    { k: 'slippageBps', label: 'Slippage tolerance', min: 10, max: 300, step: 5, unit: 'bps', hint: '100 bps = 1%. Higher fills more often at worse prices.' },
    { k: 'emergencySlippageBps', label: 'Emergency slippage cap', min: 10, max: 1000, step: 10, unit: 'bps', hint: 'Only urgent full exits. Default 300 bps (3%); never unlimited.' },
    { k: 'emergencyMaxPriceImpactPct', label: 'Emergency price-impact cap', min: 0.1, max: 20, step: 0.1, unit: '%', hint: 'Only urgent full exits. Default 5%; a blocked route remains exposed.' } ] },
  { title: 'Exits', fields: [
    { k: 'stopLossPct', label: 'Stop loss', min: 1, max: 30, step: 0.5, unit: '%', hint: 'Not a guaranteed price; gaps and failed sells can exceed it.' },
    { k: 'takeProfitPct', label: 'Take profit', min: 1, max: 500, step: 1, unit: '% SOL', hint: 'Profit targets use net SOL returns, not a USD gain caused only by SOL appreciation.' },
    { k: 'secondTakeProfitPct', label: 'Second take profit', min: 2, max: 1000, step: 1, unit: '%', hint: 'Used by staged exits.' },
    { k: 'firstSellPct', label: 'Tier 1 portion', min: 10, max: 90, step: 1, unit: '%', hint: 'Moon-bag mode: percent of the original confirmed token quantity.' },
    { k: 'secondSellPct', label: 'Tier 2 portion', min: 0, max: 80, step: 1, unit: '% original', hint: 'Default 20%. Set 0 to disable this tier. The snapshotted holdback remains protected; all tiers must leave a remainder.' },
    { k: 'trailingStopPct', label: 'Trailing stop', min: 1, max: 30, step: 0.5, unit: '%', hint: 'Moon-bag mode: activates after the last configured sale tier, using executable token→SOL quote prices.' },
    { k: 'maxHoldMinutes', label: 'Max hold time', min: 5, max: 1440, step: 5, unit: 'min', hint: 'Applies before the moon-bag phase. After Tier 2, trailing/risk exits manage the remainder without a time limit.' } ] },
];
const ALL = GROUPS.flatMap((g) => g.fields);
const input = 'h-9 w-full rounded-md border border-input bg-background px-2.5 mono text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20';

export default function Strategy() {
  const { data, isLoading, error, refetch } = useSettingsQ();
  const [form, setForm] = useState<TradingSettings | null>(null);
  const [confirm, setConfirm] = useState(false);
  const inited = useRef(false);
  const inv = useInvalidateAll();
  const { toast } = useToast();
  useEffect(() => { if (data && !inited.current) { inited.current = true; setForm(data); } }, [data]);
  const save = useUpdateSettings({
    mutation: {
      onSuccess: (s) => { setForm(s); toast({ title: 'Strategy saved' }); inv(); },
      onError: (e) => toast({ title: 'Could not save', description: errMsg(e), variant: 'destructive' }),
    },
  });

  if (isLoading || (!form && !error)) return <><PageHeader kicker="Risk" title="Strategy" /><Skeleton rows={8} /></>;
  if (error || !data || !form) return <ErrorBlock error={error} onRetry={() => refetch()} />;
  const bad = ALL.filter((f) => !Number.isFinite(form[f.k]) || form[f.k] < f.min || form[f.k] > f.max);
  const dirty = JSON.stringify(form) !== JSON.stringify(data);
  const modeChanged = form.mode !== data.mode;
  const needsConfirm = form.mode === 'live' || modeChanged;
  const doSave = () => { setConfirm(false); save.mutate({ data: form }); };
  const set = <K extends keyof TradingSettings>(k: K, v: TradingSettings[K]) => setForm({ ...form, [k]: v });
  const tierError = form.secondTakeProfitPct <= form.takeProfitPct || (form.exitStrategy === 'moonbag' && form.firstSellPct + form.secondSellPct >= 100);
  const crazyBad = form.riskMode === 'crazy' && (!form.crazyAcknowledged ||
    !Number.isFinite(form.crazyEquityPct) || form.crazyEquityPct! < 0.1 || form.crazyEquityPct! > 20 ||
    !Number.isFinite(form.crazyMinLiquidityUsd) || form.crazyMinLiquidityUsd! < (form.pumpHuntEnabled ? 400 : 1000) || form.crazyMinLiquidityUsd! > 100000000 ||
    !Number.isFinite(form.crazyMinVolumeUsd) || form.crazyMinVolumeUsd! < 0 || form.crazyMinVolumeUsd! > 100000000 ||
    !Number.isInteger(form.crazyMaxPositions) || form.crazyMaxPositions! < 1 || form.crazyMaxPositions! > 5 ||
    !Number.isInteger(form.crazySlippageBps) || form.crazySlippageBps! < 100 || form.crazySlippageBps! > 1500 ||
    !Number.isFinite(form.crazyTop10Pct) || form.crazyTop10Pct! < 1 || form.crazyTop10Pct! > 50 ||
    !Number.isFinite(form.crazyWalletAllocationPct) || form.crazyWalletAllocationPct! < 1 || form.crazyWalletAllocationPct! > 30);
  const blocked = bad.length > 0 || copyTargetsInvalid(form) || tierError || crazyBad || (form.mode === 'live' && !form.acknowledgeRisk);

  return (
    <>
      <PageHeader kicker="Risk and exits" title="Strategy"
        actions={<>
          <Button variant="ghost" disabled={!dirty} onClick={() => setForm(data)} data-testid="button-revert"><Undo2 className="h-4 w-4" />Revert</Button>
          <Button disabled={!dirty || blocked || save.isPending} onClick={() => (needsConfirm ? setConfirm(true) : doSave())} data-testid="button-save"><Save className="h-4 w-4" />{save.isPending ? 'Saving…' : 'Save changes'}</Button>
        </>}>
        Changes apply to future decisions. Existing positions keep managing exits. Backend limits are enforced; fields outside range are flagged.
      </PageHeader>
      <PumpHuntSettings form={form} onChange={setForm} />
      <HighRiskSettings form={form} onChange={setForm} />
      <ReliabilitySettings form={form} onChange={setForm} />
      <ExecutionDiagnostics />
      <div className="mb-4"><EffectiveTradingRules settings={form} preview={dirty} /></div>
      <CopyTargets form={form} onChange={setForm} />
      <Panel title="Snapshot profit tiers & adaptive trailing" className="mb-4">
        <p className="text-sm text-muted-foreground">New defaults: 20% of original tokens at +60%, 50% at +100%, 20% at +150%, then trail the remainder. Adaptive trailing tightens after large moves; volatility stops never exceed the hard stop. Protected holdback defaults to 0.1% for new fills and is configurable above. Existing positions retain their snapshots. Curve progress is normally 15–40%; high confidence plus strong fresh buying can qualify at 10–60%, and a verified live Pump/copy signal can nominate the riskier early window up to 95%. Creator holdings must stay at or below 10%, and observed top-ten non-curve holdings below 25%. The sample is the largest 20 token accounts grouped by wallet, not a complete ranking. No exit price or profit is guaranteed.</p>
        <Button type="button" variant="outline" className="mt-3" data-testid="button-moonbag-preset" onClick={() => setForm({
          ...form, exitStrategy: 'moonbag', takeProfitPct: 100, secondTakeProfitPct: 150, firstSellPct: 50, secondSellPct: 20, trailingStopPct: 15,
          adaptiveExitsEnabled: true, earlyTakeProfitPct: 60, earlySellPct: 20,
        })}>Apply 60% / 100% / 150% adaptive plan</Button>
        <p className="mt-3 text-xs text-muted-foreground">Save to apply to future entries. New positions snapshot their tier percentages/targets; old positions keep their prior exit plan. Stop-loss, emergency and daily-loss controls override profit tiers. No AI call is needed to trigger an exit.</p>
        {tierError && <p role="alert" className="mt-2 text-sm text-destructive">Tier 2 must exceed Tier 1, and the two sell portions must leave a positive moon bag.</p>}
      </Panel>
      <Panel title="DEX fallback and emergency alerts" className="mb-4">
        <p className="text-sm text-muted-foreground">Qualified SOL trades try Jupiter, direct Raydium, then supported native Pump.fun / Meteora DBC curves. Local SDK quotes use verified on-chain state, fees and real reserves. Only one atomic exact-input transaction passing signer, authority/delegate, encoded minimum-output, native SOL balance and fee checks can be signed. Failed or ambiguous submissions are reconciled, never replaced with a second order.</p>
        <p className="mt-2 text-xs text-muted-foreground">A 30% observed liquidity drop or excessive sell pressure attempts a full exit. Live RPC subscriptions also inspect continuous confirmed-block holdings changes in verified Raydium CPMM/CLMM and supported launchpad mappings. Pump native holdings include rent/accrued fees; migration events are excluded. Missing mappings/events and RPC limits leave coverage gaps, not a universal single-block alert guarantee. Major signer outflows can trigger an emergency stop, but developer identity is not verified. No X/Fomo alert feed is connected.</p>
        <p className="mt-2 text-xs text-muted-foreground">Block monitoring is limited to verified pools and RPC event delivery, capped at 60 decoded transactions/minute per position with a bounded queue. Coverage can be incomplete; see Positions for status. Busy operations, provider outages, slippage and confirmation can delay or prevent exits. No instant exit or small-loss guarantee. RPC usage is separate from AI costs. Emergency defaults: 3% slippage and 5% price impact, configurable below.</p>
      </Panel>
      <Panel title="Verified launchpad entries" className="mb-4">
        <label className="flex cursor-pointer items-start gap-2 text-sm"><input type="checkbox" checked={form.launchpadCurvesEnabled} onChange={(e) => set('launchpadCurvesEnabled', e.target.checked)} data-testid="check-launchpad-curves" className="mt-1 h-4 w-4 accent-[hsl(188_62%_20%)]" />
          <span><span className="font-medium">Allow verified Pump.fun and Moonit CP-V1 entries</span><span className="block text-muted-foreground">Active curves use native-only execution; wider progress windows require the qualified evidence described above. No traditional LP lock is required for a verified active curve. Graduated Pump.fun needs a verified canonical PumpSwap route. Ordinary SOL-pair tokens require supported Raydium pools with fully burned or permanently inaccessible LP; unknown lockers and partial burns stay blocked. Protective exits preserve each position’s snapshotted holdback. New holdbacks are configurable; existing protected balances are not reduced.</span></span></label>
        <p className="mt-3 text-xs text-muted-foreground">Only the verified phase's canonical curve/pool vault is excluded from holder concentration; the limit still applies to creators and snipers. Real SOL reserves determine liquidity. Mint/freeze and extension checks, buy activity, price impact, reverse quotes, AI evidence/budget, position sizing and daily loss caps remain mandatory. Migrating curves without a separately verified graduated PumpSwap path, graduated Moonit pools, unsupported Moonit variants, Pump mayhem/cashback, non-SOL pairs, hooks and unknown layouts stay blocked. Program identities do not prove immutable code or token safety. Migration resets the liquidity baseline; missing sell routes are retried for up to 30 minutes. LaunchLab / LetsBonk curves are not covered. Native fills have not been tested with funds; that needs a separately approved capped test. Creators or snipers can dump faster than monitoring can react.</p>
      </Panel>
      <Panel title="Selective small-wallet strategy" className="mb-4">
        <p className="text-sm text-muted-foreground mb-3">At most $5.50 principal per entry, one position at a time, and three entry attempts per UTC day. No $20 override or automatic averaging down. Zero trades is acceptable when evidence is weak.</p>
        <Button variant="outline" data-testid="button-selective-preset" onClick={() => setForm({
          ...form, positionSizeUsd: 5.5, maxPositions: 1, maxEntriesPerDay: 3,
          minAiScore: 92, minLiquidityUsd: 10000, curveMinLiquidityUsd: 10000, minVolumeUsd: 100000,
          minAgeMinutes: 180, maxTopHolderPct: 10, maxPriceImpactPct: 0.5,
          dailyLossLimitUsd: 2, slippageBps: 75, scanIntervalMinutes: 2,
          aiIntervalMinutes: 60, aiCacheMinutes: 60, maxAiCallsPerDay: 12,
        })}>Apply selective $5.50 preset</Button>
        <p className="text-xs text-muted-foreground mt-3">Review and Save changes to apply. Preserves mode, risk acknowledgement and exit rules. The 92/100 evidence score is not a 92% win probability. Fees and token-account rent are additional to buy principal.</p>
        <p className="text-xs text-muted-foreground mt-3">Liquidity floor: $20,000. Smaller pools increase slippage and failed-exit risk; price-impact, reverse-quote and fee-reserve checks still apply. Before entry, mandatory scam-risk screens check standard SPL mint/freeze authority, token-account concentration, pool age/activity and AI red flags. These do not certify liquidity locks, creator history or authentic volume. X and Fomo are not connected.</p>
      </Panel>
      <Panel title="Cost-saving schedule" className="mb-4">
        <div className="flex flex-wrap gap-2">
          {[
            { label: 'Low cost · hourly AI', scan: 5, ai: 60, cache: 60, cap: 12 },
            { label: 'Balanced · AI every 15m', scan: 5, ai: 15, cache: 30, cap: 48 },
            { label: 'Fast · every minute', scan: 1, ai: 1, cache: 5, cap: 1440 },
          ].map(p => <Button key={p.label} type="button" variant="outline" onClick={() => setForm({ ...form, scanIntervalMinutes: p.scan, aiIntervalMinutes: p.ai, aiCacheMinutes: p.cache, maxAiCallsPerDay: p.cap })}>{p.label}</Button>)}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">Discovery AI cycles every 10 minutes and watchlist cycles every 5 minutes (binary BUY or REJECT; REJECT is permanent immediately, BUY triggers a fresh safety-gated entry only while you have the bot running), with transport pages for larger queues. All scheduled and entry-analysis calls share your maximum {form.maxAiCallsPerDay} paid requests per UTC day. Missed/provider-blocked work remains queued; cadence is best effort. Daily loss protection remains, with no daily trade-count cap. AI has no social/search access and never guarantees a win.</p>
        <p className="mt-2 text-xs text-muted-foreground">Exit monitoring stays at 15 seconds and does not call AI. The fast preset can use 1,440 requests/day and cost far more than a $10 trading balance. Request counts are not a dollar spending cap; usage depends on tokens and provider pricing.</p>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Trading mode" className="lg:col-span-2">
          <div className="flex flex-wrap items-start gap-6">
            <div className="flex overflow-hidden rounded-md border border-border" role="group">
              {(['paper', 'live'] as const).map((m) => (
                <button key={m} type="button" onClick={() => set('mode', m)} data-testid={`mode-${m}`} className={`press mono px-4 py-2 text-xs uppercase tracking-wider ${form.mode === m ? (m === 'live' ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground') : 'bg-card text-muted-foreground'}`}>{m === 'live' ? 'Mainnet' : 'Paper'}</button>))}
            </div>
            <div className="max-w-xl text-sm text-muted-foreground">
              {form.mode === 'live' ? <p>Mainnet uses a server-held burner key: SOL → token → SOL, without a browser wallet connection or USDC funding. USD position limits are converted to SOL using a fresh price. Setup gates still apply.</p> : <p>Paper mode simulates SOL → token → SOL fills, including estimated fees and account rent. Simulated fills cannot reproduce real landing failures.</p>}
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-foreground"><input type="checkbox" checked={form.acknowledgeRisk} onChange={(e) => set('acknowledgeRisk', e.target.checked)} data-testid="check-ack" className="mt-1 h-4 w-4 accent-[hsl(188_62%_20%)]" />
                <span>I understand this can lose all funds, pays fees and slippage, may fail to exit, and guarantees nothing. AI and hosting costs are separate from trading capital. A server-held signing key exposes the dedicated wallet balance.</span></label>
              {form.mode === 'live' && !form.acknowledgeRisk && <Pill tone="warn">Acknowledgement required</Pill>}
            </div>
          </div>
        </Panel>
        {GROUPS.map((g) => (
          <Panel key={g.title} title={g.title}>
            <div className="grid gap-3 sm:grid-cols-2">
              {g.fields.map((f) => {
                const invalid = bad.includes(f);
                return (
                  <label key={f.k} className="block">
                    <span className="flex items-baseline justify-between text-xs font-medium"><span>{f.label}</span><span className="mono text-[10px] text-muted-foreground">{f.min}–{f.max} {f.unit}</span></span>
                    <input type="number" step={f.step} min={f.min} max={f.max} value={Number.isFinite(form[f.k]) ? form[f.k] : ''} onChange={(e) => set(f.k, e.target.value === '' ? NaN : Number(e.target.value))} data-testid={`input-${f.k}`} aria-invalid={invalid} className={`${input} mt-1 ${invalid ? 'border-destructive' : ''}`} />
                    {invalid ? <span className="text-[11px] text-destructive">Must be between {f.min} and {f.max}</span> : f.hint && <span className="text-[11px] text-muted-foreground">{f.hint}</span>}
                  </label>);
              })}
              {g.title === 'Exits' && (
                <label className="block sm:col-span-2"><span className="text-xs font-medium">Exit strategy</span>
                  <div className="mt-1 flex flex-wrap gap-1">{(['full', 'staged', 'adaptive', 'moonbag'] as const).map((s) => (
                    <button key={s} type="button" onClick={() => set('exitStrategy', s)} data-testid={`exit-${s}`} className={`press mono flex-1 rounded-md border px-2 py-2 text-xs uppercase tracking-wider ${form.exitStrategy === s ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground'}`}>{s === 'moonbag' ? 'Moon bag' : s}</button>))}</div></label>)}
            </div>
          </Panel>))}
      </div>
      <div className="mt-4"><Disclosure /></div>
      <Confirm open={confirm} onOpenChange={setConfirm} title={modeChanged ? `Switch to ${form.mode === 'live' ? 'mainnet' : 'paper'} mode?` : 'Save mainnet settings?'} confirmLabel="Confirm and save" danger={form.mode === 'live'} onConfirm={doSave}>
        <p>{form.mode === 'live' ? 'These settings govern trades made with real funds.' : 'The bot will stop trading real funds for new entries.'}</p><p>{form.riskMode === 'crazy'
          ? `Crazy Mode: ${form.normalEquityPct ?? 8}% equity per normal entry; up to ${form.snipeEquityPct ?? 15}% only for qualified high-confidence snipes; ${form.crazyMaxPositions} position slots; slippage cap ${form.crazySlippageBps} bps. No daily trade-count cap. Daily loss is capped by both $${form.dailyLossLimitUsd} and ${form.dailyLossEquityPct ?? 20}% of the smaller current/day-start equity. ${form.pumpHuntEnabled ? 'Pump hunt rules enabled. Saving does not start trading.' : ''}`
          : `Position size ${form.positionSizeUsd} USD, stop loss ${form.stopLossPct}%, slippage ${form.slippageBps} bps.`}</p>
      </Confirm>
    </>
  );
}
