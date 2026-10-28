import type { Connection, VersionedTransactionResponse } from "@solana/web3.js";
import type { PendingOrder, State } from "./types";

type ExpiryRpc = Pick<Connection, "getLatestBlockhashAndContext" | "getBlockHeight" |
  "isBlockhashValid" | "getSignatureStatuses" | "getTransaction">;
type Result = { kind: "waiting" } | { kind: "expired" } |
  { kind: "landed"; transaction: VersionedTransactionResponse };

/** A null status and wall-clock age are NOT proof of a dropped transaction.
 * Establish a newer recent-blockhash fence, wait until the finalized chain
 * exceeds its validity height, then independently recheck transaction history.
 * This also handles legacy native orders whose original blockhash wasn't saved.
 * Durable-nonce/unknown legacy transactions cannot use this expiry proof.
 */
export async function inspectMissingPending(order: PendingOrder, rpc: ExpiryRpc, observedSlot: number): Promise<Result> {
  const legacyNative = ["pump", "dbc", "moonit"].includes(order.venue ?? "");
  if (order.durableNonce === true || (!legacyNative && (!order.recentBlockhash || order.durableNonce !== false)))
    return { kind: "waiting" };
  const exactExpiry = !!order.recentBlockhash && order.durableNonce === false && order.lastValidBlockHeight !== undefined;
  if (exactExpiry && (!Number.isSafeInteger(order.lastValidBlockHeight) || order.lastValidBlockHeight! <= 0))
    throw new Error("Invalid recorded dispatch expiry.");
  if (!exactExpiry && !order.expiryFence) {
    if (!Number.isSafeInteger(observedSlot) || observedSlot <= 0) return { kind: "waiting" };
    // Persist the first observed processed slot. If the confirmed node has not
    // reached it yet, retry that SAME minimum rather than chasing a moving head.
    order.expiryMinimumSlot ??= observedSlot;
    const fence = await rpc.getLatestBlockhashAndContext({ commitment: "confirmed", minContextSlot: order.expiryMinimumSlot });
    if (fence.context.slot < order.expiryMinimumSlot ||
      !Number.isSafeInteger(fence.value.lastValidBlockHeight) || fence.value.lastValidBlockHeight <= 0)
      throw new Error("Invalid primary RPC expiry fence.");
    order.expiryFence = { ...fence.value, slot: fence.context.slot };
    return { kind: "waiting" };
  }
  const fence = exactExpiry ? { blockhash: order.recentBlockhash!, lastValidBlockHeight: order.lastValidBlockHeight!,
    slot: order.expiryMinimumSlot ?? observedSlot } : order.expiryFence!;
  if (!Number.isSafeInteger(fence.lastValidBlockHeight) || fence.lastValidBlockHeight <= 0 ||
    !Number.isSafeInteger(fence.slot) || fence.slot <= 0) throw new Error("Invalid persisted expiry evidence.");
  const height = await rpc.getBlockHeight("finalized");
  if (!Number.isSafeInteger(height) || height <= 0) throw new Error("Invalid primary finalized block height.");
  if (height <= fence.lastValidBlockHeight) return { kind: "waiting" };
  // A lagging or inconsistent RPC must never authorize releasing an order.
  if ((await rpc.isBlockhashValid(fence.blockhash, { commitment: "finalized" })).value)
    return { kind: "waiting" };
  if (order.recentBlockhash && order.recentBlockhash !== fence.blockhash &&
    (await rpc.isBlockhashValid(order.recentBlockhash, { commitment: "finalized" })).value)
    return { kind: "waiting" };
  const [statuses, transaction] = await Promise.all([
    rpc.getSignatureStatuses([order.signature], { searchTransactionHistory: true }),
    rpc.getTransaction(order.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }),
  ]);
  if (transaction?.meta) return { kind: "landed", transaction };
  if (transaction || statuses.value.length !== 1 || !Number.isSafeInteger(statuses.context.slot) ||
    statuses.context.slot < fence.slot || statuses.value[0]) return { kind: "waiting" };
  return { kind: "expired" };
}

export function clearPendingTransactionLock(s: State) {
  s.pending = null;
  if (s.running) s.nextWorkerScanAt = 0;
  s.entryBlocks = s.entryBlocks?.filter(block => !/^Transaction awaiting (?:finalized )?reconciliation|^Unresolved transaction signature/.test(block));
  if (/^(Transaction not found yet|Unresolved transaction signature|Original signature remains pending|Finalized transaction balances could not be reconciled|Native wallet cash movement could not be reconciled)/.test(s.lastError ?? ""))
    s.lastError = null;
}
