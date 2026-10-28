import { VersionedTransaction, type MessageAccountKeys } from "@solana/web3.js";
import bs58 from "bs58";
import { anchorTag } from "./launchpad-policy";
import { PUMP_AMM_PROGRAM } from "./curve-policy";
import { SOL } from "./discovery-policy";
import { rpcGeneration } from "./rpc-config";
import type { graduatedPumpState } from "./pump-graduated";
import { TradingError } from "./store";
import { tokenAddress, TOKEN_PROGRAM_ID } from "./token-policy";
import { PublicKey } from "@solana/web3.js";

export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
type Proof = Awaited<ReturnType<typeof graduatedPumpState>>;
const authorized = new WeakMap<object, { mint: string; pool: string; at: number; generation: number }>();
export function assertGraduatedQuote(q: any, proof: Proof, mint: string) {
  const plan = q.routePlan;
  const h = plan?.[0], swap = h?.swapInfo;
  if (q.router !== "metis" || q.inputMint !== SOL || q.outputMint !== mint ||
      !Array.isArray(plan) || plan.length !== 1 || swap?.ammKey !== proof.pool.toBase58() ||
      swap.inputMint !== SOL || swap.outputMint !== mint ||
      (h.percent !== 100 && h.bps !== 10000) || (q.platformFee?.amount && String(q.platformFee.amount) !== "0"))
    throw new TradingError("Graduated Jupiter entry requires one unsplit canonical PumpSwap SOL→token hop; other pools/routes are unsupported.");
}
export function authorizeGraduatedQuote(q: any, proof: Proof, mint: string) {
  assertGraduatedQuote(q, proof, mint);
  authorized.set(q, { mint, pool: proof.pool.toBase58(), at: proof.at, generation: rpcGeneration() });
}
export function assertGraduatedAuthorization(q: any, proof: Proof, mint: string) {
  const a = authorized.get(q);
  if (!a || a.mint !== mint || a.pool !== proof.pool.toBase58() || a.generation !== rpcGeneration() ||
      Date.now() < a.at || Date.now() - a.at > 30000)
    throw new TradingError("Graduated provenance is stale or not locally authorized; acquire a fresh quote.");
  assertGraduatedQuote(q, proof, mint);
}

/** Jupiter's official v6 IDL: idls/jupiter_aggregator_v6.json in
 * jup-ag/jupiter-amm-implementation. Only Route/SharedAccountsRoute, one
 * PumpSwapBuy (enum 72, no fields), 100%, 0→1. No ledger/exact-out/multihop.
 */
export function assertGraduatedInstruction(bytes: Uint8Array, input: bigint, output: bigint, slippage: number) {
  const d = Buffer.from(bytes);
  const shared = d.subarray(0, 8).equals(anchorTag("shared_accounts_route"));
  const offset = shared ? 9 : 8;
  if ((!shared && !d.subarray(0, 8).equals(anchorTag("route"))) || d.length !== offset + 27 ||
      d.readUInt32LE(offset) !== 1 || d[offset + 4] !== 72 || d[offset + 5] !== 100 ||
      d[offset + 6] !== 0 || d[offset + 7] !== 1 ||
      d.readBigUInt64LE(offset + 8) !== input || d.readBigUInt64LE(offset + 16) !== output ||
      d.readUInt16LE(offset + 24) !== slippage || d[offset + 26] !== 0)
    throw new TradingError("Encoded Jupiter route does not match the single PumpSwap exact-input authorization.");
}
export function assertGraduatedTransaction(tx: VersionedTransaction, keys: MessageAccountKeys, q: any, proof: Proof) {
  if (tx.signatures.some(s => s.some(v => v !== 0))) throw new TradingError("Graduated transaction must be unsigned.");
  const swaps = tx.message.compiledInstructions.filter(i => keys.get(i.programIdIndex)?.toBase58() === JUPITER_PROGRAM);
  if (swaps.length !== 1) throw new TradingError("Graduated transaction must contain exactly one Jupiter swap.");
  assertGraduatedInstruction(swaps[0].data, BigInt(q.inAmount), BigInt(q.outAmount), q.slippageBps);
  const accounts = swaps[0].accountKeyIndexes.map(i => keys.get(i)?.toBase58());
  const shared = Buffer.from(swaps[0].data).subarray(0, 8).equals(anchorTag("shared_accounts_route"));
  const owner = tx.message.staticAccountKeys[0], mint = new PublicKey(q.outputMint);
  const source = tokenAddress(owner, new PublicKey(SOL)).toBase58();
  const destination = tokenAddress(owner, mint, proof.supported.program).toBase58();
  if (accounts[0] !== TOKEN_PROGRAM_ID.toBase58() || accounts[shared ? 2 : 1] !== owner.toBase58() ||
      accounts[shared ? 3 : 2] !== source || accounts[shared ? 6 : 3] !== destination ||
      accounts[shared ? 8 : 5] !== q.outputMint ||
      (shared && accounts[7] !== SOL) ||
      (!shared && ![destination, JUPITER_PROGRAM].includes(accounts[4] ?? "")) ||
      accounts[shared ? 9 : 6] !== JUPITER_PROGRAM)
    throw new TradingError("Encoded Jupiter wallet, token-account, mint or platform-fee binding mismatch.");
  for (const key of [proof.pool, proof.baseVault, proof.quoteVault, PUMP_AMM_PROGRAM]) {
    if (!accounts.includes(key.toBase58())) throw new TradingError("Encoded Jupiter swap does not bind the verified PumpSwap pool/vaults.");
  }
}
/** Require simulation CPI evidence, not a JSON label or an unused pool meta. */
export function assertGraduatedSimulation(inner: any, keys: MessageAccountKeys, proof: Proof) {
  if (!Array.isArray(inner)) throw new TradingError("Graduated simulation lacks inner-instruction provenance.");
  const calls = inner.flatMap((g: any) => g.instructions ?? []).filter((i: any) =>
    keys.get(i.programIdIndex)?.equals(PUMP_AMM_PROGRAM));
  // Anchor event CPI has a separate discriminator, and is not another swap.
  const swaps = calls.filter((i: any) => {
    const d = Buffer.from(bs58.decode(i.data));
    return d.subarray(0, 8).equals(anchorTag("buy")) || d.subarray(0, 8).equals(anchorTag("buy_exact_quote_in"));
  });
  if (swaps.length !== 1) throw new TradingError("Simulation did not execute exactly one canonical PumpSwap buy.");
  const accounts = swaps[0].accounts.map((i: number) => keys.get(i)?.toBase58());
  // Official PumpSwap buy ABI: pool=0; base/quote vaults=7/8.
  if (accounts[0] !== proof.pool.toBase58() || accounts[7] !== proof.baseVault.toBase58() ||
      accounts[8] !== proof.quoteVault.toBase58())
    throw new TradingError("Simulation used a different PumpSwap pool or vault.");
}
