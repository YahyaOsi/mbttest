import { validMint } from "./discovery-policy";
import type { CrazyLeader, Settings } from "./types";

export function validateCopyTargets(settings: Settings): string | null {
  const targets = settings.copyTargets ?? [];
  if (targets.length > 10) return "Use at most ten copy targets.";
  const seen = new Set<string>();
  for (const target of targets) {
    if (target.wallet && !validMint(target.wallet)) return "Each supplied target wallet must be a valid Solana address.";
    if (target.platform !== "fomo" && !target.wallet) return "Wallet and X targets require an explicitly linked Solana wallet.";
    if (target.platform !== "wallet" && !/^@?[A-Za-z0-9_.-]{1,64}$/.test(target.username))
      return "Enter a valid X/FOMO username, not a profile URL.";
    const id = target.wallet || `fomo:${target.username.replace(/^@/, "").toLowerCase()}`;
    if (seen.has(id)) return "Remove duplicate copy targets.";
    seen.add(id);
  }
  return null;
}
/** Explicit wallet associations are owner assertions, never inferred from matching social handles. */
export function targetLeaders(settings: Settings, old: CrazyLeader[], linked: CrazyLeader[] = []): CrazyLeader[] {
  return (settings.copyTargets ?? []).flatMap(target => {
    if (target.platform === "wallet" ? !settings.copyTradingEnabled : !settings.trackFomoHandles) return [];
    const handle = target.username.replace(/^@/, "").toLowerCase();
    const resolved = target.wallet ? null : linked.find(l => l.handle.replace(/^@/, "").toLowerCase() === handle);
    const wallet = target.wallet || resolved?.wallet;
    if (!wallet) return [];
    const previous = old.find(l => l.wallet === wallet);
    return [{
      wallet, handle: target.username || wallet, rank: resolved?.rank ?? 0,
      losingCopies: previous?.losingCopies ?? 0, demoted: previous?.demoted ?? false,
      active: true, origin: target.wallet ? "target" as const : "username" as const,
    }];
  }).filter((leader, index, all) => all.findIndex(l => l.wallet === leader.wallet) === index);
}
