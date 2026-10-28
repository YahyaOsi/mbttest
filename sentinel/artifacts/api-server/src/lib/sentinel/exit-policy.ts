import type { Position, Settings } from "./types";

export const moonbagPreset = {
  adaptiveExitsEnabled: false,
  exitStrategy: "moonbag" as const, takeProfitPct: 100, secondTakeProfitPct: 300,
  firstSellPct: 50, secondSellPct: 30,
};
export const launchpadExitPreset = {
  adaptiveExitsEnabled: false,
  exitStrategy: "moonbag" as const, takeProfitPct: 100, secondTakeProfitPct: 150,
  firstSellPct: 50, secondSellPct: 0, trailingStopPct: 15,
};
export function snapshotExitPlan(settings: Settings) {
  if (settings.exitStrategy !== "moonbag") return undefined;
  if (settings.firstSellPct + settings.secondSellPct >= 100) throw new Error("The first two tiers must leave a moon bag.");
  const adaptive = settings.adaptiveExitsEnabled ?? false;
  const early = adaptive ? settings.earlySellPct ?? 20 : 0;
  if (early + settings.firstSellPct + settings.secondSellPct >= 100) throw new Error("Profit tiers must leave a remainder.");
  return { firstTargetPct: settings.takeProfitPct, secondTargetPct: settings.secondTakeProfitPct,
    firstSellPct: settings.firstSellPct, secondSellPct: settings.secondSellPct, trailingStopPct: settings.trailingStopPct,
    ...(adaptive ? { adaptive: true, earlyTargetPct: settings.earlyTakeProfitPct ?? 60, earlySellPct: early,
      ...(settings.pumpHuntEnabled ? { trailAfterEarly: true } : {}) } : {}) };
}
const cumulativeTarget = (initial: bigint, pct: number) => initial * BigInt(Math.round(pct * 10000)) / 1_000_000n;
export function tierAmount(p: Position, tier: 0 | 1 | 2): bigint {
  if (!p.exitPlan || !p.rawInitial) throw new Error("Original confirmed token quantity is unavailable.");
  const initial = BigInt(p.rawInitial), remaining = BigInt(p.rawRemaining);
  if (initial <= 0n || remaining < 0n || remaining > initial) throw new Error("Invalid original/remaining token quantities.");
  const target = cumulativeTarget(initial, (p.exitPlan.earlySellPct ?? 0) +
    (tier > 0 ? p.exitPlan.firstSellPct : 0) + (tier === 2 ? p.exitPlan.secondSellPct : 0));
  const amount = target - (initial - remaining);
  return amount > 0n ? (amount < remaining ? amount : remaining) : 0n;
}
export function markExitFill(p: Position) {
  if (!p.exitPlan || !p.rawInitial) return;
  if (BigInt(p.rawRemaining) === 0n) return; // a forced full exit is not a filled profit tier
  p.earlyTierDone = tierAmount(p, 0) === 0n;
  p.firstTierDone = tierAmount(p, 1) === 0n;
  const wasSecond = p.secondTierDone;
  p.secondTierDone = tierAmount(p, 2) === 0n;
  if (p.secondTierDone && !wasSecond && p.lastExitPriceSol) p.highWaterPriceSol = p.lastExitPriceSol;
}
export function moonbagDecision(p: Position, gainPct: number, priceSol: number): { tier?: 0 | 1 | 2; full?: string } | null {
  const plan = p.exitPlan;
  if (!plan) return null;
  if ((plan.earlySellPct ?? 0) > 0 && !p.earlyTierDone && gainPct >= (plan.earlyTargetPct ?? 60)) return { tier: 0 };
  if (!p.firstTierDone && gainPct >= plan.firstTargetPct) return { tier: 1 };
  if (p.firstTierDone && !p.secondTierDone && gainPct >= plan.secondTargetPct) return { tier: 2 };
  const highGain = p.entryPriceUsd > 0 ? p.highWaterPriceUsd / p.entryPriceUsd - 1 : 0;
  const trail = plan.adaptive && !plan.trailAfterEarly ? Math.min(plan.trailingStopPct, highGain >= 3 ? 8 : highGain >= 1.5 ? 10 : plan.trailingStopPct) : plan.trailingStopPct;
  if ((p.secondTierDone || plan.trailAfterEarly && p.earlyTierDone) && priceSol <= p.highWaterPriceSol * (1 - trail / 100))
    return { full: plan.adaptive ? `Moon bag trailing stop (${trail}%)` : "Moon bag trailing stop" };
  return null;
}
export function liquidityDrop(previous: number, current: number, pct = 30): boolean {
  return Number.isFinite(previous) && previous > 0 && Number.isFinite(current) && current >= 0 && current <= previous * (1 - pct / 100);
}
