import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import { rpc } from "./chain";
import { TradingError } from "./store";

export const MAX_PRIORITY_LAMPORTS = 1_000_000;
let cached: { at: number; microLamports: number } | undefined;
/** Network fee sample, capped assuming the maximum 1.4m CU transaction. */
export async function priorityMicroLamports() {
  if (cached && Date.now() - cached.at < 15000) return cached.microLamports;
  let price = 50000;
  try {
    const fees = (await rpc().getRecentPrioritizationFees()).map(f => f.prioritizationFee)
      .filter(f => Number.isSafeInteger(f) && f > 0).sort((a, b) => a - b);
    if (fees.length) price = Math.ceil(fees[Math.floor((fees.length - 1) * 0.75)] * 1.2);
  } catch { /* Optional sample only: deterministic capped base fee, never a trade retry. */ }
  const microLamports = Math.max(1, Math.min(price, Math.floor(MAX_PRIORITY_LAMPORTS * 1e6 / 1400000)));
  cached = { at: Date.now(), microLamports };
  return microLamports;
}

/** Recompile only unsigned transaction instructions before validation/simulation.
 * Never append instructions to a transaction that was already signed.
 */
export async function applyPriorityFee(tx: VersionedTransaction, tables: { addressLookupTableAccounts: AddressLookupTableAccount[] }, multiplier = 1) {
  if (tx.signatures.some(s => s.some(b => b !== 0))) throw new TradingError("Provider transaction must be unsigned.");
  const message = TransactionMessage.decompile(tx.message, tables);
  let units = 1400000;
  const instructions = message.instructions.filter(ix => {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) return true;
    const op = ix.data[0];
    if (op === 2) {
      if (ix.data.length !== 5) throw new TradingError("Invalid compute-unit limit.");
      units = ix.data.readUInt32LE(1);
    }
    // Replace price only; deprecated combined fee instructions are disallowed.
    if (op === 0) throw new TradingError("Deprecated compute-budget fee instruction.");
    return op !== 3;
  });
  if (units < 1 || units > 1400000) throw new TradingError("Unsupported compute-unit limit.");
  const price = Math.min(Math.ceil(await priorityMicroLamports() * Math.max(1, Math.min(5, multiplier))), Math.floor(MAX_PRIORITY_LAMPORTS * 1e6 / units));
  instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  return new VersionedTransaction(new TransactionMessage({
    payerKey: message.payerKey, recentBlockhash: message.recentBlockhash, instructions,
  }).compileToV0Message(tables.addressLookupTableAccounts));
}
export function priorityFeeEstimate(tx: VersionedTransaction) {
  let units = 1400000, price = 0;
  for (const ix of tx.message.compiledInstructions) {
    if (!tx.message.staticAccountKeys[ix.programIdIndex]?.equals(ComputeBudgetProgram.programId)) continue;
    const b = Buffer.from(ix.data);
    if (b[0] === 2 && b.length === 5) units = b.readUInt32LE(1);
    if (b[0] === 3 && b.length === 9) price = Number(b.readBigUInt64LE(1));
  }
  return Math.ceil(units * price / 1e6);
}
