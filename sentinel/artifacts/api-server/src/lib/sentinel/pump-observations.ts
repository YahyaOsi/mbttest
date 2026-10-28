import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { PUMP_INITIAL_REAL_TOKENS, PUMP_PROGRAM, pumpCurveAddress } from "./curve-policy";
import type { LaunchRecord } from "./launch-events";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

type Trade = { at: number; buy: boolean; sol: number; price: number };
type Creator = { address: string; balance: bigint; slot: number; block?: { slot: number; before: bigint; sold: bigint } };
const creations = new Map<string, LaunchRecord>();
const trades = new Map<string, Trade[]>();
const creators = new Map<string, Creator>();
const progress = new Map<string, { value: number; at: number }>();
const panics = new Map<string, { reason: string; at: number }>();
const signatures = new Set<string>();
let activityListener: ((mint: string) => void) | undefined;
export function onPumpActivity(listener: (mint: string) => void) { activityListener = listener; }
export const progressPct = (real: bigint) =>
  Math.max(0, Math.min(100, Number((PUMP_INITIAL_REAL_TOKENS - real) * 10000n / PUMP_INITIAL_REAL_TOKENS) / 100));

export function setPumpCreatorBaseline(mint: string, address: string, balance: bigint, slot: number) {
  const old = creators.get(mint);
  if (!old || slot > old.slot) creators.set(mint, { address, balance, slot });
}
export type PumpCreatorCheckpoint = { address: string; balanceRaw: string; slot: number };
export function pumpCreatorCheckpoint(mint: string): PumpCreatorCheckpoint | undefined {
  const c = creators.get(mint);
  return c ? { address: c.address, balanceRaw: c.balance.toString(), slot: c.block?.slot ?? c.slot } : undefined;
}
export function pumpPanic(mint: string) {
  const p = panics.get(mint);
  return p && Date.now() - p.at < 300000 ? p.reason : null;
}
export function observePumpProgress(mint: string, value: number, at = Date.now()) {
  const old = progress.get(mint);
  if (old && at >= old.at && at - old.at <= 10000 && old.value - value >= 5)
    panics.set(mint, { reason: "Pump curve progress fell at least 5 percentage points within 10 seconds", at });
  progress.set(mint, { value, at });
}
export function observePumpTrade(mint: string, user: string, slot: number, buy: boolean, amount: bigint) {
  const c = creators.get(mint);
  if (!c || c.address !== user || slot <= c.slot) return;
  if (c.block && slot < c.block.slot) return;
  if (c.block?.slot !== slot) c.block = { slot, before: c.balance, sold: 0n };
  if (buy) c.balance += amount;
  else {
    c.block.sold += amount;
    c.balance = c.balance > amount ? c.balance - amount : 0n;
    if (c.block.before > 0n && c.block.sold * 2n > c.block.before)
      panics.set(mint, { reason: `Verified creator sold over 50% of their pre-block allocation in slot ${slot}`, at: Date.now() });
  }
}
const eventTag = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
// Stable, bounded legacy event prefixes. New trailing SDK fields must not
// prevent observing older official deployments. This does not enable signing
// an unsupported ABI: final transaction build/simulation still fails closed.
function creationEvent(bytes: Buffer) {
  try { return PUMP_SDK.decodeCreateEventBc(bytes); } catch {
    if (!bytes.subarray(0, 8).equals(eventTag("CreateEvent"))) throw new Error("Not creation");
    let offset = 8;
    const strings: string[] = [];
    for (let i = 0; i < 3; i++) {
      const length = bytes.readUInt32LE(offset); offset += 4;
      if (length > 1024 || offset + length > bytes.length) throw new Error("Invalid event string");
      strings.push(bytes.subarray(offset, offset + length).toString("utf8"));
      offset += length;
    }
    if (bytes.length < offset + 96) throw new Error("Truncated creation");
    const mint = new PublicKey(bytes.subarray(offset, offset + 32));
    const curve = new PublicKey(bytes.subarray(offset + 32, offset + 64));
    if (!curve.equals(pumpCurveAddress(mint))) throw new Error("Wrong curve");
    return { mint, name: strings[0], symbol: strings[1], timestamp: { toString: () => "0" } };
  }
}
function tradeEvent(bytes: Buffer) {
  try { return PUMP_SDK.decodeTradeEventBc(bytes); } catch {
    if (!bytes.subarray(0, 8).equals(eventTag("TradeEvent")) || bytes.length < 129 || bytes[56] > 1)
      throw new Error("Not supported trade");
    return { mint: new PublicKey(bytes.subarray(8, 40)), solAmount: bytes.readBigUInt64LE(40),
      tokenAmount: bytes.readBigUInt64LE(48), isBuy: bytes[56] === 1, user: new PublicKey(bytes.subarray(57, 89)),
      virtualSolReserves: bytes.readBigUInt64LE(97), virtualTokenReserves: bytes.readBigUInt64LE(105),
      realTokenReserves: bytes.readBigUInt64LE(121) };
  }
}

