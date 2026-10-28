import { PublicKey } from "@solana/web3.js";
import { rpcPool } from "./rpc-pool";
import { rpcEndpoints, rpcGeneration } from "./rpc-config";
import { PinnedRpcLogSubscriptions } from "./rpc-websocket";

type Notice = { wallet: string; signature: string; receivedAt: number };
type Transport = Pick<PinnedRpcLogSubscriptions, "onLogs" | "onStatus" | "close" | "capabilityUnavailable">;
type Endpoint = { id: string; url: string };
type Dependencies = {
  endpoints: () => Endpoint[];
  create: (url: string) => Transport;
  now?: () => number;
  retryMs?: number;
  acknowledgementMs?: number;
};

/** One dedicated logsSubscribe transport, multiplexed by wallet. Only configured
 * background endpoints are candidates. HTTP signature-history polling is absent.
 * A log is a hint: the consumer must still fetch and verify its exact transaction.
 */
export class LeaderWalletStream {
  private notices = new Map<string, Notice>();
  private stream?: Transport;
  private key = "";
  private wallets: string[] = [];
  private cursor = 0;
  private blocked = new Map<string, number>();
  private retry?: ReturnType<typeof setTimeout>;
  private acknowledgement?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private connected = false;
  private gaps = new Map<string, number>();
  private message = "Wallet WebSocket not connected; no HTTP history polling.";
  private wake?: () => void;
  private now: () => number;
  constructor(private deps: Dependencies) { this.now = deps.now ?? Date.now; }
  onActivity(callback: () => void) { this.wake = callback; }
  status() { return this.message; }
  healthy() { return this.connected; }
  lastGapAt(wallet?: string) { return wallet ? this.gaps.get(wallet) ?? 0 : Math.max(0, ...this.gaps.values()); }
  private recordGap(wallet?: string, at = this.now()) {
    for (const target of wallet ? [wallet] : this.wallets) this.gaps.set(target, at);
  }
  queued() { return this.notices.size > 0; }
  acknowledge(signature: string, wallet: string) { this.notices.delete(`${wallet}:${signature}`); }
  pending(wallets: Set<string>, at = this.now()) {
    for (const [id, notice] of this.notices) {
      if (!wallets.has(notice.wallet)) this.notices.delete(id);
      else if (at - notice.receivedAt > 30_000) {
        this.notices.delete(id);
        this.recordGap(notice.wallet, at); // An expired notice may have been this leader's exit.
      }
    }
    return [...this.notices.values()].slice(0, 8);
  }
  sync(wallets: string[], generation: number) {
    const sorted = [...new Set(wallets)].sort();
    const next = `${generation}:${sorted.join(",")}`;
    if (this.key === next) return;
    this.disconnect();
    this.key = next;
    this.wallets = sorted;
    this.blocked.clear(); this.cursor = 0; this.attempts = 0;
    for (const [id, notice] of this.notices) if (!sorted.includes(notice.wallet)) this.notices.delete(id);
    if (!sorted.length) { this.message = "No active target wallets."; return; }
    this.recordGap();
    this.connectNext();
  }
  close() {
    this.disconnect(); this.wallets = []; this.key = ""; this.notices.clear();
    this.message = "Wallet stream closed.";
  }
  private disconnect() {
    if (this.retry) clearTimeout(this.retry);
    if (this.acknowledgement) clearTimeout(this.acknowledgement);
    this.retry = undefined; this.acknowledgement = undefined;
    const old = this.stream; this.stream = undefined; this.connected = false;
    old?.close();
  }
  private schedule(delay: number) {
    if (this.retry || !this.wallets.length) return;
    this.retry = setTimeout(() => { this.retry = undefined; this.connectNext(); }, Math.max(1, delay));
    this.retry.unref?.();
  }
  private connectNext() {
    if (!this.wallets.length || this.stream) return;
    let endpoints: Endpoint[];
    try { endpoints = this.deps.endpoints(); }
    catch { endpoints = []; }
    if (!endpoints.length) {
      this.message = "No configured secondary RPC for wallet WebSockets; primary is reserved. No history polling.";
      this.schedule(30_000); return;
    }
    let endpoint: Endpoint | undefined;
    for (let n = 0; n < endpoints.length; n++) {
      const candidate = endpoints[this.cursor++ % endpoints.length];
      if ((this.blocked.get(candidate.id) ?? 0) <= this.now()) { endpoint = candidate; break; }
    }
    if (!endpoint) {
      this.message = "Secondary wallet streams unavailable or logsSubscribe unsupported. A WebSocket-capable secondary RPC is required; no history polling.";
      this.schedule(Math.min(...endpoints.map(e => this.blocked.get(e.id) ?? this.now() + 30_000)) - this.now());
      return;
    }
    const selected = endpoint;
    this.message = `${selected.id}: awaiting confirmed wallet subscription acknowledgements.`;
    let client: Transport;
    try { client = this.deps.create(selected.url); }
    catch {
      this.blocked.set(selected.id, this.now() + 30_000);
      this.schedule(this.deps.retryMs ?? 1000); return;
    }
    this.stream = client;
    const fail = () => {
      if (this.stream !== client) return;
      this.recordGap();
      const unsupported = client.capabilityUnavailable();
      this.blocked.set(selected.id, this.now() + (unsupported ? 5 * 60_000 : 5000));
      this.disconnect();
      this.message = `${selected.id}: ${unsupported ? "logsSubscribe unsupported" : "wallet stream disconnected or unacknowledged"}; trying secondary alternatives. No history polling.`;
      this.schedule(Math.min(30_000, (this.deps.retryMs ?? 1000) * 2 ** Math.min(this.attempts++, 5)));
    };
    this.acknowledgement = setTimeout(fail, this.deps.acknowledgementMs ?? 12_000);
    this.acknowledgement.unref?.();
    client.onStatus(value => {
      if (this.stream !== client) return;
      if (value === "connected") {
        if (this.acknowledgement) clearTimeout(this.acknowledgement);
        this.acknowledgement = undefined;
        this.connected = true; this.attempts = 0;
        this.message = `${selected.id}: confirmed wallet logsSubscribe stream connected. No HTTP history polling.`;
        this.wake?.();
      } else if (value === "unavailable") fail();
    });
    if (this.stream !== client) return;
    try {
      for (const wallet of this.wallets) client.onLogs(new PublicKey(wallet), value => {
        if (this.stream !== client || value.err) return;
        const id = `${wallet}:${value.signature}`;
        if (this.notices.has(id)) return;
        if (this.notices.size >= 250) {
          this.recordGap(wallet);
          this.message = `${selected.id}: wallet event backlog saturated; existing-copy exits require reconciliation.`;
          this.wake?.(); return;
        }
        this.notices.set(id, { wallet, signature: value.signature, receivedAt: this.now() });
        this.wake?.();
      }, "confirmed");
    } catch { fail(); }
  }
}

function secondaryEndpoints() {
  const allowed = new Set(rpcPool.status().filter(e => e.role.startsWith("background only")).map(e => e.id));
  return rpcEndpoints().filter(e => allowed.has(e.id));
}
const live = new LeaderWalletStream({ endpoints: secondaryEndpoints,
  create: url => new PinnedRpcLogSubscriptions(url) });
export function onCopyActivity(callback: () => void) { live.onActivity(callback); }
export const copyStreamStatus = () => live.status();
export const copyStreamGapAt = (wallet?: string) => live.lastGapAt(wallet);
export const queuedCopyActivity = () => live.queued();
export const pendingCopyActivity = (wallets: Set<string>, at = Date.now()) => live.pending(wallets, at);
export function acknowledgeCopyActivity(signature: string, wallet: string) { live.acknowledge(signature, wallet); }
export function syncCopyStream(wallets: string[]) { live.sync(wallets, rpcGeneration()); }
