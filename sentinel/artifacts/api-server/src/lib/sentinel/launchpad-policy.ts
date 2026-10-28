import { createHash } from "node:crypto";
import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { PUMP_PROGRAM, DBC_PROGRAM } from "./curve-policy";
import { TradingError } from "./store";
import { MOONIT_PROGRAM, isMoonitTrade } from "./moonit-policy";

export const LAUNCHPAD_PROGRAMS = new Set([PUMP_PROGRAM.toBase58(), DBC_PROGRAM.toBase58(), MOONIT_PROGRAM.toBase58()]);
export const anchorTag = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const U64 = (1n << 64n) - 1n;
export function curveAmounts(input: bigint, output: bigint, slippageBps: number) {
  if (input <= 0n || input > U64 || output <= 0n || output > U64 ||
      !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) throw new TradingError("Invalid curve amounts or slippage.");
  const minimum = output * BigInt(10000 - slippageBps) / 10000n;
  if (!minimum) throw new TradingError("Curve output rounds to zero.");
  return minimum;
}
export function curveSwapInstruction(program: string, bytes: Uint8Array, buy: boolean, input: bigint, minimum: bigint) {
  if (program === MOONIT_PROGRAM.toBase58()) {
    if (!isMoonitTrade(bytes, buy, input, minimum)) throw new TradingError("Moonit exact input/minimum output instruction mismatch.");
    return true;
  }
  const data = Buffer.from(bytes);
  const pump = program === PUMP_PROGRAM.toBase58();
  const name = pump ? (buy ? "buy_exact_quote_in_v3" : "sell_v3") : "swap";
  if (!LAUNCHPAD_PROGRAMS.has(program) || data.length !== (pump && buy ? 25 : 24) ||
      !data.subarray(0, 8).equals(anchorTag(name)) ||
      (pump && buy && data[24] !== 0) || // partial fill can bypass Pump's minimum
      data.readBigUInt64LE(8) !== input || data.readBigUInt64LE(16) < minimum) {
    throw new TradingError("Unsupported curve instruction or encoded exact input/minimum output mismatch.");
  }
  return true;
}
/** Never assume a public program ID is immutable. Resolve the loader linkage. */
export async function verifyLaunchpadProgram(connection: Connection, program: PublicKey) {
  const a = await connection.getAccountInfo(program);
  if (!a?.executable) throw new TradingError("Launchpad program is not executable.");
  if (a.owner.toBase58() === "BPFLoader2111111111111111111111111111111111") return "immutable";
  if (a.owner.toBase58() !== "BPFLoaderUpgradeab1e11111111111111111111111" ||
      a.data.length !== 36 || a.data.readUInt32LE(0) !== 2) throw new TradingError("Unsupported launchpad program loader.");
  const address = new PublicKey(a.data.subarray(4, 36));
  const expected = PublicKey.findProgramAddressSync([program.toBuffer()], a.owner)[0];
  // Only the 45-byte loader header is evidence; downloading the whole program
  // binary wastes bandwidth/credits and may exceed provider response limits.
  const d = await connection.getAccountInfo(address, { dataSlice: { offset: 0, length: 45 } });
  if (!address.equals(expected) || !d || !d.owner.equals(a.owner) || d.data.length < 45 ||
      d.data.readUInt32LE(0) !== 3 || ![0, 1].includes(d.data[12])) throw new TradingError("Unverified launchpad ProgramData linkage.");
  return d.data[12] === 0 ? "immutable" : "upgradeable";
}
// Quotes/builds are process-local authorizations, not caller-supplied base64.
// Binding the entire message also protects account metas and setup/cleanup.
const authorizations = new WeakMap<object, string>();
const digest = (tx: VersionedTransaction) => createHash("sha256").update(tx.message.serialize()).digest("hex");
export function authorizeCurveBuild(q: object, tx: VersionedTransaction) { authorizations.set(q, digest(tx)); }
export function assertAuthorizedCurveBuild(q: object, tx: VersionedTransaction) {
  if (authorizations.get(q) !== digest(tx) || tx.message.addressTableLookups.length ||
      tx.signatures.some(s => s.some(v => v !== 0))) throw new TradingError("Curve build is not the locally verified unsigned transaction.");
}
export const venueName = (router: string) => router === "moonit" ? "Native Moonit" : router === "pump" ? "Native Pump.fun" :
  router === "dbc" ? "Native Meteora DBC (Bags)" : router === "raydium" ? "Direct Raydium" : "Jupiter Metis";
