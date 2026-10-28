import { pumpActivity, recentPumpCreations } from "./pump-observations";
import type { Candidate, Settings } from "./types";
import { PUMP_PROGRAM } from "./curve-policy";
import { livePumpBurst, livePumpHint } from "./pump-live-feed";
import { confidence } from "./confidence";
import { huntActivity, huntCurve } from "./pump-hunt-policy";

export function hotPumpActivity(activity: { count: number; buys: number; sells: number; volumeSol: number }) {
  if (![activity.count, activity.buys, activity.sells, activity.volumeSol].every(Number.isFinite) ||
      activity.buys < 3 || activity.sells < 0 || activity.volumeSol < 0 || activity.count !== activity.buys + activity.sells) return false;
  return activity.buys > Math.max(1, activity.sells) * 3 ||
    activity.count >= 12 && activity.buys > activity.sells ||
    activity.volumeSol >= 1 && activity.buys >= Math.max(1, activity.sells) * 1.5;
}
export function freshPumpSignal(mint: string, at = Date.now()) {
  if (livePumpBurst(mint, at)) return true;
  const creation = recentPumpCreations().find(r => r.mint === mint && r.program === PUMP_PROGRAM.toBase58());
  return !!creation?.createdAt && at >= creation.createdAt && at - creation.createdAt <= 300_000 &&
    hotPumpActivity(pumpActivity(mint, at, 10_000));
}
/** Current canonical Pump proof is still mandatory; live activity or a fresh
 * verified copy signal may nominate the riskier early 0–95% window. */
export function curveProgressAllowed(c: Candidate, settings: Settings, progress: number | undefined, freshCopy = false) {
  if (huntCurve(c, settings)) return progress != null && progress >= 0 && progress <= 95 &&
    huntActivity(c) && c.buys5m >= c.sells5m;
  if (!Number.isFinite(progress)) return false;
  const ranked = confidence({ ...c, curveProgressPct: progress }, settings);
  const fast = settings.riskMode === "crazy" && c.launchpadVerification?.program === PUMP_PROGRAM.toBase58() &&
    c.launchpadVerification.phase === "active" &&
    (freshPumpSignal(c.mint) || freshCopy && !!livePumpHint(c.mint));
  return fast ? progress! >= 0 && progress! <= 95
    : settings.riskMode === "crazy" && ranked.high ? progress! >= 10 && progress! <= 60
    : progress! >= 15 && progress! <= 40;
}
