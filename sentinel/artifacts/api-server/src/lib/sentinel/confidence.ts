import type { Candidate, Settings } from "./types";
import { holderCeiling, huntActivity, pumpHunt } from "./pump-hunt-policy";
// Keep the policy dependency-free: importing a sizing helper must not start or
// load the complete provider/SDK graph. The live feed registers its reader.
let evidence: (mint: string) => { burst: boolean; uniqueWallets: number } =
  () => ({ burst: false, uniqueWallets: 0 });
export function configureConfidenceEvidence(reader: typeof evidence) { evidence = reader; }

/** Ranking, not a probability and NEVER permission to bypass a safety ceiling. */
export function confidence(c: Candidate, settings: Settings) {
  const activity = evidence(c.mint);
  const burst = activity.burst;
  const ratio = c.buys5m / Math.max(1, c.sells5m);
  const top = c.observedTop10Pct;
  const progress = c.curveProgressPct;
  if (pumpHunt(settings)) {
    const ceiling = holderCeiling(settings);
    const parts = {
      liquidity: Math.min(15, Math.max(0, c.liquidityUsd / 600 * 15)),
      concentration: top == null ? 0 : top > 30 ? Math.max(0, (ceiling - top) / 10 * 8) : Math.max(0, 20 - top / 3),
      velocity: Math.min(20, Math.max(0, c.buys5m * 3)) * Math.min(1, ratio),
      volume: Math.min(15, Math.max(0, (c.volume5mUsd ?? 0) / 200 * 5)),
      progress: progress == null ? 5 : progress >= 0 && progress <= 30 ? 20 : progress <= 60 ? 15 : progress <= 95 ? 10 : 0,
      buyers: Math.min(10, activity.uniqueWallets * 2),
      burst: burst ? 10 : 0,
      ai: c.score != null && c.lastAiSweepAt && Date.now() - Date.parse(c.lastAiSweepAt) <= 600000 ? c.score / 40 : 1.25,
    };
    const score = Math.round(Math.min(100, Object.values(parts).reduce((n, v) => n + v, 0)));
    const strong = huntActivity(c) && c.buys5m >= 5 && ratio >= 2 && (c.volume5mUsd ?? 0) >= 200 &&
      Date.now() - Date.parse(c.updatedAt) <= 15000;
    return { score, eligible: score >= Math.max(35, settings.confidenceThreshold ?? 40), high:
      score >= Math.max(70, settings.confidenceThreshold ?? 40) && strong && top != null && top <= 30 &&
      progress != null && progress <= 40 && c.ageMinutes <= 10,
      burst, uniqueWallets: activity.uniqueWallets,
      reasons: Object.entries(parts).map(([k, v]) => `${k}=${v.toFixed(1)}`).concat([
        `buy/sell=${ratio.toFixed(2)}`, `uniqueBuyWallets=${activity.uniqueWallets}`,
        `strongFreshActivity=${strong}`, `hardTop10Ceiling=${ceiling}%`]) };
  }
  const parts = {
    liquidity: Math.min(20, Math.max(0, c.liquidityUsd / Math.max(1000, settings.crazyMinLiquidityUsd ?? 1000) * 5)),
    concentration: top == null ? 0 : Math.min(20, Math.max(0, 20 * (25 - top) / 15)),
    velocity: Math.min(20, c.buys5m / 2) * Math.min(1, ratio / 3),
    progress: progress == null ? 10 : progress >= 15 && progress <= 40 ? 20 : progress >= 10 && progress <= 60 ? 18 : 3,
    burst: burst ? 15 : 0,
    ai: c.score != null && c.lastAiSweepAt && Date.now() - Date.parse(c.lastAiSweepAt) <= 10 * 60000
      ? c.score / 20 : 2.5,
  };
  const score = Math.round(Math.min(100, Object.values(parts).reduce((n, v) => n + v, 0)));
  const strong = ratio >= 3 && c.buys5m >= 10 && (c.volume5mUsd ?? 0) >= 500 &&
    Date.now() - Date.parse(c.updatedAt) <= 15000;
  const high = score >= (settings.confidenceThreshold ?? 80) && strong && top != null && top < 25;
  return { score, high, burst, uniqueWallets: activity.uniqueWallets,
    reasons: Object.entries(parts).map(([k, v]) => `${k}=${v.toFixed(1)}`).concat([
      `buy/sell=${ratio.toFixed(2)}`, `uniqueBuyWallets=${activity.uniqueWallets}`,
      `strongFreshActivity=${strong}`, `hardTop10Ceiling=25%`,
    ]) };
}
