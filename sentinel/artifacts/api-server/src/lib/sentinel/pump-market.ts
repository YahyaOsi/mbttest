import type { Candidate } from "./types";
import type { LaunchRecord } from "./launch-events";
import { launchCandidate, jupiterCandidate } from "./discovery-policy";
import { pumpSnapshot } from "./pump-snapshot";
import { pumpActivity } from "./pump-observations";
import { livePumpHint, livePumpActivity, livePumpRecord } from "./pump-live-feed";
import { PUMP_PROGRAM, pumpCurveAddress } from "./curve-policy";
import { PublicKey } from "@solana/web3.js";
import { graduatedPumpState } from "./pump-graduated";
import { rpc } from "./chain";
import { TradingError } from "./store";
import { refreshRecentPumpActivity } from "./pump-activity-fallback";

export function observedPumpCandidate(r: LaunchRecord): Candidate {
  const c = launchCandidate(r);
  if (r.name) c.name = r.name;
  if (r.symbol) c.symbol = r.symbol;
  c.launchpad = "Pump.fun"; c.venue = "Pump.fun creation hint — awaiting current proof";
  c.launchpadVerification = { program: r.program, pool: r.pool, verifiedAt: new Date(r.observedAt).toISOString(), phase: "observed" };
  return c;
}
/** Curve prices/reserves and confirmed trade observations do not depend on DEX
 * indexing. Missing observations stay explicit; zeroes are never invented buys. */
