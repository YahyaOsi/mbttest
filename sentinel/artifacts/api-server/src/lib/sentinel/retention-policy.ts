import type { Position } from "./types";

/** Round upward so even very small fills never sell more than 99%. */
export function protectedTokens(p: Position) {
  const initial = BigInt(p.rawInitial ?? p.rawRemaining);
  const units = BigInt(Math.round((p.retentionPct ?? 1) * 10000));
  p.retainedRaw ??= ((initial * units + 999999n) / 1000000n).toString();
  return BigInt(p.retainedRaw);
}
export function sellableTokens(p: Position) {
  const remaining = BigInt(p.rawRemaining), reserve = protectedTokens(p);
  return remaining > reserve ? remaining - reserve : 0n;
}
export function updateRetention(p: Position) {
  const remaining = BigInt(p.rawRemaining), reserve = protectedTokens(p);
  p.retainedQuantity = Number(remaining < reserve ? remaining : reserve) / 10 ** p.decimals;
  if (remaining > 0n && remaining <= reserve && p.status !== "pending") {
    p.status = "retained"; p.exitRetryReason = undefined;
    if (!p.exitReason?.includes("Permanent 1%")) p.exitReason = `${p.exitReason ?? "Sellable balance exhausted"}. Permanent 1% holdback — excluded from all bot sells, including emergency/manual exits.`;
  }
}
