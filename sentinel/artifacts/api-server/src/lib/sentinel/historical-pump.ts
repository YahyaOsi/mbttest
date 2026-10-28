import { jsonFetch } from "./http";
import { validMint } from "./discovery-policy";
import type { State } from "./types";
import { rpc } from "./chain";
import { PUMP_PROGRAM } from "./curve-policy";
import { ingestPumpLogs, recentPumpCreations } from "./pump-observations";
/** Public nominations only; every origin/authority/route is checked separately.
 * API pages do not limit the retained universe. Cursor never advances on error. */
export async function historicalPumpPage(s: State, at = Date.now()) {
  s.pumpHistory ??= { offset: 0, nextAt: 0 };
  const state = s.pumpHistory;
  if (at < state.nextAt) return [] as string[];
  state.nextAt = at + 30000;
  try {
    const rows = await jsonFetch(`https://frontend-api-v3.pump.fun/coins?offset=${state.offset}&limit=50&sort=created_timestamp&order=ASC&includeNsfw=true`);
    if (!Array.isArray(rows) || rows.some(r => !validMint(r?.mint))) throw new Error("Unsupported history response");
    state.offset += rows.length;
    state.error = undefined;
    if (!rows.length) state.nextAt = at + 300000;
    return rows.map(r => r.mint) as string[];
  } catch {
    state.error = "Pump historical API unavailable; using paginated confirmed RPC history. Coverage depends on provider archive access.";
    try {
      if (!state.pending?.length) {
        const page = await rpc().getSignaturesForAddress(PUMP_PROGRAM, { before: state.before, limit: 1000 }, "confirmed");
        state.pending = page.filter(row => !row.err).map(row => row.signature);
        state.nextBefore = page.at(-1)?.signature;
        if (!page.length) { state.nextAt = at + 300000; return []; }
      }
      const mints: string[] = [], deadline = Date.now() + 5000;
      while (state.pending.length && Date.now() < deadline) {
        // The configured RPC plan accepts at most five batched reads.
        const signatures = state.pending.slice(0, 5);
        const transactions = await rpc().getParsedTransactions(signatures, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        for (let i = 0; i < transactions.length; i++) {
          const tx = transactions[i];
          if (!tx?.meta || tx.meta.err || !tx.meta.logMessages) continue;
          ingestPumpLogs({ signature: signatures[i], err: null, logs: tx.meta.logMessages }, tx.slot);
          mints.push(...recentPumpCreations().filter(row => row.signature === signatures[i]).map(row => row.mint));
        }
        if (transactions.some(tx => tx === null)) break; // retain unresolved archive work
        state.pending.splice(0, signatures.length);
      }
      if (!state.pending.length && state.nextBefore) { state.before = state.nextBefore; state.nextBefore = undefined; }
      return [...new Set(mints)];
    } catch {
      state.error = "Historical API and RPC archive unavailable; both cursors retained. Live and known-token scans continue.";
      state.nextAt = at + 60000;
      return [];
    }
  }
}
