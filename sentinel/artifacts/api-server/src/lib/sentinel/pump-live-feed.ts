import WebSocket from "ws";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { decodeSupportedMint } from "./token-policy";
import { rpc } from "./chain";
import { SOL, validMint } from "./discovery-policy";
import { PUMP_PROGRAM, pumpCurveAddress } from "./curve-policy";
import { withRpcMission } from "./rpc-context";
import type { LaunchRecord } from "./launch-events";
import { configureConfidenceEvidence } from "./confidence";

// PumpDev is an independent, unauthenticated data source, NOT Pump.fun.
// Its creation/trade messages are hints. Never use them as account, signature,
// mint-age, program-identity or settlement proof.
export interface PumpFeedAdapter {
  name: string;
  endpoint: string;
  parse: typeof parseLivePumpEvent;
}
let feed: PumpFeedAdapter | undefined;
/** Explicit server-side integration point. Paid authentication belongs in the
 * adapter, never in public settings/status. Default provider stays unchanged. */
export function configurePumpFeed(adapter?: PumpFeedAdapter) {
  if (adapter && (!adapter.name.trim() || new URL(adapter.endpoint).protocol !== "wss:"))
    throw new Error("Pump feed requires a named secure WebSocket adapter.");
  feed = adapter; socket?.close();
}
const AGE_MS = 10 * 60_000;
type Hint = { mint: string; signature: string; name: string; symbol: string; observedAt: number;
  status: "pending" | "checking" | "safe" | "unsafe"; attempts: number; nextAt: number };
type Trade = { signature: string; at: number; buy: boolean; sol: number; wallet?: string };
const hints = new Map<string, Hint>();
const trades = new Map<string, Trade[]>();
const velocityCache = new Map<string, { at: number; value: { count: number; uniqueWallets: number; buys: number; sells: number; volumeSol: number; changePct: number } }>();
let socket: WebSocket | undefined;
let running = false;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let lastFrameAt = 0;
let retryMs = 1000;
let lastError = "Not connected";
let received = 0, checked = 0, rejected = 0, expired = 0;
const subscribed = new Set<string>();
let onSignal: ((mint: string) => void) | undefined;
let isActive: (() => boolean) | undefined;

export function parseLivePumpEvent(message: unknown) {
  if (!message || typeof message !== "object") return null;
  const event = message as Record<string, unknown>;
  if (!validMint(event.mint) || typeof event.signature !== "string" || event.signature.length < 80 ||
      event.signature.length > 90 || (event.quoteMint && event.quoteMint !== SOL)) return null;
  const mint = event.mint as string;
  if (event.txType === "create" && event.bondingCurveKey === pumpCurveAddress(new PublicKey(mint)).toBase58())
    return { type: "create" as const, mint, signature: event.signature,
      name: typeof event.name === "string" ? event.name.slice(0, 80) : "",
      symbol: typeof event.symbol === "string" ? event.symbol.slice(0, 20) : "" };
  if ((event.txType === "buy" || event.txType === "sell") && !event.source &&
      event.bondingCurveKey === pumpCurveAddress(new PublicKey(mint)).toBase58() &&
      typeof event.solAmount === "number" && Number.isFinite(event.solAmount) && event.solAmount > 0)
    return { type: "trade" as const, mint, signature: event.signature,
      buy: event.txType === "buy", sol: event.solAmount,
      wallet: validMint(event.traderPublicKey) ? event.traderPublicKey as string : undefined };
  return null;
}

