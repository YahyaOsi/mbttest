import { TradingError } from "./store";
import { jsonFetch } from "./http";
export { jsonFetch } from "./http";
export { quote } from "./routes";
import type { Candidate, State } from "./types";
import { dexCandidate, jupiterCandidate, jupiterEvidence, discoveryMints, launchCandidate, SOL, validMint } from "./discovery-policy";
import { LaunchDiscovery, emptyLaunchDiscovery } from "./launch-discovery";
import type { LaunchRecord } from "./launch-events";
import { rpc } from "./chain";
import { rpcEndpoint, rpcGeneration, rpcIsOverride } from "./rpc-config";
import { rpcPool } from "./rpc-pool";
import { rpcTask, withRpcMission } from "./rpc-context";
import { DISCOVERY_INTERVAL_MS } from "./scan-schedule";
import { rpcWebsocketsAllowed } from "./rpc-endpoint";
import { PinnedRpcLogSubscriptions } from "./rpc-websocket";
import { PUMP_PROGRAM } from "./curve-policy";
import { verifyLaunchpadEntry, verifyLaunchCandidate } from "./launchpad-entry";
import { recentPumpCreations } from "./pump-observations";
import { pumpMarket, observedPumpCandidate } from "./pump-market";
import { knownActivePump } from "./pump-snapshot";
import { MOONIT_PROGRAM } from "./moonit-policy";
import { registerMoonitOrigins, moonitOrigin } from "./moonit-state";
import { moonitMarket } from "./moonit-market";
import { launchAllocation, orderedLaunchWork } from "./launch-allocation";
import { livePumpRecords, livePumpStatus } from "./pump-live-feed";
export { SOL, USDC, validMint } from "./discovery-policy";
let solPriceCache: { price: number; at: number } | null = null;
export async function solUsd(): Promise<number> {
  if (solPriceCache && Date.now() - solPriceCache.at < 30000) return solPriceCache.price;
  const pairs = await jsonFetch(`https://api.dexscreener.com/tokens/v1/solana/${SOL}`);
  if (!Array.isArray(pairs)) throw new TradingError("SOL/USD price is unavailable; native sizing is blocked.", 502);
  const ranked = pairs.filter((p: any) => p.chainId === "solana" && p.baseToken?.address === SOL && Number(p.priceUsd) > 0)
    .sort((a: any, b: any) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));
  const price = Number(ranked[0]?.priceUsd);
  if (!Number.isFinite(price) || price <= 0) throw new TradingError("No fresh SOL/USD reference price. No trade authorized.", 502);
  solPriceCache = { price, at: Date.now() };
  return price;
}
let lastTokenRequest = 0;
let tokenQueue: Promise<unknown> = Promise.resolve();
const tokenCache = new Map<string, { token: any; at: number }>();
let marketWarnings: string[] = [];
let launchFeed: LaunchDiscovery | null = null;
let launchRpcGeneration = -1;
let launches: LaunchRecord[] = [];
export function resetLaunchDiscoveryConnection() {
  const old = launchFeed;
  launchFeed = null;
  launchRpcGeneration = -1;
  if (old) void old.dispose().catch(() => undefined);
}
export async function refreshLaunchDiscovery(s: State, save: () => Promise<void>) {
  return withRpcMission("background", () => refreshLaunchDiscoveryBackground(s, save));
}
async function refreshLaunchDiscoveryBackground(s: State, save: () => Promise<void>) {
  s.launchDiscovery ??= emptyLaunchDiscovery();
  if (launchRpcGeneration !== rpcGeneration()) resetLaunchDiscoveryConnection();
  if (!launchFeed) {
    const connection = rpc("background");
    const endpoint = rpcPool.endpoint("background");
    const subscriptionClient = new PinnedRpcLogSubscriptions(endpoint);
    launchFeed = new LaunchDiscovery(connection, true, subscriptionClient);
    launchRpcGeneration = rpcGeneration();
  }
  await launchFeed.poll(s.launchDiscovery, save);
  launches = s.launchDiscovery.records.filter(r => [PUMP_PROGRAM.toBase58(), MOONIT_PROGRAM.toBase58()].includes(r.program));
  registerMoonitOrigins(launches);
  // Creation hints become visible candidates only after current curve checks.
  s.sourceStatus = s.launchDiscovery.status;
  await save();
}
async function jupiterTokens(path: string): Promise<any[]> {
  const job = tokenQueue.then(async () => {
    const wait = (process.env.JUPITER_API_KEY ? 1100 : 2100) - (Date.now() - lastTokenRequest);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastTokenRequest = Date.now();
    const tokens = await jsonFetch(`https://api.jup.ag/tokens/v2/${path}`, {
      headers: process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {},
    });
    if (!Array.isArray(tokens)) throw new TradingError("Invalid Jupiter token feed.", 502);
    for (const token of tokens) if (validMint(token?.id)) tokenCache.set(token.id, { token, at: Date.now() });
    for (const [mint, cached] of tokenCache) if (Date.now() - cached.at > 60000) tokenCache.delete(mint);
    return tokens;
  });
  tokenQueue = job.catch(() => undefined);
  return job;
}
/** Market evidence only. These responses never authorize origin, pool or buys.
 * Read it before native overlays so creation-feed traffic cannot starve indexed
 * activity/24h volume, especially after migration when curve logs no longer price.
 */
