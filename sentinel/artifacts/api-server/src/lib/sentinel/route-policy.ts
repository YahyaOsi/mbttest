import { VersionedTransaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { SOL, validMint } from "./discovery-policy";
import { TradingError } from "./store";

// Official mainnet IDs: https://docs.raydium.io/reference/program-addresses
export const RAYDIUM_POOLS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
]);
export const RAYDIUM_PROGRAMS = new Set([...RAYDIUM_POOLS, "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS"]);
const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
// Decode the exact-input swap limits, not just the provider's JSON. Setup/
// cleanup instructions are permitted only in conjunction with one such swap.
export function raySwapInstruction(program: string, bytes: Uint8Array, input: bigint, minimum: bigint): boolean {
  const data = Buffer.from(bytes);
  let offset: number;
  if (program === "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS") {
    if (data[0] === 5 && data.length === 9 && data.readBigUInt64LE(1) <= input) return false; // native wrap
    if (data[0] === 6 && data.length === 1) return false; // native unwrap/cleanup
    if (data[0] !== 0 || data.length !== 17) throw new TradingError("Unsupported Raydium router instruction.");
    offset = 1;
  } else if (program === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8") {
    if (data[0] !== 9 || data.length !== 17) throw new TradingError("Unsupported Raydium AMM instruction.");
    offset = 1;
  } else {
    const cpmm = program === "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
    const valid = cpmm ? data.length === 24 && data.subarray(0, 8).equals(discriminator("swap_base_input"))
      : data.length === 41 && data[40] === 1 && ["swap", "swap_v2"].some(n => data.subarray(0, 8).equals(discriminator(n)));
    if (!valid) throw new TradingError("Unsupported Raydium exact-input instruction.");
    offset = 8;
  }
  if (data.readBigUInt64LE(offset) !== input || data.readBigUInt64LE(offset + 8) < minimum) {
    throw new TradingError("Encoded swap amounts/minimum output do not match authorization.");
  }
  return true;
}
export type ExecutionLimits = { slippageBps: number; maxPriceImpactPct: number };
export function impact(q: any, maxPct: number) {
  const value = q?.priceImpactPct;
  const pct = Math.abs(Number(value));
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "" || !Number.isFinite(pct) || pct > maxPct) {
    throw new TradingError("Price impact is unknown or above your limit.");
  }
}
export function assertQuote(q: any, input: string, output: string, amount: string, limits: ExecutionLimits) {
  if (!validMint(input) || !validMint(output) || input === output || ![input, output].includes(SOL) ||
      !/^[1-9]\d*$/.test(amount) || q?.error || String(q?.inAmount) !== amount ||
      q.inputMint !== input || q.outputMint !== output ||
      !/^[1-9]\d*$/.test(String(q?.outAmount)) || !Number.isInteger(q.slippageBps) ||
      q.slippageBps < 0 || q.slippageBps > limits.slippageBps) {
    throw new TradingError("No valid exact-input native SOL route within the configured limits.", 422);
  }
  impact(q, limits.maxPriceImpactPct);
}
export function assertSingleTransaction(transaction: string, wallet: string) {
  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  if (tx.version !== 0 || tx.message.header.numRequiredSignatures !== 1 ||
      tx.message.staticAccountKeys[0]?.toBase58() !== wallet) {
    throw new TradingError("Only atomic v0 swaps with this wallet as the sole signer/payer are supported.");
  }
  return tx;
}
export function raydiumQuote(response: any, input: string, output: string, amount: string, limits: ExecutionLimits) {
  const d = response?.data;
  if (!response?.success || d?.swapType !== "BaseIn" || !Array.isArray(d.routePlan) ||
      !d.routePlan.length || d.routePlan.length > 4 || d.routePlan.some((r: any) =>
        !validMint(r.poolId) || !validMint(r.inputMint) || !validMint(r.outputMint)) ||
      d.routePlan[0].inputMint !== input || d.routePlan.at(-1).outputMint !== output ||
      d.routePlan.some((r: any, i: number) => i > 0 && d.routePlan[i - 1].outputMint !== r.inputMint) ||
      (d.referrerAmount != null && String(d.referrerAmount) !== "0")) {
    throw new TradingError("Raydium did not return a supported fee-free-referral route.", 422);
  }
  const q = { ...d, router: "raydium", inputMint: d.inputMint, outputMint: d.outputMint,
    inAmount: d.inputAmount, outAmount: d.outputAmount, quotedAt: Date.now(),
    routePoolIds: d.routePlan.map((r: any) => r.poolId), raydiumResponse: response };
  assertQuote(q, input, output, amount, limits);
  const minimum = BigInt(q.outAmount) * BigInt(10000 - limits.slippageBps) / 10000n;
  if (!/^[1-9]\d*$/.test(String(d.otherAmountThreshold)) || BigInt(d.otherAmountThreshold) < minimum ||
      BigInt(d.otherAmountThreshold) > BigInt(q.outAmount)) throw new TradingError("Raydium minimum output exceeds the allowed slippage.");
  return q;
}
