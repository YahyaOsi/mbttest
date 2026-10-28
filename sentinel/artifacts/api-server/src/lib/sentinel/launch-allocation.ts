import type { LaunchRecord } from "./launch-events";
import { PUMP_PROGRAM } from "./curve-policy";
import { MOONIT_PROGRAM } from "./moonit-policy";

export function retainLaunchRecords(records: LaunchRecord[], at: number, limit = records.length) {
  const unique = [...new Map(records.map(r => [r.mint, r])).values()]
    .sort((a, b) => b.observedAt - a.observedAt);
  const pump = unique.filter(r => r.program === PUMP_PROGRAM.toBase58());
  const secondary = unique.filter(r => r.program === MOONIT_PROGRAM.toBase58());
  const cursors = { pump: 0, secondary: 0 };
  const picked = launchAllocation(pump.map(r => r.mint), secondary.map(r => r.mint), cursors, limit);
  const keep = new Set([...picked.pump, ...picked.secondary]);
  return unique.filter(r => keep.has(r.mint));
}

/** Actual bounded work targets, not a claim about market-wide token coverage. */
export function launchAllocation(pump: string[], secondary: string[], cursor: { pump: number; secondary: number }, limit = pump.length + secondary.length) {
  const take = (list: string[], n: number, key: "pump" | "secondary") => {
    const chosen = Array.from({ length: Math.min(n, list.length) }, (_, i) => list[(cursor[key] + i) % list.length]);
    cursor[key] = list.length ? (cursor[key] + chosen.length) % list.length : 0;
    return chosen;
  };
  let p = Math.min(pump.length, Math.ceil(limit * 0.8)), m = Math.min(secondary.length, limit - Math.ceil(limit * 0.8));
  let spare = limit - p - m;
  const morePump = Math.min(spare, pump.length - p); p += morePump; spare -= morePump;
  m += Math.min(spare, secondary.length - m);
  return { pump: take(pump, p, "pump"), secondary: take(secondary, m, "secondary") };
}
export function orderedLaunchWork(allocation: { pump: string[]; secondary: string[] }, turn = 0) {
  const p = [...allocation.pump], m = [...allocation.secondary], order: string[] = [];
  while (p.length || m.length) {
    const secondaryTurn = (turn + order.length) % 5 === 4;
    order.push((secondaryTurn && m.length ? m.shift() : p.length ? p.shift() : m.shift())!);
  }
  return order;
}
