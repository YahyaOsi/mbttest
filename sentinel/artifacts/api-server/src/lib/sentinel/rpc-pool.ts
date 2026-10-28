import { rpcEndpoints } from "./rpc-config";
import { safeRpcFetch } from "./rpc-endpoint";
import { isSolanaMainnet } from "./network-policy";
// Keep RPC policy importable without starting a logger transport worker for
// every offline test/process. Production collectors ingest these JSON records.
const balanceAudit = (data: Record<string, unknown>) =>
  console.info(JSON.stringify({ event: "sentinel-rpc-balance", ...data }));

type Endpoint = { id: string; url: string; pinned: boolean };
type Health = { latency: number | null; failures: number; retryAt: number; verifiedAt: number; slotAt?: number };
const FAILOVER_READS = new Set(["getBalance", "getAccountInfo", "getMultipleAccounts", "getTokenAccountsByOwner", "getTokenLargestAccounts", "getTokenSupply"]);
export type RpcMission = "query" | "wallet" | "priority" | "background";
const retryable = (body: any): boolean => Array.isArray(body) ? body.some(retryable) :
  [-32005, -32004, -32009, -32601, 429].includes(body?.error?.code) ||
  /rate.?limit|quota|unavailable|node is behind|too many requests/i.test(body?.error?.message ?? "");