async function indexedMarkets(safe: string[]): Promise<Candidate[]> {
  if (!safe.length) return [];
  const indexedMints = safe;
  const missing = indexedMints.filter(m => !tokenCache.has(m) || Date.now() - tokenCache.get(m)!.at > 30000);
  marketWarnings = [];
  let available = false;
  if (missing.length) {
    for (let i = 0; i < missing.length; i += 100) {
      try { await jupiterTokens(`search?query=${missing.slice(i, i + 100).join(",")}`); available = true; }
      catch { marketWarnings.push("Jupiter metadata unavailable; no Jupiter audit clearance"); }
    }
  }
  const best = new Map<string, Candidate>();
  await Promise.all(Array.from({ length: Math.ceil(indexedMints.length / 30) }, async (_, batch) => {
    const i = batch * 30;
    try {
      const pairs = await jsonFetch(`https://api.dexscreener.com/tokens/v1/solana/${indexedMints.slice(i, i + 30).join(",")}`);
      if (!Array.isArray(pairs)) throw new Error("Invalid pool data.");
      available = true;
      for (const pair of pairs) {
        const c = dexCandidate(pair);
        if (c && safe.includes(c.mint) && (!best.has(c.mint) || best.get(c.mint)!.liquidityUsd < c.liquidityUsd)) best.set(c.mint, c);
      }
    } catch { marketWarnings.push("DEX pool data unavailable; Jupiter indexed data only where available"); }
  }));
  for (const mint of safe) {
    const cached = tokenCache.get(mint);
    if (!cached || Date.now() - cached.at > 30000) continue;
    available = true;
    const c = best.get(mint);
    if (c) Object.assign(c, jupiterEvidence(cached.token), { discoverySource: "DEX Screener + Jupiter" });
    else { const fallback = jupiterCandidate(cached.token); if (fallback) best.set(mint, fallback); }
  }
  for (const mint of safe) {
    const record = launches.find(r => r.mint === mint && Date.now() - r.observedAt < 86400000);
    if (!record) continue;
    const indexed = best.get(mint);
    if (!indexed) best.set(mint, launchCandidate(record));
    else {
      indexed.discoverySource += ` + verified ${record.program === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" ? "Pump.fun" : "DBC"} creation`;
      if (indexed.missingMarketData?.includes("age") && record.createdAt) {
        indexed.ageMinutes = (Date.now() - record.createdAt) / 60000;
        indexed.missingMarketData = indexed.missingMarketData.filter(f => f !== "age");
        indexed.marketDataStatus = indexed.missingMarketData.length ? "awaiting_market_data" : "market_data_available";
      }
    }
  }
  if (!available && !best.size) throw new TradingError("DEX Screener and Jupiter market data unavailable. No entry authorized.", 502);
  for (const c of best.values()) c.risks.push(...new Set(marketWarnings));
  return [...best.values()];
}
export async function getMarkets(mints: string[]): Promise<Candidate[]> {
  return withRpcMission(rpcTask()?.mission ?? "background", () => getMarketsAssigned(mints));
}
async function getMarketsAssigned(mints: string[]): Promise<Candidate[]> {
  const safe = [...new Set(mints.filter(validMint))];
  if (!safe.length) return [];
  let failure: unknown;
  const evidence = await indexedMarkets(safe).catch(e => { failure = e; return []; });
  const best = new Map(evidence.map(c => [c.mint, c]));
  await Promise.all(safe.filter(m => moonitOrigin(m) || knownActivePump(m) || launches.some(r => r.mint === m) ||
    /pump/i.test(String(tokenCache.get(m)?.token?.launchpad ?? ""))).map(async mint => {
    try {
      const origin = moonitOrigin(mint), reference = solPriceCache?.price ?? await solUsd().catch(() => null);
      const c = origin ? await moonitMarket(origin, reference) :
        await pumpMarket(mint, reference, launches.find(r => r.mint === mint), tokenCache.get(mint)?.token, best.get(mint));
      if (c.priceUsd > 0) best.set(mint, c);
    } catch { /* Legacy/graduate exits retain indexed route recovery. */ }
  }));
  if (!best.size && failure) throw failure;
  return [...best.values()];
}
let cache: Candidate[] = [];
let cacheAt = 0;
let discovery: Promise<Candidate[]> | null = null;
const launchCursors = { pump: 0, secondary: 0 };
let workTurn = 0;
export let marketHealth = "Not checked";
export async function discover(s?: State, save?: () => Promise<void>, cacheMs = DISCOVERY_INTERVAL_MS): Promise<Candidate[]> {
  return withRpcMission("background", () => discoverBackground(s, save, cacheMs));
}
async function discoverBackground(s?: State, save?: () => Promise<void>, cacheMs = DISCOVERY_INTERVAL_MS): Promise<Candidate[]> {
  if (s && save) await refreshLaunchDiscovery(s, save).catch(() => undefined);
  const freshLaunches = [...new Map([...livePumpRecords(), ...launches, ...recentPumpCreations()].map(r => [r.mint, r])).values()]
    .filter(r => [PUMP_PROGRAM.toBase58(), MOONIT_PROGRAM.toBase58()].includes(r.program));
  registerMoonitOrigins(freshLaunches);
  // New creation evidence invalidates the indexed-feed cache.
  if (freshLaunches.some(r => !cache.some(c => c.mint === r.mint))) cacheAt = 0;
  if (Date.now() - cacheAt < cacheMs) return structuredClone(cache);
  if (discovery) return structuredClone(await discovery);
  discovery = (async () => {
    const feeds = await Promise.allSettled([jupiterTokens("recent"), jupiterTokens("toptrending/1h"), jupiterTokens("toptraded/24h")]);
    const history: string[] = []; // Live Pump events replace archive RPC/REST pagination.
    const hints = feeds.flatMap(f => f.status === "fulfilled" ? f.value.map(t => t.id).filter(validMint) : []);
    if (feeds.every(f => f.status === "rejected") && !freshLaunches.length && !s?.discoveryUniverse?.length && !history.length)
      throw new TradingError("Discovery providers unavailable. Known-token history is retained for retry.", 502);
    const nominated = discoveryMints([freshLaunches.filter(r => r.program === PUMP_PROGRAM.toBase58()).map(r => r.mint), hints]);
    const secondaryMints = freshLaunches.filter(r => r.program === MOONIT_PROGRAM.toBase58()).map(r => r.mint);
    const cursors = s?.launchDiscovery?.workCursors ?? launchCursors;
    const allocation = launchAllocation(nominated, secondaryMints, { ...cursors });
    const turn = s?.launchDiscovery?.workTurn ?? workTurn;
    const universe = discoveryMints([orderedLaunchWork(allocation, turn), hints, history, s?.discoveryUniverse ?? [], s?.candidates.map(c => c.mint) ?? []]);
    if (s) s.discoveryUniverse = universe;
    const cursor = universe.length ? (s?.discoveryCursor ?? 0) % universe.length : 0;
    const selected = [...universe.slice(cursor), ...universe.slice(0, cursor)];
    // Retained creations may occupy the feed for 24h. Always fetch selected
    // mints' market evidence, even when no recent-token feed was needed.
    const approved: Candidate[] = [];
    let failures = 0, checked = 0;
    let checkedPump = 0, checkedMoonit = 0;
    const reference = s?.solPriceUsd ?? await solUsd().catch(() => null);
    const deadline = Date.now() + 10000;
    // 30 is the DEX API transport page, not a retained/scan-array cap.
    // Yield between pages so monitoring and order reconciliation can run.
    for (let i = 0; i < selected.length && Date.now() < deadline; i += 30) {
      const page = selected.slice(i, i + 30);
      const indexed = new Map((await getMarkets(page).catch(() => [])).map(c => [c.mint, c]));
      await Promise.all(page.map(async mint => {
        const record = freshLaunches.find(r => r.mint === mint);
        checked++;
        if (record?.program === MOONIT_PROGRAM.toBase58()) checkedMoonit++; else checkedPump++;
        try {
          const row = indexed.get(mint);
          if (row) {
            if (record && !row.launchpadVerification) row.launchpadVerification = {
              program: record.program, pool: record.pool, verifiedAt: new Date(record.observedAt).toISOString(), phase: "observed",
            };
            approved.push(row);
          }
          else if (record) approved.push(record.program === MOONIT_PROGRAM.toBase58() ? await moonitMarket(record, reference) :
            await pumpMarket(mint, reference, record, tokenCache.get(mint)?.token));
        }
        catch {
          failures++;
          // A program-emitted hint remains visible as pending, never eligible.
          if (record) {
            const c = observedPumpCandidate(record);
            if (record.program === MOONIT_PROGRAM.toBase58()) { c.launchpad = "Moonit"; c.venue = "Moonit creation — current proof pending"; }
            c.reasoning = "Current mint/curve proof unavailable or rejected. Retrying; no buy authorized.";
            c.risks.push(c.reasoning); approved.push(c);
          }
        }
      }));
    }
    if (s) s.discoveryCursor = universe.length ? (cursor + checked) % universe.length : 0;
    launchCursors.pump = nominated.length ? (cursors.pump + checkedPump) % nominated.length : 0;
    launchCursors.secondary = secondaryMints.length ? (cursors.secondary + checkedMoonit) % secondaryMints.length : 0;
    workTurn = (turn + checked) % 5;
    if (s?.launchDiscovery) { s.launchDiscovery.workTurn = workTurn; s.launchDiscovery.workCursors = { ...launchCursors }; if (save) await save(); }
    cache = approved.sort((a, b) => a.ageMinutes - b.ageMinutes || b.volume24hUsd - a.volume24hUsd);
    cacheAt = Date.now(); marketHealth = `Expanded Solana discovery: ${checked}/${universe.length} known nominations checked this cycle; remaining pages rotate without a 10-token or retained-array cap. Pump.fun archive queries disabled; live creation stream checks all received mints, but provider gaps and RPC delays can miss a five-minute entry window. Verified native curves need no legacy LP lock; ordinary Raydium SOL pools require full permanent LP protection at entry. ${failures} provider/proof failures. ${livePumpStatus()} ${s?.launchDiscovery?.status ?? ""}`;
    return cache;
  })();
  try { return structuredClone(await discovery); }
  catch (e) { marketHealth = "Discovery unavailable — entries blocked"; throw e; }
  finally { discovery = null; }
}
