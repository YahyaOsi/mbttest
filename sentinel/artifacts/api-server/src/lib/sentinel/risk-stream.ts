import { PublicKey, type Connection } from "@solana/web3.js";
import { unpackAccount } from "@solana/spl-token";
import { rpc } from "./chain";
import { rpcEndpoint, rpcGeneration, rpcIsOverride } from "./rpc-config";
import { rpcPool } from "./rpc-pool";
import { rpcWebsocketsAllowed } from "./rpc-endpoint";
import { PinnedRpcLogSubscriptions } from "./rpc-websocket";
import { jsonFetch } from "./http";
import { SOL, USDC, validMint } from "./discovery-policy";
import { decodeSupportedMint } from "./token-policy";
import { RAYDIUM_POOLS } from "./route-policy";
import { majorWalletOutflow, vaultSnapshot, blockLiquidityDrop, type VaultPair } from "./chain-risk-policy";
import type { Position, State } from "./types";
import { pumpState, dbcState } from "./launchpad-state";
import { PUMP_PROGRAM, pumpCurveAddress } from "./curve-policy";

async function verifiedCurvePool(connection: Connection, mint: string): Promise<VaultPair> {
  const key = new PublicKey(mint);
  const raw = await connection.getAccountInfo(pumpCurveAddress(key));
  if (raw?.owner.equals(PUMP_PROGRAM)) {
    const p = await pumpState(connection, key);
    // Pump's SOL is native lamports, not a WSOL vault. This observes total
    // curve holdings (including rent/accrued fees), not virtual liquidity.
    return { pool: p.pool.toBase58(), vaultA: p.baseVault.toBase58(), vaultB: p.pool.toBase58(),
      mintA: mint, mintB: SOL, decimalsA: p.supported.mint.decimals, decimalsB: 9, nativeB: true, venue: "Pump.fun curve holdings" };
  }
  const d = await dbcState(connection, key);
  return { pool: d.pool.toBase58(), vaultA: d.state.baseVault.toBase58(), vaultB: d.state.quoteVault.toBase58(),
    mintA: mint, mintB: SOL, decimalsA: d.supported.mint.decimals, decimalsB: 9, venue: "Meteora DBC vault holdings" };
}