export async function pumpMarket(mint: string, solPrice: number | null, record?: LaunchRecord, metadata?: any, market?: Candidate): Promise<Candidate> {
  const proof = await pumpSnapshot(mint);
  const live = livePumpHint(mint);
  const r = record ?? (live ? livePumpRecord(live) : undefined) ?? { mint, pool: pumpCurveAddress(new PublicKey(mint)).toBase58(), program: PUMP_PROGRAM.toBase58(),
    observedAt: Date.now(), createdAt: null, signature: "", slot: 0, tokenProgram: proof.supported.program.toBase58() };
  if (!r.createdAt && r.slot > 0) {
    // A confirmed RPC block timestamp is age evidence; receipt time is not.
    const { rpc } = await import("./chain");
    const time = await rpc().getBlockTime(r.slot).catch(() => null);
    if (time && time * 1000 <= Date.now()) r.createdAt = time * 1000;
  }
  const fresh = (at: string) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.now() && Date.now() - Date.parse(at) < 30000;
  const jupiter = metadata && fresh(metadata.updatedAt) ? jupiterCandidate(metadata) : null;
  const indexed = market && market.mint === mint && fresh(market.updatedAt) ? structuredClone(market) : jupiter;
  const c = indexed ?? observedPumpCandidate(r);
  // A provider's missing fields may be supplied by the other current indexer.
  // Copy market fields only; no provider phase/pool/identity can grant access.
  if (indexed && jupiter) {
    const fields = [["volume", ["volume24hUsd"]], ["age", ["ageMinutes"]], ["activity", ["buys5m", "sells5m"]],
      ["priceChange", ["change5mPct", "change24hPct"]]] as const;
    const missing = new Set(c.missingMarketData ?? []);
    for (const [kind, names] of fields) {
      if (missing.has(kind) && !jupiter.missingMarketData?.includes(kind)) {
        for (const name of names) c[name] = jupiter[name];
        missing.delete(kind);
      }
    }
    c.missingMarketData = [...missing];
  }
  if (r.createdAt && c.missingMarketData?.includes("age")) {
    c.ageMinutes = (Date.now() - r.createdAt) / 60000;
    c.missingMarketData = c.missingMarketData.filter(f => f !== "age");
  }
  c.launchpadVerification = { program: r.program, pool: proof.pool.toBase58(), verifiedAt: new Date(proof.at).toISOString(),
    phase: proof.curve.complete ? "graduated" : "active" };
  c.launchpad = "Pump.fun"; c.poolAddress = proof.pool.toBase58();
  c.curveProgressPct = proof.curve.progressPct;
  if (proof.curve.complete) {
    c.curveProgressPct = undefined;
    try {
      const pool = await graduatedPumpState(rpc(), new PublicKey(mint));
      c.poolAddress = pool.pool.toBase58();
      c.launchpadVerification.pool = c.poolAddress;
      c.launchpadVerification.verifiedAt = new Date(pool.at).toISOString();
      c.venue = "Pump.fun graduated — canonical PumpSwap";
      c.priceUsd = solPrice ? Number(pool.quote.amount) / 1e9 / (Number(pool.base.amount) / 10 ** proof.supported.mint.decimals) * solPrice : 0;
      // Real quote-side reserves, not virtual curve SOL or provider TVL.
      c.liquidityUsd = solPrice ? Number(pool.quote.amount) / 1e9 * solPrice : 0;
      const missing = new Set(c.missingMarketData ?? []);
      if (c.priceUsd) missing.delete("price"); else missing.add("price");
      if (c.liquidityUsd) missing.delete("liquidity"); else missing.add("liquidity");
      c.missingMarketData = [...missing];
      c.marketDataStatus = missing.size ? "awaiting_market_data" : "market_data_available";
      c.discoverySource = "Official Pump.fun origin + canonical PumpSwap vault/LP proof; indexed post-migration activity";
      c.reasoning = "Canonical graduated pool verified. Entries require fresh single-hop Jupiter build, encoded-route checks and simulation; active-curve progress does not apply.";
      c.risks = ["Protocol programs are upgradeable and protocol admins can disable swaps; burned LP does not eliminate protocol or market risk."];
      c.updatedAt = new Date().toISOString();
    } catch (e) {
      c.reasoning = e instanceof TradingError ? e.message : "Graduated pool proof unavailable from RPC provider; no buy authorized.";
      c.risks = [c.reasoning]; c.status = "watching";
      c.missingMarketData = [...new Set([...(c.missingMarketData ?? []), "liquidity" as const])];
    }
    return c;
  }
  if (pumpActivity(mint).count < 1 && (!live || livePumpActivity(mint).count < 1) &&
      (!indexed || indexed.missingMarketData?.includes("activity")))
    void refreshRecentPumpActivity(mint);
  const rpcActivity = pumpActivity(mint);
  const providerActivity = live ? livePumpActivity(mint) : null;
  // A third-party market signal may nominate an entry, but never substitutes
  // for current canonical curve/mint/creator/holder proof on the primary RPC.
  const activity = rpcActivity.count >= 1 || !providerActivity || providerActivity.count < 1
    ? rpcActivity : providerActivity;
  const nativePrice = proof.virtualTokens > 0n
    ? Number(proof.virtualSol) / 1e9 / (Number(proof.virtualTokens) / 10 ** proof.supported.mint.decimals) : 0;
  c.priceUsd = solPrice && nativePrice > 0 ? nativePrice * solPrice : 0;
  c.liquidityUsd = solPrice ? Number(proof.curve.realSolLamports) / 1e9 * solPrice : 0;
  const missing: NonNullable<Candidate["missingMarketData"]> = [];
  if (!c.priceUsd) missing.push("price");
  if (!solPrice) missing.push("liquidity");
  if (r.createdAt) c.ageMinutes = (Date.now() - r.createdAt) / 60000;
  else if (live && r.signature === live.signature && r.observedAt === live.observedAt) {
    // Observation age is deliberately labelled separately from independently
    // verified mint birth; never claim the provider's notice proves creation.
    c.ageMinutes = Math.max(0.001, (Date.now() - live.observedAt) / 60000);
  }
  if (!Number.isFinite(c.ageMinutes) || c.ageMinutes <= 0) missing.push("age");
  if (activity.count >= 1) {
    c.buys5m = activity.buys; c.sells5m = activity.sells; c.change5mPct = activity.changePct;
    c.volume5mUsd = activity.volumeSol * (solPrice ?? 0);
    c.volume24hUsd = Math.max(c.volume24hUsd, c.volume5mUsd);
  } else {
    if (!indexed || indexed.missingMarketData?.includes("activity")) missing.push("activity");
    if (!indexed || indexed.missingMarketData?.includes("priceChange")) missing.push("priceChange");
  }
  c.missingMarketData = missing;
  c.marketDataStatus = missing.length ? "awaiting_market_data" : "market_data_available";
  c.venue = "Pump.fun active bonding curve";
  c.tokenProgram = proof.supported.program.toBase58();
  c.discoverySource = activity === providerActivity
    ? "PumpDev third-party live trades (unverified signal) + current Pump.fun canonical on-chain reserves; age is time since receipt, NOT independently verified creation time"
    : live && !r.createdAt
      ? "PumpDev third-party creation notice + current Pump.fun canonical on-chain reserves; age is time since receipt, NOT independently verified creation time"
      : "Pump.fun on-chain reserves + confirmed program logs; observed volume is a lower bound, not complete 24h coverage";
  c.reasoning = missing.length ? `Waiting for ${missing.join(", ")}; not awaiting DEX listing or LP locks.` : "Live bonding-curve evidence; safety and entry signals still required.";
  c.risks = ["Observation windows may be partial. No DEX LP-lock requirement on an active curve."];
  c.updatedAt = new Date().toISOString();
  return c;
}
