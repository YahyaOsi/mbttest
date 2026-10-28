import dns from "node:dns/promises";
import { PublicKey, type Commitment } from "@solana/web3.js";
import WebSocket, { type ClientOptions } from "ws";
import { parseRpcUrl, publicRpcAddress } from "./rpc-endpoint";

type LogsValue = { signature: string; err: unknown; logs: string[] };
export type LogsCallback = (event: LogsValue, context: { slot: number }) => void;
export type RpcLogSubscriptionClient = {
  onLogs(address: PublicKey, callback: LogsCallback, commitment?: Commitment): number;
  removeOnLogsListener(id: number): Promise<void>;
};
type SocketLike = {
  on(event: string, listener: (...args: any[]) => void): SocketLike;
  send(data: string): void;
  close(): void;
  ping?(): void;
};
type LookupCallback = (error: NodeJS.ErrnoException | null, address: any, family?: number) => void;
type SocketFactory = (url: string, options: ClientOptions) => SocketLike;
type Subscription = { address: string; callback: LogsCallback; commitment: Commitment; serverId?: number };

type PinnedSocketOptions = {
  lookup?: typeof dns.lookup;
  socketFactory?: SocketFactory;
  retryMs?: number;
};

/** A logs-only websocket transport for saved RPCs outside the built-in provider list.
 * Every (re)connect re-resolves the hostname, rejects any non-public DNS answer,
 * and pins the socket lookup to a validated address while retaining TLS hostname checks.
 */
export class PinnedRpcLogSubscriptions {
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly requests = new Map<number, number>();
  private readonly lookup: typeof dns.lookup;
  private readonly socketFactory: SocketFactory;
  private readonly retryMs: number;
  private nextSubscriptionId = 1;
  private nextRequestId = 1;
  private socket: SocketLike | null = null;
  private socketReady = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private connecting = false;
  private closed = false;
  private unsupported = false;
  private reconnectAttempt = 0;
  private state: "connecting" | "connected" | "unavailable" = "connecting";
  private stateListeners = new Set<(state: "connecting" | "connected" | "unavailable") => void>();

  constructor(private readonly endpoint: string, options: PinnedSocketOptions = {}) {
    this.lookup = options.lookup ?? dns.lookup;
    this.socketFactory = options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.retryMs = options.retryMs ?? 1000;
  }

  onStatus(listener: (state: "connecting" | "connected" | "unavailable") => void) {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }
  capabilityUnavailable() { return this.unsupported; }

  onLogs(address: PublicKey, callback: LogsCallback, commitment: Commitment = "confirmed"): number {
    if (this.closed) throw new Error("RPC log transport is closed.");
    const id = this.nextSubscriptionId++;
    this.subscriptions.set(id, { address: address.toBase58(), callback, commitment });
    if (this.unsupported) { this.setState("unavailable"); return id; }
    this.setState("connecting");
    void this.connect();
    if (this.socketReady) this.sendSubscription(id);
    return id;
  }

