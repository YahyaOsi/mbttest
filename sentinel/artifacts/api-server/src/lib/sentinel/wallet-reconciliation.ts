import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { rpc, walletAddress } from "./chain";
import { walletProblem } from "./wallet-policy";
import { event, now, TradingError } from "./store";
import { protectedTokens, updateRetention } from "./retention-policy";
import type { Position, State } from "./types";

/** A confirmed external withdrawal is not swap proceeds or realized P&L. */
export function applyWalletHoldings(s: State, balances: Map<string, bigint>, at = now()) {
  if ([...balances.values()].some(amount => amount < 0n)) throw new TradingError("Invalid wallet token balance; ledger unchanged.");
  const positions = s.positions.filter(p => p.mode === "live" && p.walletAddress === s.walletBinding &&
    ["open", "retained"].includes(p.status) && balances.has(p.mint));
  let changed = 0;
  for (const mint of new Set(positions.map(p => p.mint))) {
    const rows = positions.filter(p => p.mint === mint);
    const available = balances.get(mint)!;
    if (available < 0n) throw new TradingError("Invalid wallet token balance; ledger unchanged.");
    // Allocate retained reserves first across repeat buys of the same mint.
    let left = available;
    const allocations = new Map<Position, bigint>();
    for (const p of rows) {
      const raw = BigInt(p.rawRemaining), reserve = protectedTokens(p);
      const desired = raw < reserve ? raw : reserve;
      const allocated = desired < left ? desired : left;
      allocations.set(p, allocated); left -= allocated;
    }
    for (const p of rows) {
      const raw = BigInt(p.rawRemaining), reserved = allocations.get(p)!;
      const extra = raw - reserved < left ? raw - reserved : left;
      const held = reserved + extra; left -= extra;
      p.walletSyncedAt = at;
      if (held < raw) {
        const removed = Number(raw - held) / Number(raw);
        const removedValue = (p.remainingCostUsd + p.unrealizedPnlUsd) * removed;
        p.externallyTransferredQuantity = (p.externallyTransferredQuantity ?? 0) + Number(raw - held) / 10 ** p.decimals;
        p.remainingCostSol *= 1 - removed; p.remainingCostUsd *= 1 - removed;
        p.unrealizedPnlUsd *= 1 - removed; p.rawRemaining = held.toString();
        p.quantity = Number(held) / 10 ** p.decimals;
        s.dailyStartEquity = Math.max(0, s.dailyStartEquity - Math.max(0, removedValue));
        p.exitRetryReason = undefined;
        if (held === 0n) {
          p.status = "transferred"; p.closedAt = at; p.exitReason = "No tokens remain in this wallet — externally transferred or removed, not sold by the bot.";
        }
        event(s, "wallet-reconciliation", `${p.symbol}: wallet holds ${p.quantity} tracked tokens. Removed external holdings from sellable exposure; no sale, cash proceeds or realized P&L recorded.`, "warning", p.mint);
        changed++;
      }
      updateRetention(p);
    }
  }
  return changed;
}

export async function refreshWalletHoldings(s: State, mint?: string) {
  if (s.pending) throw new TradingError("A transaction is pending. Reconcile it before refreshing token holdings.", 409);
  const configured = walletAddress(), problem = walletProblem(s, configured);
  if (!configured || problem) throw new TradingError(problem ?? "Verify the original trading wallet before refreshing balances.", 409);
  const owner = new PublicKey(configured), connection = rpc();
  const responses = mint
    ? [await connection.getTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, "finalized")]
    : await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(programId =>
      connection.getTokenAccountsByOwner(owner, { programId }, "finalized")));
  const balances = new Map<string, bigint>();
  for (const p of s.positions) if (p.mode === "live" && (!mint || p.mint === mint)) balances.set(p.mint, 0n);
  for (const response of responses) for (const row of response.value) {
    if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(id => id.equals(row.account.owner)))
      throw new TradingError("Unexpected wallet token account program; balances not applied.");
    const account = unpackAccount(row.pubkey, row.account, row.account.owner);
    if (!account.owner.equals(owner)) throw new TradingError("Wallet token authority mismatch; balances not applied.");
    const key = account.mint.toBase58();
    if (balances.has(key)) balances.set(key, balances.get(key)! + account.amount);
  }
  // Complete every read before applying anything: a timeout is never a zero.
  const sol = mint ? null : await connection.getBalance(owner, "finalized") / 1e9;
  const changed = applyWalletHoldings(s, balances);
  if (sol !== null) {
    s.liveCashSol = sol; s.liveCashUsd = sol * (s.solPriceUsd ?? 0);
    s.lastTokenBalanceAt = Date.now();
  }
  return changed;
}