export function livePumpHint(mint: string) {
  const h = hints.get(mint);
  return h?.status === "safe" && Date.now() - h.observedAt < AGE_MS ? h : undefined;
}
export function livePumpRecord(h: Hint): LaunchRecord {
  return { mint: h.mint, signature: h.signature, pool: pumpCurveAddress(new PublicKey(h.mint)).toBase58(),
    program: PUMP_PROGRAM.toBase58(), slot: 0, createdAt: null, observedAt: h.observedAt,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), hintOnly: true, name: h.name, symbol: h.symbol };
}
export function livePumpRecords(at = Date.now()): LaunchRecord[] {
  return [...hints.values()].filter(h => h.status === "safe" && at - h.observedAt < AGE_MS).map(livePumpRecord);
}
export function livePumpBurst(mint: string, at = Date.now()) {
  if (!livePumpHint(mint)) return false;
  const recent = (trades.get(mint) ?? []).filter(t => at >= t.at && at - t.at <= 10_000);
  const buys = recent.filter(t => t.buy).length, sells = recent.length - buys;
  const volumeSol = recent.reduce((sum, t) => sum + t.sol, 0);
  const unique = new Set(recent.filter(t => t.buy && t.wallet).map(t => t.wallet)).size;
  return unique >= 3 && buys >= 3 && (buys > Math.max(1, sells) * 3 ||
    recent.length >= 12 && buys > sells || volumeSol >= 1 && buys >= Math.max(1, sells) * 1.5);
}
export const livePumpActivity = (mint: string, at = Date.now()) => {
  const cached = velocityCache.get(mint);
  if (cached && at >= cached.at && at - cached.at < 500) return cached.value;
  const recent = (trades.get(mint) ?? []).filter(t => at >= t.at && at - t.at <= 300000);
  const value = { count: recent.length, uniqueWallets: new Set(recent.filter(t => t.buy && t.wallet).map(t => t.wallet)).size,
    buys: recent.filter(t => t.buy).length,
    sells: recent.filter(t => !t.buy).length, volumeSol: recent.reduce((sum, t) => sum + t.sol, 0),
    changePct: 0 }; // No verified price baseline; never invent price momentum.
  velocityCache.set(mint, { at, value });
  return value;
};
configureConfidenceEvidence(mint => ({ burst: livePumpBurst(mint), uniqueWallets: livePumpActivity(mint).uniqueWallets }));
export function livePumpStatus() {
  const pending = [...hints.values()].filter(h => h.status === "pending" || h.status === "checking").length;
  return `Independent PumpDev live feed: ${lastError}; ${received} creations received, ${checked} authority checks passed, ${rejected} unsafe, ${expired} expired, ${pending} awaiting secondary RPC. Trade signals only cover up to five current mints on the free feed; not an exhaustive trade stream.`;
}
export function observeLivePumpMessage(message: unknown, at = Date.now()) {
  const parsed = feed ? feed.parse(message) : parseLivePumpEvent(message);
  if (!parsed) return;
  if (parsed.type === "create") {
    if (isActive && !isActive()) { syncLiveSubscriptions(); return; }
    if (!hints.has(parsed.mint)) {
      hints.set(parsed.mint, { mint: parsed.mint, signature: parsed.signature, name: parsed.name, symbol: parsed.symbol,
        observedAt: at, status: "pending", attempts: 0, nextAt: at });
      received++;
      onSignal?.(parsed.mint);
    }
  } else if (hints.get(parsed.mint)?.status === "safe" && at - hints.get(parsed.mint)!.observedAt < AGE_MS) {
    const list = (trades.get(parsed.mint) ?? []).filter(t => at - t.at < AGE_MS);
    if (!list.some(t => t.signature === parsed.signature)) {
      list.push({ signature: parsed.signature, at, buy: parsed.buy, sol: parsed.sol, wallet: parsed.wallet });
      trades.set(parsed.mint, list);
      velocityCache.delete(parsed.mint);
      onSignal?.(parsed.mint);
    }
  }
}
/** Screen every received creation. The concurrency bound is not a mint-sampling cap:
 * every mint remains queued until checked, rejected, or its ten-minute window expires.
 * A throttled provider can still make checks late; report backlog, never claim 100% coverage.
 */
