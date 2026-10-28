import type { Candidate, Settings } from "./types";

/** Explicit owner-selected preset. Does not change run intent, stop latches or old positions. */
export const pumpHuntPreset = {
  pumpHuntEnabled: true, riskMode: "crazy" as const, crazyStrategy: "all" as const,
  crazyMinLiquidityUsd: 600, crazyMinVolumeUsd: 0, crazyTop10Pct: 40, maxTopHolderPct: 40,
  confidenceThreshold: 40, normalEquityPct: 6, snipeEquityPct: 12,
  crazyMaxPositions: 3, dailyLossEquityPct: 20, crazySlippageBps: 1000,
  snipePriorityMultiplier: 2, readFailoverEnabled: true,
  adaptiveExitsEnabled: true, exitStrategy: "moonbag" as const,
  earlyTakeProfitPct: 60, earlySellPct: 45, takeProfitPct: 100,
  firstSellPct: 30, secondSellPct: 0, secondTakeProfitPct: 150,
  trailingStopPct: 15, stopLossPct: 20, maxHoldMinutes: 60, retainedTokenPct: 0.1,
};
export const pumpHunt = (s: Settings) => s.riskMode === "crazy" && s.pumpHuntEnabled === true;
export const isPump = (c: Candidate) => c.launchpad === "Pump.fun";
export const huntCurve = (c: Candidate, s: Settings) => pumpHunt(s) && isPump(c) &&
  c.launchpadVerification?.phase === "active";
export const marketFreshnessMs = (s: Settings) => pumpHunt(s) ? 60_000 : 45_000;
export const sniperAgeSeconds = (s: Settings) => pumpHunt(s) ? 600 : 300;
export const holderCeiling = (s: Settings) => Math.min(s.crazyTop10Pct ?? 25, pumpHunt(s) ? 40 : 25);
export function huntActivity(c: Candidate) {
  return Number.isFinite(c.buys5m) && (c.buys5m >= 1 ||
    c.buys5m > 0 && (c.volume5mUsd ?? 0) >= 200);
}
export function strongHuntActivity(c: Candidate) {
  return huntActivity(c) && c.buys5m >= 3 && c.buys5m >= Math.max(1, c.sells5m) * 1.3 &&
    (c.volume5mUsd ?? 0) >= 200;
}
export function huntLiquidityFloor(c: Candidate, s: Settings) {
  const preferred = Math.max(600, s.crazyMinLiquidityUsd ?? 600);
  return preferred === 600 && strongHuntActivity(c) ? 400 : preferred;
}
export function huntSettingsProblem(s: Settings): string | null {
  if (!pumpHunt(s)) return s.maxTopHolderPct > 30 ? "Ordinary mode individual-holder limit cannot exceed 30%." : null;
  if ((s.normalEquityPct ?? 6) > 8 || (s.snipeEquityPct ?? 12) > 12 ||
      (s.crazyMaxPositions ?? 3) > 4 || (s.dailyLossEquityPct ?? 20) > 25 ||
      (s.retainedTokenPct ?? 0.1) > 0.5 || (s.crazySlippageBps ?? 1000) > 1200)
    return "Pump hunt limits: normal size ≤8%, snipe ≤12%, positions ≤4, daily loss ≤25%, holdback ≤0.5%, slippage ≤12%.";
  return null;
}
