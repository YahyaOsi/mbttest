import { PublicKey } from "@solana/web3.js";
import { unpackAccount, unpackMint } from "@solana/spl-token";
import { rpc } from "./chain";
import { tokenAddress } from "./token-policy";
import { TradingError } from "./store";
import type { Candidate, Settings } from "./types";
import { pumpSnapshot } from "./pump-snapshot";
import { setPumpCreatorBaseline, pumpCreatorCheckpoint } from "./pump-observations";
import { moonitOrigin, moonitState } from "./moonit-state";
import { verifyLaunchpadEntry } from "./launchpad-entry";
import { lockedPoolState } from "./locked-pool";
import { holderCeiling, pumpHunt } from "./pump-hunt-policy";
const safetySnapshot = (mint: string, connection = rpc()) => moonitOrigin(mint) ? moonitState(connection, new PublicKey(mint), true, false) : pumpSnapshot(mint);

export async function seedPumpCreatorMonitor(mint: string) {
  const pump = await safetySnapshot(mint);
  if (!pump.creator || pump.creator.equals(PublicKey.default)) return;
  const portfolio = await rpc().getTokenAccountsByOwner(pump.creator, { mint: new PublicKey(mint) }, "confirmed");
  const held = portfolio.value.reduce((sum, item) => sum + unpackAccount(item.pubkey, item.account, pump.supported.program).amount, 0n);
  setPumpCreatorBaseline(mint, pump.creator.toBase58(), held, portfolio.context.slot);
  return pumpCreatorCheckpoint(mint);
}

/** Age evidence remains required for Sniper, independently of LP burn/locks. */
export function candidateOpenTime(c: Candidate) {
  const observedAt = Date.parse(c.updatedAt);
  if (!Number.isFinite(observedAt) || observedAt > Date.now() || !Number.isFinite(c.ageMinutes) || c.ageMinutes < 0)
    throw new TradingError("Pool age evidence unavailable.");
  return observedAt / 1000 - c.ageMinutes * 60;
}
export async function checkCrazySafety(c: Candidate, settings: Settings, connection = rpc()) {
  const openTime = candidateOpenTime(c);
  const mint = new PublicKey(c.mint);
  const [mintAccount, largest] = await Promise.all([connection.getAccountInfo(mint), connection.getTokenLargestAccounts(mint)]);
  if (!mintAccount) throw new TradingError("Top-10 holder supply unavailable.");
  const supply = unpackMint(mint, mintAccount, mintAccount.owner).supply;
  if (supply <= 0n || !largest.value.length) throw new TradingError("Top-10 holder information unavailable.");
  const locked = c.lpVerification ? await lockedPoolState(connection, mint, c.lpVerification.pool) : null;
  const pump = locked ? null : await safetySnapshot(c.mint, connection);
  if (pump && (!pump.creator || pump.creator.equals(PublicKey.default))) throw new TradingError("Verified launch creator unavailable; no buy.");
  const portfolio = pump ? await connection.getTokenAccountsByOwner(pump.creator, { mint }, "confirmed") : null;
  const held = portfolio?.value.reduce((total, item) => total + unpackAccount(item.pubkey, item.account, mintAccount.owner).amount, 0n) ?? 0n;
  const creatorHoldingPct = Number(held * 1000000n / supply) / 10000;
  c.creatorHoldingPct = pump ? creatorHoldingPct : undefined;
  if (held * 100n > supply * 10n) throw new TradingError("Creator holds over 10% of total supply.");
  if (pump && portfolio) setPumpCreatorBaseline(c.mint, pump.creator.toBase58(), held, portfolio.context.slot);
  const wallets = new Map<string, bigint>();
  const migrated = pump && "complete" in pump.curve && pump.curve.complete ? await verifyLaunchpadEntry(c.mint) : null;
  const curveVault = locked ? locked.baseVault : migrated?.phase === "graduated" ? migrated.baseVault : tokenAddress(pump!.pool, mint, pump!.supported.program);
  const vaultAuthority = locked ? locked.authority : migrated?.phase === "graduated" ? migrated.pool : pump!.pool;
  let sampled = 0n;
  for (let i = 0; i < largest.value.length; i += 5) {
    const batch = largest.value.slice(i, i + 5);
    const accounts = await connection.getMultipleAccountsInfo(batch.map(h => h.address));
    if (accounts.length !== batch.length)
      throw new TradingError("Incomplete holder account response; retry current evidence.");
    const decoded = accounts.map((account, j) => {
      if (!account) throw new TradingError("Top-10 holder account unavailable; no trade.");
      const token = unpackAccount(batch[j].address, account, mintAccount.owner);
      if (!token.mint.equals(mint)) throw new TradingError("Holder account mint mismatch.");
      return token;
    });
    for (let j = 0; j < decoded.length; j++) {
      const token = decoded[j]; sampled += token.amount;
      // Only the verified adapter's phase-specific canonical vault is excluded.
      if (batch[j].address.equals(curveVault) && token.owner.equals(vaultAuthority)) continue;
      const owner = token.owner.toBase58();
      wallets.set(owner, (wallets.get(owner) ?? 0n) + token.amount);
    }
  }
  const nonVault = [...wallets.values()].sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  if (sampled > supply) throw new TradingError("Holder observations changed/inconsistent; retry current evidence.");
  const top10 = nonVault.slice(0, 10).reduce((n, v) => n + v, 0n);
  // This RPC returns the largest 20 TOKEN ACCOUNTS, not the full wallet
  // ranking. Aggregate actual sampled balances by owner; never invent a
  // holder for unsampled supply. Missing account reads above still fail closed.
  const top10Pct = Number(top10 * 1000000n / supply) / 10000;
  c.observedTop10Pct = top10Pct;
  const limit = holderCeiling(settings);
  if (pumpHunt(settings) ? top10 * 1_000_000n > supply * BigInt(Math.round(limit * 10000))
    : top10 * 1_000_000n >= supply * BigInt(Math.round(limit * 10000)))
    throw new TradingError(`Observed top-10 non-curve wallet share ${top10Pct.toFixed(2)}% in the largest-20 account sample; must be below ${limit}%.`);
  return { openTime: locked?.openTime ?? openTime, top10Pct, creatorHoldingPct: locked ? undefined : creatorHoldingPct,
    holderAccountsObserved: largest.value.length, holderCoveragePct: Number(sampled * 1000000n / supply) / 10000 };
}
