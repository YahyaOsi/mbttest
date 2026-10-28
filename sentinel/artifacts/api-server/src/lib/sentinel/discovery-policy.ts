import { PublicKey } from "@solana/web3.js";
import type { Candidate } from "./types";
import type { LaunchRecord } from "./launch-events";

export const SOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export function validMint(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}
const number = (v: unknown, fallback = 0) => v != null && Number.isFinite(Number(v)) ? Number(v) : fallback;
const optionalNumber = (v: unknown) => v != null && Number.isFinite(Number(v)) ? Number(v) : null;
const label = (v: unknown) => typeof v === "string" && v.length ? v.slice(0, 80) : null;
const icon = (v: unknown) => typeof v === "string" && v.startsWith("https://") ? v : null;
const age = (time: number) => Number.isFinite(time) && time > 0 && time <= Date.now() ? (Date.now() - time) / 60000 : 0;
const known = (v: unknown) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0;
type Missing = NonNullable<Candidate["missingMarketData"]>[number];
function marketEvidence(values: [Missing, boolean][]) {
  const missingMarketData = values.filter(([, present]) => !present).map(([name]) => name);
  return { missingMarketData, marketDataStatus: missingMarketData.length ? "awaiting_market_data" as const : "market_data_available" as const };
}

export function launchCandidate(record: LaunchRecord): Candidate {
  const pump = record.program === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  return {
    mint: record.mint, symbol: record.mint.slice(0, 6), name: pump ? "New Pump.fun launch" : "New Meteora DBC launch",
    imageUrl: null, url: `https://solscan.io/tx/${record.signature}`, poolAddress: record.pool,
    priceUsd: 0, liquidityUsd: 0, volume24hUsd: 0, change5mPct: 0, change24hPct: 0,
    ageMinutes: record.createdAt ? age(record.createdAt) : 0, buys5m: 0, sells5m: 0,
    status: "watching", score: null, safetyChecked: false,
    reasoning: "Creation verified on-chain. Awaiting market data; no analysis or entry authorized.",
    risks: ["Missing market price, liquidity, volume and recent activity; creation is not trading clearance"],
    updatedAt: new Date(record.observedAt).toISOString(), venue: pump ? "Pump.fun" : "Meteora DBC",
    launchpad: pump ? "Pump.fun" : null, discoverySource: `${pump ? "Pump.fun" : "Meteora DBC (includes Bags)"} verified creation`,
    tokenProgram: record.tokenProgram, marketCapUsd: null, organicScore: null, flaggedSuspicious: false,
    ...marketEvidence([["price", false], ["liquidity", false], ["volume", false], ["age", !!record.createdAt], ["activity", false], ["priceChange", false]]),
  };
}

