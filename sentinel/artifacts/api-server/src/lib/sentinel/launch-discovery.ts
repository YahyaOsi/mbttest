import type { Connection } from "@solana/web3.js";
import { verifyCreation, type LaunchRecord } from "./launch-events";
import { PUMP_PROGRAM } from "./curve-policy";
import { verifyLaunchpadProgram } from "./launchpad-policy";
import { PinnedRpcLogSubscriptions, type RpcLogSubscriptionClient } from "./rpc-websocket";
import { ingestPumpLogs, recentPumpCreations } from "./pump-observations";
import { MOONIT_PROGRAM } from "./moonit-policy";
import { verifyMoonitSource } from "./moonit-state";
import { ingestMoonitLogs } from "./moonit-observations";
import { retainLaunchRecords } from "./launch-allocation";

type Page = {
  head?: string; before?: string; target?: string; pending: string[]; hints?: string[]; done?: boolean;
};
export type LaunchDiscoveryState = {
  sources: Record<string, Page>; records: LaunchRecord[]; lastPollAt: number; status: string;
  workTurn?: number;
  workCursors?: { pump: number; secondary: number };
};
export const emptyLaunchDiscovery = (): LaunchDiscoveryState => ({
  sources: {}, records: [], lastPollAt: 0, status: "Creation feed not checked",
});
export const LAUNCH_RPC_CAP = 24;
const PAGE_SIZE = 12;
const MAX_HINTS = 48;
const RETENTION_MS = 24 * 3600000;

/** Logs are low-latency hints only. Confirmed, paged RPC reconciliation is the
 * authority, including after reconnect/restart. All durable progress lives in
 * the owner's existing PostgreSQL ledger, never a process-local cursor.
 */
export class LaunchDiscovery {
  private hints = new Map<string, Set<string>>();
  private subscriptions: number[] = [];
  private subscribedAt = 0;
  private overflow = false;
  private subscriptionStatus: "connecting" | "connected" | "unavailable" = "connecting";
  private records: LaunchRecord[] = [];
  constructor(
    private connection: Connection,
    private allowSubscriptions = true,
    private subscriptionClient: RpcLogSubscriptionClient = connection,
  ) {
    if (subscriptionClient instanceof PinnedRpcLogSubscriptions) {
      subscriptionClient.onStatus(state => { this.subscriptionStatus = state; });
    }
  }

  async stop() {
    const ids = this.subscriptions.splice(0);
    await Promise.all(ids.map(id => this.subscriptionClient.removeOnLogsListener(id).catch(() => undefined)));
    this.subscribedAt = 0;
  }
  async dispose() {
    await this.stop();
    if (this.subscriptionClient instanceof PinnedRpcLogSubscriptions) this.subscriptionClient.close();
  }
  private async subscribe(at: number) {
    if (!this.allowSubscriptions) return;
    // web3 reconnects automatically; periodic renewal also recovers silent
    // subscriptions. Reconciliation never depends on websocket delivery.
    if (this.subscribedAt && at - this.subscribedAt < 300000) return;
    await this.stop();
    for (const program of [PUMP_PROGRAM, MOONIT_PROGRAM]) {
      const key = program.toBase58();
      this.subscriptions.push(this.subscriptionClient.onLogs(program, (event, context) => {
        if (program.equals(PUMP_PROGRAM)) {
          // Decode current logs directly. Never put Pump creations through
          // capped signature hints or archive transaction reconstruction.
          ingestPumpLogs(event, context.slot);
          return;
        }
        ingestMoonitLogs(event, context.slot, this.records);
        if (event.err || !event.logs.some(l => /Instruction: (Create(V2)?|TokenMint)$/.test(l))) return;
        const hints = this.hints.get(key) ?? new Set<string>();
        if (hints.size >= MAX_HINTS) { this.overflow = true; return; }
        hints.add(event.signature); this.hints.set(key, hints);
      }, "confirmed"));
    }
    this.subscribedAt = at;
  }