/** IDs and health only leave this module; provider URLs never appear in errors. */
export class RpcPool {
  private readFailover = false;
  private auditCounts = { balanceAttempts: 0, balanceFailures: 0, failoverReads: 0 };
  private maxVerifiedSlot = 0;
  setReadFailover(enabled: boolean) { this.readFailover = enabled; }
  private health = new Map<string, Health>();
  private cursor = 0;
  constructor(private endpoints: () => Endpoint[], private transport = (e: Endpoint, init: RequestInit) =>
    e.pinned ? safeRpcFetch(e.url, init) : fetch(e.url, init), private clock = () => Date.now()) {}
  private entries() {
    const endpoints = this.endpoints();
    for (const key of this.health.keys()) if (!endpoints.some(e => e.url === key)) this.health.delete(key);
    return endpoints.map(e => {
      let h = this.health.get(e.url);
      if (!h) { h = { latency: null, failures: 0, retryAt: 0, verifiedAt: 0 }; this.health.set(e.url, h); }
      return { e, h };
    });
  }
  private ranked() { return this.entries().filter(({ h }) => h.retryAt <= this.clock()).sort((a, b) =>
    (a.h.latency ?? 1000) - (b.h.latency ?? 1000)); }
  private primary() { const all = this.endpoints(); return all[all.length >= 3 ? 2 : 0]; }
  private assigned(mission: RpcMission) {
    const primary = this.primary()?.url;
    return this.ranked().filter(({ e }) => mission === "wallet" || mission === "priority" ? e.url === primary : e.url !== primary);
  }
  endpoint(mission: RpcMission = "query") {
    const assigned = this.assigned(mission)[0]?.e.url;
    if (assigned) return assigned;
    // SDK construction may need the assigned URL while its circuit is cooling.
    // Actual network reads still enforce the circuit; never spill into another role.
    const primary = this.primary();
    const fallback = mission === "wallet" || mission === "priority" ? primary : this.endpoints().find(e => e.url !== primary?.url);
    if (!fallback) throw new Error("Background RPC unavailable: add a secondary endpoint. Primary remains reserved.");
    return fallback.url;
  }
  status() {
    const primary = this.primary()?.url;
    return this.entries().map(({ e, h }) => ({
      id: e.id, healthy: h.failures === 0, latencyMs: h.latency === null ? null : Math.round(h.latency),
      failures: h.failures, retryAt: h.retryAt > this.clock() ? new Date(h.retryAt).toISOString() : null,
      role: e.url === primary ? "dedicated primary: wallet / priority quotes / swaps"
        : this.readFailover ? "background + verified wallet/safety read fallback; never broadcast" : "background only: discovery / watchlist / AI evidence",
    }));
  }
  availability() {
    const primary = this.entries().find(({ e }) => e.url === this.primary()?.url);
    return { primaryId: primary?.e.id ?? null,
      primaryAvailable: !!primary && primary.h.retryAt <= this.clock(),
      primaryVerified: !!primary?.h.verifiedAt,
      ...this.auditCounts };
  }
  private async request(e: Endpoint, init: RequestInit, timeout = 2500) {
    const h = this.health.get(e.url)!, start = this.clock();
    try {
      const response = await this.transport(e, { ...init, signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
      if (!response.ok) throw new Error("Provider HTTP failure");
      const body = await response.clone().json();
      if (retryable(body)) throw new Error("Provider unavailable");
      const slot = (body as any)?.result?.context?.slot;
      if (Number.isSafeInteger(slot)) this.maxVerifiedSlot = Math.max(this.maxVerifiedSlot, slot);
      h.latency = h.latency === null ? this.clock() - start : 0.7 * h.latency + 0.3 * (this.clock() - start);
      h.failures = 0; h.retryAt = 0;
      return response;
    } catch {
      if (init.signal?.aborted) throw new Error("Optional background request cancelled.");
      h.failures++; h.retryAt = this.clock() + Math.min(60000, 2000 * 2 ** Math.min(h.failures - 1, 5));
      throw new Error("RPC provider unavailable; retrying healthy alternatives.");
    }
  }
  private async verify(e: Endpoint, signal?: AbortSignal, requireFreshSlot = false) {
    const h = this.health.get(e.url)!;
    if (h.verifiedAt && this.clock() - h.verifiedAt < 600000 &&
        (!requireFreshSlot || h.slotAt && this.clock() - h.slotAt < 30000)) return;
    const r = await this.request(e, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "getGenesisHash", params: [] }), signal });
    if (!isSolanaMainnet(String(((await r.json()) as { result?: unknown }).result ?? ""))) {
      h.failures++; h.retryAt = this.clock() + 60000;
      throw new Error("RPC mainnet verification failed.");
    }
    h.verifiedAt = this.clock();
    if (!requireFreshSlot) return;
    const slotResponse = await this.request(e, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "getSlot", params: [{ commitment: "confirmed" }] }), signal });
    const slot = Number(((await slotResponse.json()) as { result?: unknown }).result);
    if (!Number.isSafeInteger(slot) || slot < this.maxVerifiedSlot - 150) {
      h.verifiedAt = 0; h.failures++; h.retryAt = this.clock() + 60000;
      throw new Error("RPC slot freshness verification failed.");
    }
    this.maxVerifiedSlot = Math.max(this.maxVerifiedSlot, slot);
    h.slotAt = this.clock();
  }
  async read(init: RequestInit, mission: RpcMission = "query") {
    let method = "";
    try { method = JSON.parse(String(init.body)).method ?? ""; } catch { /* non-JSON cannot fail over */ }
    const canFailover = this.readFailover && (mission === "wallet" || mission === "priority") && FAILOVER_READS.has(method);
    const balance = method === "getBalance" || method === "getTokenAccountsByOwner";
    if (mission !== "wallet" && mission !== "priority") {
      const deadline = AbortSignal.timeout(3000);
      init = { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline };
    }
    let ranked = this.assigned(mission);
    if (canFailover) ranked = [...ranked, ...this.assigned("background")];
    if (mission !== "wallet" && mission !== "priority" && ranked.length > 1) {
      const offset = this.cursor++ % ranked.length;
      ranked = [...ranked.slice(offset), ...ranked.slice(0, offset)];
    }
    for (const { e } of ranked) {
      const started = this.clock();
      try {
        init.signal?.throwIfAborted();
        if (this.endpoints().length > 1) await this.verify(e, init.signal ?? undefined, canFailover && e.url !== this.primary()?.url);
        const result = await this.request(e, init);
        // Read-only failover is never a broadcast, simulation or expiry-proof fallback.
        if (canFailover && e.url !== this.primary()?.url) this.auditCounts.failoverReads++;
        if (balance) {
          this.auditCounts.balanceAttempts++;
          const body = await result.clone().json() as { error?: unknown };
          if (body.error) this.auditCounts.balanceFailures++;
          balanceAudit({ endpointId: e.id, method, durationMs: this.clock() - started, outcome: body.error ? "rpc-error" : "success",
            fallback: e.url !== this.primary()?.url });
        }
        return result;
      } catch {
        if (balance) {
          this.auditCounts.balanceAttempts++; this.auditCounts.balanceFailures++;
          balanceAudit({ endpointId: e.id, method, durationMs: this.clock() - started, outcome: "failure",
            fallbackAllowed: canFailover });
        }
      }
    }
    throw new Error(mission === "wallet" || mission === "priority"
      ? "Primary RPC unavailable or cooling down; retrying without a replacement order."
      : "Background RPCs unavailable or cooling down; background work will retry without using primary.");
  }
  async broadcast(bytes: Uint8Array, expectedSignature: string) {
    const candidates = this.assigned("priority");
    if (!candidates.length) throw new Error("No healthy RPC available for the existing signed transaction.");
    const encoded = Buffer.from(bytes).toString("base64"); // identical immutable bytes for every provider
    try {
      return await Promise.any(candidates.map(async ({ e }) => {
        await this.verify(e);
        const response = await this.request(e, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction",
            params: [encoded, { encoding: "base64", skipPreflight: false, maxRetries: 0, preflightCommitment: "confirmed" }] }) }, 5000);
        if (((await response.json()) as { result?: string }).result !== expectedSignature) throw new Error("Unexpected transaction signature");
        return expectedSignature;
      }));
    } catch { throw new Error("Submission response unknown. Reconcile the original signature; never create a replacement order."); }
  }
}
export const rpcPool = new RpcPool(rpcEndpoints);
