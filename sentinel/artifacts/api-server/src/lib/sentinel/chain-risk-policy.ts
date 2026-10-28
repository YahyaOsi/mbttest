import { SOL, USDC } from "./discovery-policy";
import { liquidityDrop } from "./exit-policy";

export type VaultPair = { pool: string; vaultA: string; vaultB: string; mintA: string; mintB: string; decimalsA: number; decimalsB: number; nativeB?: boolean; venue?: string };
const address = (v: any) => v?.pubkey?.toBase58?.() ?? v?.pubkey ?? "";
function amount(tx: any, side: "pre" | "post", account: string, mint: string): bigint | null {
  const index = tx.transaction.message.accountKeys.findIndex((k: any) => address(k) === account);
  const b = tx.meta?.[`${side}TokenBalances`]?.find((b: any) => b.accountIndex === index && b.mint === mint);
  return b && /^\d+$/.test(b.uiTokenAmount?.amount) ? BigInt(b.uiTokenAmount.amount) : null;
}
export function vaultSnapshot(tx: any, pool: VaultPair, prices: Record<string, number>) {
  if (!tx?.meta || tx.meta.err || !Number.isInteger(tx.slot)) return null;
  // Migration drains a curve intentionally. Reset coverage/baselines instead
  // of presenting graduation as a verified rug-pull.
  if (pool.venue && tx.meta.logMessages?.some((l: string) => /Instruction: (Migrate|Migration)/.test(l))) return null;
  const native = (side: "pre" | "post") => {
    const index = tx.transaction.message.accountKeys.findIndex((k: any) => address(k) === pool.vaultB);
    const n = tx.meta[`${side}Balances`]?.[index];
    return Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : null;
  };
  const a = amount(tx, "pre", pool.vaultA, pool.mintA), b = pool.nativeB ? native("pre") : amount(tx, "pre", pool.vaultB, pool.mintB);
  const c = amount(tx, "post", pool.vaultA, pool.mintA), d = pool.nativeB ? native("post") : amount(tx, "post", pool.vaultB, pool.mintB);
  if ([a, b, c, d].some(v => v === null) || !(prices[pool.mintA] > 0) || !(prices[pool.mintB] > 0)) return null;
  const value = (x: bigint, y: bigint) => Number(x) / 10 ** pool.decimalsA * prices[pool.mintA] + Number(y) / 10 ** pool.decimalsB * prices[pool.mintB];
  const before = value(a!, b!), after = value(c!, d!);
  return Number.isFinite(before) && before > 0 && Number.isFinite(after) && after >= 0 ? { before, after } : null;
}
// Only transaction signers count as wallets: a pool vault/authority must never
// be misidentified as a developer or a whale. Identity of a developer is unknown.
export function majorWalletOutflow(tx: any, mint: string, supply: bigint): string | null {
  if (!tx?.meta || tx.meta.err || supply <= 0n) return null;
  const balances = (side: "pre" | "post", owner: string, token: string): bigint =>
    (tx.meta[`${side}TokenBalances`] ?? []).filter((b: any) => b.owner === owner && b.mint === token)
      .reduce((n: bigint, b: any) => n + BigInt(b.uiTokenAmount.amount), 0n);
  for (const [i, key] of tx.transaction.message.accountKeys.entries()) {
    if (!key.signer) continue;
    const owner = address(key), before = balances("pre", owner, mint), sold = before - balances("post", owner, mint);
    if (before * 100n < supply || sold * 100n < supply || sold * 2n < before) continue;
    const nativeGain = tx.meta.postBalances[i] - tx.meta.preBalances[i];
    if (nativeGain > 0 || balances("post", owner, SOL) > balances("pre", owner, SOL) ||
        balances("post", owner, USDC) > balances("pre", owner, USDC)) return owner;
  }
  return null;
}
export function blockLiquidityDrop(samples: Map<string, { before: number; after: number }>, orderedSignatures: string[], pct = 30) {
  const observed = orderedSignatures.filter(s => samples.has(s)).map(s => samples.get(s)!);
  if (!observed.length) return false;
  // Missing transactions invalidate a block-level claim. Vault states must form
  // a continuous chain from the first observed change to the last observed one.
  for (let i = 1; i < observed.length; i++) {
    if (Math.abs(observed[i - 1].after - observed[i].before) > Math.max(0.000001, observed[i].before * 1e-10)) return false;
  }
  return liquidityDrop(observed[0].before, observed.at(-1)!.after, pct);
}