/** Only decode events emitted while the real Pump program owns the invocation
 * stack. A caller's arbitrary "Program data:" line is not Pump evidence. */
export function ingestPumpLogs(event: { signature: string; err: unknown; logs: string[] }, slot: number, at = Date.now()) {
  if (event.err || signatures.has(event.signature)) return;
  signatures.add(event.signature);
  if (signatures.size > 6000) signatures.delete(signatures.values().next().value!);
  const stack: string[] = [];
  for (const log of event.logs) {
    const invocation = /^Program (\w+) invoke \[\d+\]$/.exec(log);
    if (invocation) { stack.push(invocation[1]); continue; }
    if (/^Program \w+ (success|failed:)/.test(log)) { stack.pop(); continue; }
    if (stack.at(-1) !== PUMP_PROGRAM.toBase58() || !log.startsWith("Program data: ")) continue;
    const bytes = Buffer.from(log.slice(14), "base64");
    try {
      const e = creationEvent(bytes), mint = e.mint.toBase58();
      const timestamp = Number(e.timestamp.toString()) * 1000;
      creations.set(mint, { mint, program: PUMP_PROGRAM.toBase58(), pool: pumpCurveAddress(e.mint).toBase58(),
        signature: event.signature, slot, createdAt: timestamp > 0 && timestamp <= at ? timestamp : null,
        observedAt: at, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), hintOnly: true,
        name: e.name.slice(0, 80), symbol: e.symbol.slice(0, 20) });
      activityListener?.(mint);
      continue;
    } catch { /* Not a supported creation event. */ }
    try {
      const e = tradeEvent(bytes), mint = e.mint.toBase58();
      const price = Number(e.virtualSolReserves.toString()) / Number(e.virtualTokenReserves.toString());
      if (!Number.isFinite(price) || price <= 0) continue;
      const samples = (trades.get(mint) ?? []).filter(t => at - t.at <= 300000);
      samples.push({ at, buy: e.isBuy, sol: Number(e.solAmount.toString()) / 1e9, price });
      trades.set(mint, samples.slice(-500));
      observePumpProgress(mint, progressPct(BigInt(e.realTokenReserves.toString())), at);
      observePumpTrade(mint, e.user.toBase58(), slot, e.isBuy, BigInt(e.tokenAmount.toString()));
      activityListener?.(mint);
    } catch { /* Unsupported events never become market or panic evidence. */ }
  }
  // Time-based retention, never a first-240-mints sample of live launches.
  for (const [mint, c] of creations) if (at - c.observedAt > 10 * 60000) creations.delete(mint);
  for (const [mint, samples] of trades) if (!samples.length || at - samples.at(-1)!.at > 5 * 60000) trades.delete(mint);
  for (const map of [creators, progress, panics]) {
    while (map.size > 240) map.delete(map.keys().next().value!);
  }
}
export function recentPumpCreations() { return [...creations.values()]; }
export function pumpActivity(mint: string, at = Date.now(), windowMs = 300000) {
  const list = (trades.get(mint) ?? []).filter(t => at >= t.at && at - t.at <= windowMs);
  return { count: list.length, buys: list.filter(t => t.buy).length, sells: list.filter(t => !t.buy).length,
    volumeSol: list.reduce((sum, t) => sum + t.sol, 0),
    changePct: list.length > 1 ? (list.at(-1)!.price / list[0].price - 1) * 100 : 0 };
}
