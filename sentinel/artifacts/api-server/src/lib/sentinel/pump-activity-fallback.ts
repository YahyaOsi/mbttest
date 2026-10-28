import { PublicKey } from "@solana/web3.js";
import { rpc } from "./chain";
import { pumpCurveAddress } from "./curve-policy";
import { ingestPumpLogs } from "./pump-observations";
import { withRpcMission } from "./rpc-context";

let minute = 0, used = 0, busy = false;
const last = new Map<string, number>();
/** Recent trades only, never archive creation verification. At most four
 * secondary requests/minute globally; missing evidence stays unknown. */
export async function refreshRecentPumpActivity(mint: string, at = Date.now()) {
  if (Math.floor(at / 60000) !== minute) { minute = Math.floor(at / 60000); used = 0; }
  if (busy || used >= 4 || at - (last.get(mint) ?? 0) < 60000) return;
  busy = true;
  last.set(mint, at);
  for (const [key, time] of last) if (at - time > 600000) last.delete(key);
  try {
    await withRpcMission("background", async () => {
      const connection = rpc("background");
      used++;
      const recent = await connection.getSignaturesForAddress(pumpCurveAddress(new PublicKey(mint)), { limit: 5 }, "confirmed");
      for (const item of recent) {
        if (used >= 4) break;
        if (item.err || !item.blockTime || item.blockTime * 1000 < at - 300000 || item.blockTime * 1000 > at) continue;
        used++;
        const tx = await connection.getTransaction(item.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!tx?.meta || !tx.blockTime || at - tx.blockTime * 1000 > 300000) continue;
        ingestPumpLogs({ signature: item.signature, err: tx.meta.err, logs: tx.meta.logMessages ?? [] }, tx.slot, tx.blockTime * 1000);
      }
    });
  } catch { /* A background provider failure must never poison wallet health. */ }
  finally { busy = false; }
}