export async function checkLivePumpMints(at = Date.now(), check = checkLiveMint) {
  for (const [mint, hint] of hints) {
    if (at - hint.observedAt < AGE_MS) continue;
    if (hint.status === "pending" || hint.status === "checking") expired++;
    hints.delete(mint); trades.delete(mint); velocityCache.delete(mint);
  }
  // getMultipleAccounts is supported by the owner's secondary RPC only at
  // five accounts per request. This limits request size, not incoming mint count.
  const due = [...hints.values()].filter(h => h.status === "pending" && at >= h.nextAt).slice(0, 5);
  if (!due.length) { syncLiveSubscriptions(); return; }
  for (const hint of due) hint.status = "checking";
  let batch: (AccountInfo<Buffer> | null)[] | undefined;
  try {
    if (check === checkLiveMint) batch = await withRpcMission("background", () =>
      rpc("background").getMultipleAccountsInfo(due.map(h => new PublicKey(h.mint)), "confirmed"));
  } catch { /* Retry every mint after a bounded delay; never fall back to primary. */ }
  await Promise.all(due.map(async (hint, index) => {
    try {
      if (check === checkLiveMint && !batch) throw new Error("Secondary mint batch unavailable");
      const safe = batch ? inspectLiveMint(hint.mint, batch[index]) : await withRpcMission("background", () => check(hint.mint));
      hint.status = safe ? "safe" : "unsafe";
      if (safe) { checked++; onSignal?.(hint.mint); } else rejected++;
    } catch {
      hint.attempts++;
      hint.status = "pending";
      hint.nextAt = Date.now() + Math.min(15_000, 500 * 2 ** Math.min(hint.attempts, 5));
    }
  }));
  syncLiveSubscriptions();
}
export async function checkLiveMint(mint: string) {
  const key = new PublicKey(mint);
  const raw = await rpc("background").getAccountInfo(key, "confirmed");
  return inspectLiveMint(mint, raw);
}
export function inspectLiveMint(mint: string, raw: AccountInfo<Buffer> | null | undefined) {
  if (!raw) throw new Error("Mint not yet visible on the secondary RPC.");
  try {
    // SDK handles both 82-byte base mint layouts and Token-2022's padded
    // account-type/TLV envelope. No hand-written or misaligned extension IDs.
    const { mint: decoded } = decodeSupportedMint(new PublicKey(mint), raw);
    return decoded.isInitialized && decoded.supply > 0n && decoded.mintAuthority === null && decoded.freezeAuthority === null;
  } catch { return false; }
}
function syncLiveSubscriptions() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const desired = selectLiveTradeTargets([...hints.values()].filter(h => h.status === "safe" &&
    Date.now() - h.observedAt < AGE_MS && (!isActive || isActive()))
    .map(h => ({ mint: h.mint, observedAt: h.observedAt, buys: livePumpActivity(h.mint).buys })));
  const remove = [...subscribed].filter(m => !desired.includes(m));
  const add = desired.filter(m => !subscribed.has(m));
  if (remove.length) socket.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: remove }));
  if (add.length) socket.send(JSON.stringify({ method: "subscribeTokenTrade", keys: add }));
  for (const mint of remove) subscribed.delete(mint);
  for (const mint of add) subscribed.add(mint);
}
/** Two velocity slots plus three rotating recent-mint slots. No static set of five. */
export function selectLiveTradeTargets(rows: { mint: string; observedAt: number; buys: number }[], at = Date.now()) {
  const recent = [...rows].sort((a, b) => b.observedAt - a.observedAt);
  if (recent.length <= 5) return recent.map(r => r.mint);
  const hot = [...recent].filter(r => r.buys > 0).sort((a, b) => b.buys - a.buys || b.observedAt - a.observedAt).slice(0, 2);
  const fixed = [recent[0], ...hot.filter(h => h.mint !== recent[0].mint)];
  const remaining = recent.filter(r => !fixed.some(h => h.mint === r.mint));
  const start = Math.floor(at / 10000) * (5 - fixed.length) % remaining.length;
  return [...fixed, ...Array.from({ length: Math.min(5 - fixed.length, remaining.length) },
    (_, i) => remaining[(start + i) % remaining.length])].map(r => r.mint);
}
function connect() {
  if (!running) return;
  try {
    const ws = new WebSocket(feed?.endpoint ?? "wss://pumpdev.io/ws", { handshakeTimeout: 5000, maxPayload: 16 * 1024, perMessageDeflate: false });
    socket = ws;
    ws.on("open", () => {
      lastFrameAt = Date.now();
      subscribed.clear();
      lastError = "connected (creation notices are not on-chain proof)";
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      syncLiveSubscriptions();
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastFrameAt > 90_000) { ws.terminate(); return; }
        ws.ping();
        syncLiveSubscriptions();
      }, 30_000);
      heartbeat.unref();
    });
    ws.on("pong", () => { lastFrameAt = Date.now(); });
    ws.on("message", raw => {
      lastFrameAt = Date.now();
      try {
        const value = JSON.parse(raw.toString());
        if (value?.type === "error" || value?.type === "connectionStatus" && value.connected === false)
          lastError = "feed degraded; RPC verification remains required";
        if (value?.txType === "create") retryMs = 1000;
        if (value?.type === "connectionStatus" && value.connected === true)
          lastError = "connected (creation notices are not on-chain proof)";
        observeLivePumpMessage(value);
      } catch { /* Invalid provider message cannot stop the bot. */ }
    });
    ws.on("unexpected-response", (_request, response) => {
      const seconds = Number(response.headers["retry-after"]);
      if (Number.isFinite(seconds) && seconds > 0) retryMs = Math.max(retryMs, Math.min(seconds * 1000, 60_000));
      response.resume();
      ws.terminate();
    });
    ws.on("error", () => { lastError = "connection unavailable; reconnecting"; });
    ws.on("close", () => {
      if (socket !== ws) return;
      if (heartbeat) clearInterval(heartbeat);
      socket = undefined; subscribed.clear();
      lastError = "disconnected; reconnecting";
      if (running) {
        reconnect = setTimeout(connect, retryMs);
        reconnect.unref();
        retryMs = Math.min(retryMs * 2, 60_000);
      }
    });
  } catch {
    lastError = "connection unavailable; reconnecting";
    reconnect = setTimeout(connect, retryMs);
    reconnect.unref();
    retryMs = Math.min(retryMs * 2, 60_000);
  }
}
export function startLivePumpFeed(callback: (mint: string) => void, active: () => boolean = () => true) {
  onSignal = callback;
  isActive = active;
  if (running) return;
  running = true;
  connect();
}
export function stopLivePumpFeed() {
  running = false;
  if (reconnect) clearTimeout(reconnect);
  if (heartbeat) clearInterval(heartbeat);
  socket?.close(); socket = undefined; subscribed.clear(); onSignal = undefined; isActive = undefined;
}