type Watch = {
  position: Position; solPrice: number; connection: Connection; ids: number[]; supply: bigint;
  pools: VaultPair[]; seen: Set<string>; queue: Promise<void>; minute: number; used: number; stopped: boolean;
  status: string; queued: number; blocks: Map<string, { slot: number; samples: Map<string, { before: number; after: number }>; prices: Record<string, number> }>;
  mappingVersion: string;
  logSubscriptions: Connection | PinnedRpcLogSubscriptions;
};
const watches = new Map<string, Watch>();
export function resetRpcRiskStreams() {
  for (const w of watches.values()) {
    w.stopped = true;
    for (const id of w.ids) void w.logSubscriptions.removeOnLogsListener(id).catch(() => undefined);
    if (w.logSubscriptions instanceof PinnedRpcLogSubscriptions) w.logSubscriptions.close();
  }
  watches.clear();
}
const alerts = new Map<string, string[]>();
export function drainRiskAlerts(userId: string) {
  const a = alerts.get(userId) ?? []; alerts.delete(userId); return a;
}
async function verifiedPools(connection: Connection, ids: string[], mint: string): Promise<VaultPair[]> {
  if (!ids.length) return [];
  const response = await jsonFetch(`https://api-v3.raydium.io/pools/key/ids?ids=${ids.join(",")}`);
  if (!response?.success || !Array.isArray(response.data)) return [];
  const pools: VaultPair[] = [];
  for (const p of response.data) {
    // AMM v4 can move reserves through OpenBook; vault-only liquidity deltas
    // would incorrectly flag that activity as liquidity removal.
    if (!p || !ids.includes(p.id) || !RAYDIUM_POOLS.has(p.programId) || p.programId.startsWith("675k") ||
        ![p.mintA?.address, p.mintB?.address].includes(mint) ||
        ![p.mintA?.address, p.mintB?.address].some(m => [SOL, USDC].includes(m)) ||
        ![p.id, p.vault?.A, p.vault?.B, p.mintA?.address, p.mintB?.address].every(validMint)) continue;
    const keys = [p.id, p.vault.A, p.vault.B].map((k: string) => new PublicKey(k));
    const [state, a, b] = await connection.getMultipleAccountsInfo(keys);
    if (!state || state.owner.toBase58() !== p.programId || !a || !b ||
        !state.data.includes(keys[1].toBuffer()) || !state.data.includes(keys[2].toBuffer()) ||
        !state.data.includes(new PublicKey(p.mintA.address).toBuffer()) ||
        !state.data.includes(new PublicKey(p.mintB.address).toBuffer())) continue;
    const aa = unpackAccount(keys[1], a, a.owner), bb = unpackAccount(keys[2], b, b.owner);
    if (aa.mint.toBase58() !== p.mintA.address || bb.mint.toBase58() !== p.mintB.address || !aa.owner.equals(bb.owner)) continue;
    pools.push({ pool: p.id, vaultA: p.vault.A, vaultB: p.vault.B, mintA: p.mintA.address, mintB: p.mintB.address,
      decimalsA: p.mintA.decimals, decimalsB: p.mintB.decimals });
  }
  return pools;
}
export async function syncRiskStreams(userId: string, s: State, emergency: () => Promise<void>) {
  const active = s.positions.filter(p => p.mode === "live" && p.walletAddress === s.walletBinding && p.status === "open");
  const wanted = new Set(active.map(p => `${userId}:${p.id}`));
  for (const [key, watch] of watches) if (key.startsWith(`${userId}:`) && !wanted.has(key)) {
    watch.stopped = true;
    for (const id of watch.ids) void watch.logSubscriptions.removeOnLogsListener(id).catch(() => undefined);
    if (watch.logSubscriptions instanceof PinnedRpcLogSubscriptions) watch.logSubscriptions.close();
    watches.delete(key);
  }
  for (const position of active) {
    const key = `${userId}:${position.id}`, existing = watches.get(key);
    const mappingVersion = `${rpcGeneration()}:${position.curveMigratedAt ?? ""}:${(position.riskPoolIds ?? []).join(",")}`;
    if (existing && existing.mappingVersion === mappingVersion) { existing.position = position; existing.solPrice = s.solPriceUsd ?? existing.solPrice; position.riskMonitoring = existing.status; continue; }
    if (existing) {
      existing.stopped = true;
      for (const id of existing.ids) void existing.logSubscriptions.removeOnLogsListener(id).catch(() => undefined);
      if (existing.logSubscriptions instanceof PinnedRpcLogSubscriptions) existing.logSubscriptions.close();
    }
    const endpoint = rpcPool.endpoint("background"), connection = rpc("background");
    const customPinned = rpcIsOverride() && !rpcWebsocketsAllowed(endpoint);
    const logSubscriptions = new PinnedRpcLogSubscriptions(endpoint);
    const w: Watch = { position, solPrice: s.solPriceUsd ?? 0, connection, ids: [], supply: 0n,
      pools: [], seen: new Set(), queue: Promise.resolve(), minute: 0, used: 0, stopped: false,
      status: customPinned
        ? "Secure DNS-pinned websocket connecting; 15-second exit polling remains active."
        : "Starting RPC alert monitor; 15-second polling remains active.",
      queued: 0, blocks: new Map(), mappingVersion, logSubscriptions };
    watches.set(key, w);
    if (logSubscriptions instanceof PinnedRpcLogSubscriptions) {
      logSubscriptions.onStatus(state => {
        const detail = `${w.pools.length} verified pool/curve mapping(s); polling remains active.`;
        w.status = state === "connected"
          ? `Secure DNS-pinned websocket subscriptions active; ${detail} Delivery is not guaranteed.`
          : state === "connecting"
            ? `Secure DNS-pinned websocket connecting or subscribing; ${detail}`
            : `Secure DNS-pinned websocket unavailable; alert coverage is degraded. ${detail}`;
        position.riskMonitoring = w.status;
      });
    }
    // Initialization stays outside the state lock and never signs transactions.
    void (async () => {
      const mint = new PublicKey(position.mint);
      w.supply = decodeSupportedMint(mint, await connection.getAccountInfo(mint)).mint.supply;
      const poolIds = (position.riskPoolIds ?? []).filter(validMint).slice(0, 4);
      w.pools = await verifiedPools(connection, poolIds, position.mint).catch(() => []);
      if (!position.curveMigratedAt && (position.curveKind || /Native (Pump|Meteora)/.test(position.executionVenue ?? ""))) {
        const curve = await verifiedCurvePool(connection, position.mint).catch(() => null);
        if (curve) w.pools.push(curve);
      }
      if (w.stopped) return;
      if (!customPinned) {
        w.status = `RPC subscriptions requested: large-wallet outflows; ${w.pools.length} verified Raydium/launchpad holdings pair(s). ${w.pools.length ? "Awaiting confirmed events." : "No verified reserve mapping; liquidity-event coverage unavailable."} Pump native holdings include rent/accrued fees. Polling remains active.`;
      }
      const handle = (signature: string) => {
        if (w.stopped || w.seen.has(signature)) return;
        if (w.queued >= 4) { w.status = "RPC decode queue saturated; event coverage incomplete. Polling remains active."; return; }
        const minute = Math.floor(Date.now() / 60000);
        if (w.minute !== minute) { w.minute = minute; w.used = 0; }
        if (w.used >= 60) { w.status = "RPC event budget reached (60 decoded transactions/minute); stream coverage incomplete. Polling remains active."; return; }
        w.used++; w.queued++; w.seen.add(signature);
        if (w.seen.size > 500) w.seen.delete(w.seen.values().next().value!);
        w.queue = w.queue.then(async () => {
          if (w.stopped) return;
          const tx = await connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          if (!tx?.meta || tx.meta.err) { w.status = "RPC transaction missing/failed; event coverage incomplete. Polling remains active."; return; }
          w.status = `Confirmed RPC event at slot ${tx.slot}; ${w.pools.length} verified vault pair(s). No guarantee of complete event delivery.`;
          if (tx.meta.logMessages?.some(l => /Instruction: (Migrate|Migration)/.test(l))) {
            w.pools = w.pools.filter(p => !p.venue);
            w.blocks.clear();
            w.status = "Curve migration observed; old reserve mapping removed. Post-migration coverage requires a separately verified pool. Polling remains active.";
          }
          let reason = majorWalletOutflow(tx, position.mint, w.supply)
            ? "Large-wallet alert: a signer shed at least 1% of token supply and half its observed holdings, with SOL/USDC proceeds (developer identity not asserted)" : null;
          for (const pair of w.pools) {
            const blockKey = `${pair.pool}:${tx.slot}`;
            let block = w.blocks.get(blockKey);
            if (!block) { block = { slot: tx.slot, samples: new Map(),
              prices: { [position.mint]: w.position.currentPriceUsd, [SOL]: w.solPrice, [USDC]: 1 } }; w.blocks.set(blockKey, block); }
            const sample = vaultSnapshot(tx, pair, block.prices);
            if (!sample) continue;
            block.samples.set(signature, sample);
            const approximateLoss = [...block.samples.values()].reduce((loss, s) => loss + s.before - s.after, 0);
            const dropPct = position.fastCrazyExit ? 25 : 30;
            if (sample.after <= sample.before * (1 - dropPct / 100) || approximateLoss >= sample.before * dropPct / 100) {
              const data = await connection.getBlockSignatures(tx.slot, "confirmed");
              if (data && blockLiquidityDrop(block.samples, data.signatures, dropPct)) reason = `Verified ${pair.venue ?? "Raydium vault holdings"} fell at least ${dropPct}% across continuous observed changes in one confirmed block (fixed-price valuation; event coverage is not universal)`;
            }
          }
          for (const [k, b] of w.blocks) if (b.slot < tx.slot - 40) w.blocks.delete(k);
          if (reason && !w.stopped) {
            w.status = `Critical alert at slot ${tx.slot}. Emergency liquidation requested.`;
            const messages = alerts.get(userId) ?? [];
            messages.push(`${position.symbol}: ${reason}. Slot ${tx.slot}; signature ${signature}.`);
            alerts.set(userId, messages.slice(-20));
            await emergency(); // Durable stop latch first; then try the regular reconciled executor.
          }
        }).catch(() => { w.status = "RPC stream decode unavailable; block/dump coverage degraded. Polling remains active."; }).finally(() => { w.queued--; });
      };
      for (const id of new Set([position.mint, ...poolIds, ...w.pools.flatMap(p => [p.pool, p.vaultA, p.vaultB])])) {
        w.ids.push(logSubscriptions.onLogs(new PublicKey(id), (event) => { if (!event.err) handle(event.signature); }, "confirmed"));
      }
    })().catch(() => {
      w.stopped = true;
      for (const id of w.ids) void w.logSubscriptions.removeOnLogsListener(id).catch(() => undefined);
      if (w.logSubscriptions instanceof PinnedRpcLogSubscriptions) w.logSubscriptions.close();
      w.status = `RPC alert initialization unavailable; ${customPinned ? "DNS-pinned websocket alert coverage is unavailable." : "no block-level coverage is confirmed."} Polling remains active.`;
      // Retry on a future monitoring cycle rather than claiming a connected stream.
      if (watches.get(key) === w) watches.delete(key);
      position.riskMonitoring = w.status;
    });
    position.riskMonitoring = w.status;
  }
}