export function jupiterEvidence(token: any) {
  return {
    launchpad: label(token?.launchpad), tokenProgram: label(token?.tokenProgram),
    marketCapUsd: optionalNumber(token?.mcap), organicScore: optionalNumber(token?.organicScore),
    // Jupiter documents presence of isSus as a flag, not a guaranteed boolean.
    flaggedSuspicious: !!token?.audit && Object.hasOwn(token.audit, "isSus"),
  };
}
export function dexCandidate(pair: any): Candidate | null {
  const mint = pair?.baseToken?.address;
  const priceUsd = number(pair?.priceUsd);
  if (pair?.chainId !== "solana" || !validMint(mint) || [SOL, USDC].includes(mint) || priceUsd <= 0) return null;
  return {
    mint, symbol: String(pair.baseToken.symbol ?? "?").slice(0, 20),
    name: String(pair.baseToken.name ?? "Unknown").slice(0, 80),
    imageUrl: icon(pair.info?.imageUrl),
    url: `https://dexscreener.com/solana/${validMint(pair.pairAddress) ? pair.pairAddress : mint}`,
    priceUsd, liquidityUsd: Math.max(0, number(pair.liquidity?.usd)), volume24hUsd: Math.max(0, number(pair.volume?.h24)),
    volume5mUsd: optionalNumber(pair.volume?.m5),
    change5mPct: number(pair.priceChange?.m5), change24hPct: number(pair.priceChange?.h24),
    ageMinutes: age(Number(pair.pairCreatedAt)),
    buys5m: Math.max(0, Math.floor(number(pair.txns?.m5?.buys))), sells5m: Math.max(0, Math.floor(number(pair.txns?.m5?.sells))),
    status: "discovered", score: null, reasoning: "Live DEX Screener pool data. Not yet AI-assessed or safety-checked.",
    risks: [], updatedAt: new Date().toISOString(), safetyChecked: false,
    venue: label(pair.dexId), poolAddress: validMint(pair.pairAddress) ? pair.pairAddress : null, launchpad: null, discoverySource: "DEX Screener",
    tokenProgram: null, marketCapUsd: optionalNumber(pair.marketCap), organicScore: null, flaggedSuspicious: false,
    ...marketEvidence([["price", priceUsd > 0], ["liquidity", known(pair.liquidity?.usd)], ["volume", known(pair.volume?.h24)],
      ["age", age(Number(pair.pairCreatedAt)) > 0], ["activity", known(pair.txns?.m5?.buys) && known(pair.txns?.m5?.sells)],
      ["priceChange", knownSigned(pair.priceChange?.m5)]]),
  };
}
export function jupiterCandidate(token: any): Candidate | null {
  const mint = token?.id;
  const priceUsd = number(token?.usdPrice);
  if (!validMint(mint) || [SOL, USDC].includes(mint) || priceUsd <= 0) return null;
  const updated = Date.parse(token.updatedAt);
  return {
    mint, symbol: String(token.symbol ?? "?").slice(0, 20), name: String(token.name ?? "Unknown").slice(0, 80),
    imageUrl: icon(token.icon), url: `https://jup.ag/tokens/${mint}`,
    volume5mUsd: optionalNumber(token.stats5m?.buyVolume) != null && optionalNumber(token.stats5m?.sellVolume) != null
      ? Number(token.stats5m.buyVolume) + Number(token.stats5m.sellVolume) : null,
    priceUsd, liquidityUsd: Math.max(0, number(token.liquidity)),
    volume24hUsd: Math.max(0, number(token.stats24h?.buyVolume)) + Math.max(0, number(token.stats24h?.sellVolume)),
    change5mPct: number(token.stats5m?.priceChange), change24hPct: number(token.stats24h?.priceChange),
    ageMinutes: age(Date.parse(token.firstPool?.createdAt)),
    buys5m: Math.max(0, Math.floor(number(token.stats5m?.numBuys))), sells5m: Math.max(0, Math.floor(number(token.stats5m?.numSells))),
    status: "discovered", score: null, reasoning: "Jupiter indexed token data; an executable buy and sell route is still required.",
    risks: ["Provider launchpad labels are nominations, not on-chain identity evidence"],
    updatedAt: Number.isFinite(updated) && updated <= Date.now() ? new Date(updated).toISOString() : new Date(0).toISOString(),
    safetyChecked: false, venue: null, discoverySource: "Jupiter Tokens", ...jupiterEvidence(token),
    ...marketEvidence([["price", priceUsd > 0], ["liquidity", known(token.liquidity)],
      ["volume", known(token.stats24h?.buyVolume) && known(token.stats24h?.sellVolume)],
      ["age", age(Date.parse(token.firstPool?.createdAt)) > 0],
      ["activity", known(token.stats5m?.numBuys) && known(token.stats5m?.numSells)],
      ["priceChange", knownSigned(token.stats5m?.priceChange)]]),
  };
}
const knownSigned = (v: unknown) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

export function discoveryMints(groups: string[][], limit = Number.POSITIVE_INFINITY): string[] {
  const found = new Set<string>();
  for (let i = 0; i < Math.max(0, ...groups.map(g => g.length)); i++) {
    for (const group of groups) {
      const mint = group[i];
      if (validMint(mint) && ![SOL, USDC].includes(mint)) found.add(mint);
      if (found.size >= limit) return [...found];
    }
  }
  return [...found];
}
