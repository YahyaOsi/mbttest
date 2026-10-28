// Native SOL swaps wrap/unwrap WSOL inside the transaction. Their final cash
// movement must be taken from wallet lamports, not a persistent WSOL account.
export function nativeSwapDelta(walletBefore: number, walletAfter: number, fee: number, rentDelta: number) {
  return BigInt(walletAfter) - BigInt(walletBefore) + BigInt(fee) + BigInt(rentDelta);
}
export function assertNativeSwap(
  direction: "buy" | "sell", nativeDelta: bigint, tokenDelta: bigint,
  inputAmount: bigint, minimumOutput: bigint,
) {
  if (direction === "buy") {
    if (-nativeDelta !== inputAmount || tokenDelta < minimumOutput) throw new Error("Native buy simulation does not match the exact authorized amounts.");
  } else if (-tokenDelta !== inputAmount || nativeDelta < minimumOutput) {
    throw new Error("Native sell simulation does not match the authorized amounts.");
  }
}
export function solFill(direction: "buy" | "sell", before: number, after: number) {
  const lamports = direction === "buy" ? before - after : after - before;
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error("Native cash movement is invalid or not positive.");
  return lamports / 1e9;
}
export function solReturnPct(costSol: number, netExitSol: number) {
  return costSol > 0 ? (netExitSol - costSol) / costSol * 100 : 0;
}