  async removeOnLogsListener(id: number): Promise<void> {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    if (subscription.serverId !== undefined && this.socket) {
      const requestId = this.nextRequestId++;
      this.requests.set(requestId, -1);
      try { this.socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "logsUnsubscribe", params: [subscription.serverId] })); }
      catch { /* Disconnect recovery will discard this server-side subscription. */ }
    }
    if (!this.subscriptions.size) this.disconnect();
  }

  close() {
    this.closed = true;
    this.disconnect();
    this.stateListeners.clear();
  }

  private disconnect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const socket = this.socket;
    this.socket = null;
    this.socketReady = false;
    this.subscriptions.clear();
    this.requests.clear();
    if (socket) socket.close();
  }

  private setState(state: "connecting" | "connected" | "unavailable") {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private async connect() {
    if (this.closed || this.unsupported || this.connecting || this.socket || !this.subscriptions.size) return;
    this.connecting = true;
    this.setState("connecting");
    try {
      const url = parseRpcUrl(this.endpoint);
      const answers = await this.lookup(url.hostname, { all: true, family: 4 });
      if (!answers.length || answers.some(answer => !publicRpcAddress(answer.address))) {
        throw new Error("RPC hostname is not public.");
      }
      if (this.closed || this.unsupported) return;
      const pinnedAddress = answers[0].address;
      const wsUrl = new URL(url.href);
      wsUrl.protocol = "wss:";
      const lookup = (hostname: string, options: any, callback: LookupCallback) => {
        if (hostname.toLowerCase() !== url.hostname.toLowerCase()) {
          const error = Object.assign(new Error("Unexpected websocket hostname."), { code: "EHOSTUNREACH" }) as NodeJS.ErrnoException;
          callback(error, "", 4);
          return;
        }
        if (options?.all) callback(null, [{ address: pinnedAddress, family: 4 }]);
        else callback(null, pinnedAddress, 4);
      };
      const socket = this.socketFactory(wsUrl.href, {
        lookup,
        handshakeTimeout: 10000,
        maxPayload: 1024 * 1024,
        followRedirects: false,
        perMessageDeflate: false,
      } as unknown as ClientOptions);
      if (this.closed) { socket.close(); return; }
      this.socket = socket;
      socket.on("open", () => {
        if (this.socket !== socket || this.closed) return;
        this.socketReady = true;
        this.lastFrameAt = Date.now();
        if (socket.ping) {
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (this.socket !== socket || this.closed) return;
            if (Date.now() - this.lastFrameAt > 30_000) { disconnected(); return; }
            try { socket.ping?.(); } catch { disconnected(); }
          }, 10_000);
          this.heartbeat.unref?.();
        }
        for (const id of this.subscriptions.keys()) this.sendSubscription(id);
        this.refreshConnectedState();
      });
      socket.on("message", (data: unknown) => {
        this.lastFrameAt = Date.now();
        if (this.socket === socket && !this.closed) this.handleMessage(data);
      });
      socket.on("pong", () => { if (this.socket === socket) this.lastFrameAt = Date.now(); });
      const disconnected = () => {
        if (this.socket !== socket || this.closed) return;
        this.socket = null;
        this.socketReady = false;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.requests.clear();
        for (const subscription of this.subscriptions.values()) subscription.serverId = undefined;
        this.setState("unavailable");
        socket.close();
        this.scheduleReconnect();
      };
      socket.on("error", disconnected);
      socket.on("close", disconnected);
    } catch {
      this.setState("unavailable");
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.unsupported || !this.subscriptions.size || this.retryTimer) return;
    const delay = Math.min(30000, this.retryMs * 2 ** Math.min(this.reconnectAttempt++, 8));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  private sendSubscription(id: number) {
    const subscription = this.subscriptions.get(id), socket = this.socket;
    if (!subscription || !socket || !this.socketReady || subscription.serverId !== undefined) return;
    const requestId = this.nextRequestId++;
    this.requests.set(requestId, id);
    try {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "logsSubscribe",
        params: [{ mentions: [subscription.address] }, { commitment: subscription.commitment }] }));
    } catch {
      this.requests.delete(requestId);
      socket.close();
    }
  }

  private handleMessage(data: unknown) {
    let message: any;
    try { message = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8")); }
    catch { this.socket?.close(); return; }
    if (typeof message?.id === "number" && this.requests.has(message.id)) {
      const localId = this.requests.get(message.id)!;
      this.requests.delete(message.id);
      if (localId >= 0) {
        const subscription = this.subscriptions.get(localId);
        if (message.error?.code === -32601 || /not supported|unsupported|method.*not found/i.test(message.error?.message ?? "")) {
          // Unsupported is a capability failure, not a transient disconnect.
          // Keep HTTP recovery active without SDK-style resubscribe storms.
          this.unsupported = true;
          this.setState("unavailable");
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = null;
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.heartbeat = null;
          const socket = this.socket;
          this.socket = null; this.socketReady = false; this.requests.clear();
          socket?.close();
          return;
        }
        if (!subscription || message.error || !Number.isSafeInteger(message.result)) {
          this.setState("unavailable");
          this.socket?.close();
          return;
        }
        subscription.serverId = message.result;
        this.refreshConnectedState();
      }
      return;
    }
    if (message?.method !== "logsNotification" || !Number.isSafeInteger(message.params?.subscription)) return;
    const subscription = [...this.subscriptions.values()].find(s => s.serverId === message.params.subscription);
    const result = message.params?.result, value = result?.value;
    if (!subscription || typeof value?.signature !== "string" || !Array.isArray(value.logs) ||
        !Number.isSafeInteger(result?.context?.slot)) return;
    try {
      subscription.callback({ signature: value.signature, err: value.err ?? null, logs: value.logs }, { slot: result.context.slot });
    } catch {
      // A consumer failure must not break the shared websocket message loop.
    }
  }

  private refreshConnectedState() {
    if (this.subscriptions.size && [...this.subscriptions.values()].every(s => s.serverId !== undefined)) this.reconnectAttempt = 0;
    this.setState(this.subscriptions.size && [...this.subscriptions.values()].every(s => s.serverId !== undefined)
      ? "connected" : "connecting");
  }
}
