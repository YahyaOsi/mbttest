import { moonitSdk, MOONIT_PROGRAM } from "./moonit-policy";
import { observePumpTrade } from "./pump-observations";
import type { LaunchRecord } from "./launch-events";
type Trade = { at: number; buy: boolean; sol: number; price: number };
const activity = new Map<string, Trade[]>(), seen = new Set<string>();
export function ingestMoonitLogs(event: { err: unknown; logs: string[]; signature: string }, slot: number, records: LaunchRecord[], at = Date.now()) {
  if (event.err || seen.has(event.signature)) return;
  seen.add(event.signature); if (seen.size > 6000) seen.delete(seen.values().next().value!);
  const stack: string[] = [];
  for (const line of event.logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]); continue; }
    if (/^Program \w+ (success|failed:)/.test(line)) { stack.pop(); continue; }
    if (stack.at(-1) !== MOONIT_PROGRAM.toBase58() || !line.startsWith("Program data: ")) continue;
    try {
      const e = moonitSdk().provider.program.coder.events.decode(line.slice(14));
      if (e?.name.toLowerCase() !== "tradeevent") continue;
      const d = e.data as any, record = records.find(r => r.program === MOONIT_PROGRAM.toBase58() && r.pool === d.curve.toBase58());
      if (!record) continue;
      const amount = BigInt(d.amount.toString()), collateral = BigInt(d.collateralAmount.toString());
      const buy = "buy" in d.type;
      if (amount <= 0n || collateral <= 0n || (!buy && !("sell" in d.type))) continue;
      const list = (activity.get(record.mint) ?? []).filter(t => at - t.at < 300000);
      list.push({ at, buy, sol: Number(collateral) / 1e9, price: Number(collateral) / Number(amount) });
      activity.delete(record.mint); activity.set(record.mint, list.slice(-500));
      if (activity.size > 240) activity.delete(activity.keys().next().value!);
      observePumpTrade(record.mint, d.sender.toBase58(), slot, buy, amount);
    } catch { /* Unknown/malformed event never authorizes a buy or drops a cursor. */ }
  }
}
export function moonitActivity(mint: string, at = Date.now()) {
  const rows = (activity.get(mint) ?? []).filter(t => at - t.at < 300000);
  return { count: rows.length, buys: rows.filter(r => r.buy).length, sells: rows.filter(r => !r.buy).length,
    volumeSol: rows.reduce((v, r) => v + r.sol, 0), changePct: rows.length > 1 ? (rows.at(-1)!.price / rows[0].price - 1) * 100 : 0 };
}
