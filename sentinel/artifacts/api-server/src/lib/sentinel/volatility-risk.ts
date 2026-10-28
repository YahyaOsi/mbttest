import type { Position } from "./types";

/** Sampled SOL returns, never USD drift. Adaptive stops may tighten, not widen
 * the snapshotted/hard stop. No change until six independently timed samples. */
export function volatilityStop(p: Position, priceSol: number, hardStop: number, at = Date.now()) {
  if (!p.exitPlan?.adaptive || !(priceSol > 0)) return hardStop;
  const samples = p.volatilitySamples ??= [];
  if (!samples.length || at - samples.at(-1)!.at >= 15000) samples.push({ at, price: priceSol });
  p.volatilitySamples = samples.filter(v => at - v.at < 10 * 60000).slice(-40);
  if (p.volatilitySamples.length < 6) return hardStop;
  const returns = p.volatilitySamples.slice(1).map((v, i) => Math.log(v.price / p.volatilitySamples![i].price));
  const mean = returns.reduce((n, v) => n + v, 0) / returns.length;
  const sigma = Math.sqrt(returns.reduce((n, v) => n + (v - mean) ** 2, 0) / returns.length);
  return Math.min(hardStop, Math.max(8, sigma * 100 * 2.5));
}
