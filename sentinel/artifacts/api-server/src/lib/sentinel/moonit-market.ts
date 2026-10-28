import { PublicKey } from "@solana/web3.js";
import { moonitState } from "./moonit-state";
import { moonitActivity } from "./moonit-observations";
import { launchCandidate } from "./discovery-policy";
import { rpc } from "./chain";
import { observePumpProgress } from "./pump-observations";
import type { LaunchRecord } from "./launch-events";
export async function moonitMarket(record: LaunchRecord, solPrice: number | null) {
  if (!record.createdAt && record.slot > 0) {
    const time = await rpc().getBlockTime(record.slot).catch(() => null);
    if (time && time * 1000 <= Date.now()) record.createdAt = time * 1000;
  }
  const p = await moonitState(rpc(), new PublicKey(record.mint), true, false);
  observePumpProgress(record.mint, p.state.progressPct, p.at);
  const c = launchCandidate(record), a = moonitActivity(record.mint);
  c.launchpad = "Moonit"; c.venue = "Moonit verified CP-V1 bonding curve";
  c.launchpadVerification = { program: record.program, pool: p.pool.toBase58(), verifiedAt: new Date(p.at).toISOString(), phase: "active" };
  c.poolAddress = p.pool.toBase58(); c.curveProgressPct = p.state.progressPct;
  c.priceUsd = solPrice ? Number(p.virtualSol) / Number(p.virtualTokens) * solPrice : 0;
  c.liquidityUsd = solPrice ? Number(p.realSolLamports) / 1e9 * solPrice : 0;
  c.ageMinutes = record.createdAt ? (Date.now() - record.createdAt) / 60000 : 0;
  c.buys5m = a.buys; c.sells5m = a.sells; c.change5mPct = a.changePct;
  c.volume5mUsd = a.volumeSol * (solPrice ?? 0); c.volume24hUsd = c.volume5mUsd;
  c.missingMarketData = [];
  if (!c.priceUsd) c.missingMarketData.push("price");
  if (!solPrice) c.missingMarketData.push("liquidity");
  if (!record.createdAt) c.missingMarketData.push("age");
  if (a.count < 2) c.missingMarketData.push("activity", "priceChange");
  c.marketDataStatus = c.missingMarketData.length ? "awaiting_market_data" : "market_data_available";
  c.updatedAt = new Date().toISOString();
  c.discoverySource = "Verified Moonit creation + native reserves + confirmed program trade logs (partial observed volume)";
  c.reasoning = c.missingMarketData.length ? `Pending ${c.missingMarketData.join(", ")}; no buy yet.` : "Moonit native evidence ready; safety/signals still required.";
  c.risks = ["Only standard CP-V1 supported. Protocol administrators can migrate/upgrade; creator cannot withdraw/freeze. Observations may be partial."];
  return c;
}
