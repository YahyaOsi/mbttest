import { PublicKey } from "@solana/web3.js";
import { rpc } from "./chain";
import { SOL, validMint } from "./discovery-policy";
import { crazyState, FOMO_SOURCE, MAX_COPY_LAG_MS } from "./crazy-policy";
import { event } from "./store";
import { jsonFetch } from "./http";
import type { CopySignal, CrazyLeader, State } from "./types";
import { targetLeaders } from "./copy-targets";
import { acknowledgeCopyActivity, copyStreamGapAt, copyStreamStatus, pendingCopyActivity, queuedCopyActivity, syncCopyStream } from "./copy-stream";

const SWAPS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
]);
const key = (x: any): string => x?.toBase58?.() ?? x?.pubkey?.toBase58?.() ?? x?.pubkey ?? String(x);
export function rankedFomoWallets(payload: any, at = Date.now(), forTargets = false): Omit<CrazyLeader, "losingCopies" | "demoted">[] {
  const stamp = Date.parse(payload?.syncedAt);
  if (payload?.source !== "fomo" || payload?.stale || payload?.window !== "24h" ||
      payload?.board !== "fomo-parity" || !Number.isFinite(stamp) || at - stamp > 30 * 60000 ||
      stamp > at + 60000 || !Array.isArray(payload.data)) throw new Error("Fresh Fomo-reported daily leaderboard unavailable; no computed-board substitution.");
  const leaders: Omit<CrazyLeader, "losingCopies" | "demoted">[] = [];
  for (const row of [...payload.data].sort((a, b) => a.rank - b.rank)) {
    if (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > 10 || (!forTargets && !(row.pnlUsd > 0)) || row.walletLinkPending || row.lowCoverage === true) continue;
    for (const w of Array.isArray(row.wallets) ? row.wallets : []) {
      if (w.chain === "solana" && validMint(w.address) && !leaders.some(l => l.wallet === w.address)) {
        leaders.push({ wallet: w.address, handle: String(row.handle ?? row.displayName ?? "Unknown").slice(0, 64), rank: row.rank });
        break; // one public Solana wallet per trader; bounded monitoring
      }
    }
    if (leaders.length === (forTargets ? 10 : 3)) break;
  }
  if (!leaders.length) throw new Error("No usable linked Solana wallets in the public Fomo daily top ten.");
  return leaders;
}
/** Only confirmed signer swaps with one non-SOL asset and real SOL settlement. No transfer-only copies. */
export function leaderSwap(tx: any, wallet: string, handle: string, signature: string): CopySignal | null {
  if (!tx?.meta || tx.meta.err || !Number.isSafeInteger(tx.blockTime)) return null;
  const msg = tx.transaction?.message, keys: any[] = msg?.accountKeys ?? [];
  const index = keys.findIndex(k => key(k) === wallet && k.signer);
  if (index < 0) return null;
  const instructions = [...(msg.instructions ?? []), ...(tx.meta.innerInstructions ?? []).flatMap((g: any) => g.instructions ?? [])];
  if (!instructions.some((i: any) => SWAPS.has(key(i.programId)))) return null;
  const pre: any[] = tx.meta.preTokenBalances ?? [], post: any[] = tx.meta.postTokenBalances ?? [];
  const owned = [...pre, ...post].filter(b => b.owner === wallet);
  const mints = [...new Set(owned.map(b => b.mint).filter(m => m !== SOL))];
  const amount = (rows: any[], mint: string): bigint => rows.filter(b => b.owner === wallet && b.mint === mint)
    .reduce<bigint>((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
  const changes = mints.map(mint => ({ mint, before: amount(pre, mint), after: amount(post, mint) }))
    .filter(c => c.before !== c.after);
  if (changes.length !== 1 || !validMint(changes[0].mint)) return null;
  const c = changes[0], delta = c.after - c.before;
  const decimals = owned.find(b => b.mint === c.mint)?.uiTokenAmount?.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) return null;
  // Include token-account lamports on both sides: ATA/WSOL rent creates/closes
  // then cancel, rather than inflating the leader's entry price and chase limit.
  const indices = new Set<number>([index, ...owned.map(b => b.accountIndex)]);
  let nativeDelta = 0n;
  for (const i of indices) {
    const a = tx.meta.preBalances?.[i], b = tx.meta.postBalances?.[i];
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
    nativeDelta += BigInt(b) - BigInt(a);
  }
  if (index === 0) nativeDelta += BigInt(tx.meta.fee ?? 0);
  if (delta === 0n || nativeDelta === 0n || (delta > 0n) === (nativeDelta > 0n)) return null;
  const priceSol = Math.abs(Number(nativeDelta) / 1e9 / (Number(delta) / 10 ** decimals));
  if (!Number.isFinite(priceSol) || priceSol <= 0) return null;
  return { id: signature, wallet, handle, mint: c.mint, side: delta > 0n ? "buy" : "sell",
    at: tx.blockTime * 1000, priceSol, fraction: delta > 0n ? 1 : Math.min(1, Number(-delta) / Number(c.before)) };
}
export async function pollFomo(s: State, at = Date.now()) {
  const state = crazyState(s);
  const existingCopies = s.positions.filter(p => p.leaderWallet && ["open", "pending"].includes(p.status));
  const wantsEntries = s.running && (!!s.settings.trackFomoHandles || !!s.settings.copyTradingEnabled);
  if (!wantsEntries && !existingCopies.length) { syncCopyStream([]); return false; }
  const pollingDue = at - state.lastPollAt >= 14000;
  if (!pollingDue && !queuedCopyActivity()) return false;
  if (pollingDue) state.lastPollAt = at;
  const needsRanking = !!s.settings.trackFomoHandles && (s.settings.riskMode === "crazy" ||
    (s.settings.copyTargets ?? []).some(t => t.platform === "fomo" && !t.wallet));
  if (wantsEntries && needsRanking && at - state.lastRefreshAt >= 15 * 60000) {
    state.lastRefreshAt = at; // bound retries even when this independent provider is down
    try {
      const payload = await jsonFetch("https://api.fomo-api.com/v1/leaderboard?window=24h&board=fomo-parity&limit=10");
      const linked = rankedFomoWallets(payload, at, true);
      const ranked = s.settings.riskMode === "crazy" ? rankedFomoWallets(payload, at) : [];
      const old = state.leaders;
      const targets = targetLeaders(s.settings, old, linked.map(l => ({ ...l, losingCopies: 0, demoted: false })));
      state.leaders = [...targets, ...ranked.filter(l => !targets.some(t => t.wallet === l.wallet)).map(l => ({ ...l, origin: "ranked" as const, active: true, losingCopies: old.find(o => o.wallet === l.wallet)?.losingCopies ?? 0,
        demoted: old.find(o => o.wallet === l.wallet)?.demoted ?? false })),
        ...old.filter(o => !ranked.some(l => l.wallet === o.wallet) && !targets.some(t => t.wallet === o.wallet)).map(l => ({ ...l, active: false }))].slice(0, 100);
      state.sourceAt = payload.syncedAt;
      state.status = `${FOMO_SOURCE}. Monitoring up to 3 linked wallets; figures include unrealized gains and are not audited profitability.`;
      event(s, "fomo", state.status);
    } catch {
      state.status = "Fomo daily leaderboard unavailable/stale. Ranking-dependent copies blocked; manual wallets and existing leader exits remain independent.";
      state.sourceAt = null;
      event(s, "fomo", state.status, "warning");
    }
  }
  const sourceAge = at - Date.parse(state.sourceAt ?? "");
  const freshSource = Number.isFinite(sourceAge) && sourceAge >= 0 && sourceAge < 30 * 60000;
  const targets = targetLeaders(s.settings, state.leaders,
    freshSource ? state.leaders.filter(l => l.origin === "username") : []);
  const old = state.leaders;
  const ranked = s.settings.trackFomoHandles && freshSource && s.settings.riskMode === "crazy"
    ? old.filter(l => l.active && l.origin !== "target" && l.origin !== "username" && !l.demoted).slice(0, 3) : [];
  state.leaders = [...targets, ...ranked.filter(l => !targets.some(t => t.wallet === l.wallet)),
    ...old.filter(l => !targets.some(t => t.wallet === l.wallet) && !ranked.some(r => r.wallet === l.wallet))
      .map(l => ({ ...l, active: false }))].slice(0, 100);
  const active = wantsEntries ? state.leaders.filter(l => l.active && !l.demoted) : [];
  const wallets = new Map(active.map(l => [l.wallet, l.handle]));
  for (const p of existingCopies) wallets.set(p.leaderWallet!, p.leaderHandle ?? p.leaderWallet!);
  syncCopyStream([...wallets.keys()]);
  const unresolved = s.settings.trackFomoHandles
    ? (s.settings.copyTargets ?? []).filter(t => !t.wallet && !targets.some(l => l.handle.replace(/^@/, "").toLowerCase() === t.username.replace(/^@/, "").toLowerCase())).length : 0;
  const previousStatus = state.status;
  state.status = `${active.length} active leader wallet(s); ${unresolved} unresolved FOMO username(s). ${copyStreamStatus()} No transfer-only copies; no X post feed.`;
  if (state.status !== previousStatus) event(s, "copy-stream", state.status,
    /connected\./.test(copyStreamStatus()) ? "info" : "warning");
  for (const notice of pendingCopyActivity(new Set(wallets.keys()), at)) {
    try {
      const connection = rpc();
      const tx = await connection.getParsedTransaction(notice.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!tx) continue; // confirmed log can arrive before transaction indexing
      const signal = leaderSwap(tx, notice.wallet, wallets.get(notice.wallet)!, notice.signature);
      if (signal && !state.signals.some(e => e.id === signal.id)) {
        state.signals.push(signal);
        event(s, "copy-signal", `${signal.handle}: live confirmed ${signal.side}; signer and SOL swap verified.`, "info", signal.mint);
      }
      acknowledgeCopyActivity(notice.signature, notice.wallet);
    } catch { /* Retry this exact live signature until timeout; never crawl wallet history. */ }
  }
  // A stream gap can conceal a leader sell. Do not invent an uninterrupted
  // history or leave existing copied positions falsely marked as monitored.
  for (const position of existingCopies) {
    if (!position.copyExitUncertain && copyStreamGapAt(position.leaderWallet!) >= Date.parse(position.openedAt)) {
      position.copyExitUncertain = true;
      event(s, "copy-gap", "Leader wallet stream had an observation gap; existing copied position requires a defensive exit. New buys still require a fresh verified live signal.", "warning", position.mint);
    }
  }
  state.signals = state.signals.filter(e => at - e.at < 15 * 60000 || e.side === "sell" &&
    existingCopies.some(p => p.leaderWallet === e.wallet && p.mint === e.mint && e.at >= Date.parse(p.openedAt) - 1000)).slice(-150);
  state.consumed = state.consumed.slice(-300);
  return true;
}
