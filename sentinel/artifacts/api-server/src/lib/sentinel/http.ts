import { TradingError } from "./store";

export async function jsonFetch(url: string, options?: RequestInit): Promise<any> {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new TradingError(`Market provider returned HTTP ${r.status}. No trade authorized.`, 502);
  return r.json();
}
