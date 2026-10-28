import { PublicKey } from "@solana/web3.js";
import { rpc } from "./chain";
import { verifyLaunchCandidate, verifyLaunchpadEntry } from "./launchpad-entry";
import { lockedPoolState } from "./locked-pool";
import type { Candidate } from "./types";
import { TradingError } from "./store";

export async function verifyTokenEntry(mint: string, fresh = false, pool?: string) {
  try { return await verifyLaunchpadEntry(mint, fresh); }
  catch {
    try { return await lockedPoolState(rpc(), new PublicKey(mint), pool); }
    catch (e) { throw new TradingError(`Entry blocked: ${e instanceof TradingError ? e.message : "LP pool/provider verification unavailable."}`); }
  }
}
export async function verifyTokenCandidate(c: Candidate, fresh = false) {
  try { const verified = await verifyLaunchCandidate(c, fresh); verified.lpVerification = undefined; return verified; }
  catch {
    const proof = await lockedPoolState(rpc(), new PublicKey(c.mint), c.poolAddress ?? undefined);
    c.launchpadVerification = undefined; c.curveProgressPct = undefined;
    c.poolAddress = proof.pool.toBase58(); c.venue = "Raydium — fully burned/permanently inaccessible LP";
    c.ageMinutes = (Date.now() / 1000 - proof.openTime) / 60;
    c.lpVerification = { pool: proof.pool.toBase58(), program: proof.program.toBase58(), protectedPct: 100, verifiedAt: new Date().toISOString() };
    return c;
  }
}