  async poll(state: LaunchDiscoveryState, save: () => Promise<void>, at = Date.now()) {
    state.records = retainLaunchRecords(state.records, at);
    // Drain decoded WS events on EVERY worker cycle, not once a minute.
    const known = new Set(state.records.map(r => r.mint));
    state.records = retainLaunchRecords([...state.records, ...recentPumpCreations().filter(r => !known.has(r.mint))], at);
    this.records = state.records;
    if (recentPumpCreations().length) await save();
    if (state.lastPollAt && at - state.lastPollAt < 60000) return;
    state.lastPollAt = at;
    const warnings: string[] = [];
    let used = 0;
    let sourceLimit = LAUNCH_RPC_CAP;
    const deadline = Date.now() + 10000;
    // Count every HTTP RPC, including program/ProgramData linkage reads. These
    // wrappers prevent SDK helpers from accidentally exceeding the budget.
    const bounded = new Proxy(this.connection, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (["getAccountInfo", "getMultipleAccountsInfo", "getParsedTransaction", "getSignaturesForAddress"].includes(String(prop))) {
          return (...args: unknown[]) => {
            if (used >= sourceLimit || used >= LAUNCH_RPC_CAP || Date.now() > deadline) throw new Error("Creation RPC/time budget exhausted");
            used++;
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
    try { await this.subscribe(at); } catch { warnings.push("log subscription unavailable; using paged RPC recovery"); }
    // Pump.fun live mints are handled by the creation WebSocket + current mint
    // account checks. Do not page old Pump signatures/transactions here.
    // This bounded archive budget applies ONLY to the unrelated Moonit feed.
    for (const program of [MOONIT_PROGRAM]) {
      sourceLimit = program.equals(MOONIT_PROGRAM) ? Math.ceil(LAUNCH_RPC_CAP * 0.2) : LAUNCH_RPC_CAP;
      const key = program.toBase58(), page = state.sources[key] ??= { pending: [] };
      try {
        const hints = this.hints.get(key) ?? new Set<string>();
        page.hints = [...new Set([...(page.hints ?? []), ...hints])].slice(0, MAX_HINTS);
        hints.clear();
        await save();
        if (program.equals(MOONIT_PROGRAM)) await verifyMoonitSource(bounded, at, this.connection);
        else await verifyLaunchpadProgram(bounded, program);
        if (!page.pending.length) {
          const rows = await bounded.getSignaturesForAddress(program, {
            limit: PAGE_SIZE, ...(page.before ? { before: page.before } : {}), ...(page.head ? { until: page.head } : {}),
          }, "confirmed");
          if (!page.target && rows.length) page.target = rows[0].signature;
          page.pending = rows.filter(r => !r.err).map(r => r.signature);
          page.before = rows.at(-1)?.signature ?? page.before;
          // Bootstrap only samples the latest page. Later reconnects paginate
          // to the last completed head without skipping a saturated page.
          page.done = !page.head || rows.length < PAGE_SIZE;
          await save();
        }
        // Durable per-source cursors are independent; bounded work shares the cap.
        const work = [...new Set([...page.pending.slice(0, 2), ...page.hints.slice(0, 2),
          ...page.pending, ...page.hints])].slice(0, 10);
        for (const signature of work) {
          // Reserve two reads: transaction + mint/pool proof.
          if (used > sourceLimit - 2) break;
          const tx = await bounded.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          if (!tx) { warnings.push("transaction not yet available; cursor retained for retry"); continue; }
          const record = await verifyCreation(bounded, tx, signature, program, at);
          if (record) {
            state.records = retainLaunchRecords([record, ...state.records.filter(r => r.mint !== record.mint)], at);
            this.records = state.records;
          }
          // Persist the record and consumed signature atomically.
          page.pending = page.pending.filter(s => s !== signature);
          page.hints = page.hints.filter(s => s !== signature);
          await save();
        }
        if (!page.pending.length && page.done) {
          page.head = page.target ?? page.head;
          delete page.before; delete page.target; delete page.done;
        }
        if (page.pending.length || page.before || page.hints.length) warnings.push(`${program.equals(PUMP_PROGRAM) ? "Pump.fun" : "Moonit"} recovery backlog; coverage incomplete`);
      } catch {
        warnings.push(`${program.equals(PUMP_PROGRAM) ? "Pump.fun" : "Moonit"} RPC verification unavailable/capped; cursor retained`);
      }
    }
    state.records = retainLaunchRecords(state.records, at);
    if (this.overflow) warnings.push("log hint queue saturated; paged recovery required");
    this.overflow = false;
    state.status = `Creation feed: ${state.records.length} retained launch/hint(s); canonical mint/curve checks run in the scanner; ${used}/${LAUNCH_RPC_CAP} Moonit-only recovery RPC reads per minute. Pump.fun archive sampling disabled. ` +
      "80/20 target: Pump.fun / approved Moonit CP-V1; unused secondary capacity spills to Pump.fun. Stonk/PONS/DBC/unverified and unsupported Moonit variants disabled. Bounded sampling, not every launch. " +
      (this.subscriptionClient instanceof PinnedRpcLogSubscriptions
        ? `Secure DNS-pinned log hints ${this.subscriptionStatus}; paged RPC recovery remains authoritative. `
        : "") +
      (warnings.length ? warnings.join("; ") : "Log subscriptions requested; durable RPC reconciliation completed. Delivery not guaranteed.");
    await save();
  }
}
