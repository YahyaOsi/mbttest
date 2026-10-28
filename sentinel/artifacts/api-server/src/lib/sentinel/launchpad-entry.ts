import { PublicKey } from "@solana/web3.js";
import { pumpState } from "./launchpad-state";
import { rpc } from "./chain";
import { rpcGeneration } from "./rpc-config";
import { PUMP_PROGRAM } from "./curve-policy";
import { TradingError } from "./store";
import type { Candidate } from "./types";
import { pumpSnapshot } from "./pump-snapshot";
import { MOONIT_PROGRAM } from "./moonit-policy";
import { moonitState, moonitOrigin } from "./moonit-state";
import { graduatedPumpState } from "./pump-graduated";

export const ENTRY_LAUNCH_PROGRAMS = [PUMP_PROGRAM, MOONIT_PROGRAM];
type EntryProof = (Awaited<ReturnType<typeof pumpState>> & { phase: "active" }) | Awaited<ReturnType<typeof graduatedPumpState>>;
const recent = new Map<string, { at: number; proof: EntryProof }>();
/** Names, suffixes, cached assessments and provider labels are never authorization. */
export async function verifyLaunchpadEntry(mint: string, fresh = false) {
  if (moonitOrigin(mint)) return { ...await moonitState(rpc(), new PublicKey(mint), true, fresh), phase: "active" as const };
  const key = `${rpcGeneration()}:${mint}`, cached = recent.get(key);
  if (!fresh && cached && Date.now() - cached.at < 15000) return cached.proof;
  try {
    const snapshot = await pumpSnapshot(mint, fresh);
    const proof = snapshot.curve.complete
      ? await graduatedPumpState(rpc(), new PublicKey(mint))
      : { ...await pumpState(rpc(), new PublicKey(mint)), phase: "active" as const };
    recent.set(key, { at: Date.now(), proof });
    for (const [k, v] of recent) if (Date.now() - v.at > 30000) recent.delete(k);
    return proof;
  } catch (error) {
    recent.delete(key);
    throw new TradingError(`Launchpad-only entry blocked: ${error instanceof TradingError ? error.message : "Current on-chain Pump.fun provenance/provider verification failed."} Ordinary pools, DBC and unverified launchpads are excluded.`);
  }
}
export async function verifyLaunchCandidate(c: Candidate, fresh = false) {
  if (moonitOrigin(c.mint)) {
    const proof = await moonitState(rpc(), new PublicKey(c.mint), true, fresh);
    c.launchpad = "Moonit"; c.venue = "Verified Moonit CP-V1 bonding curve"; c.poolAddress = proof.pool.toBase58();
    c.curveProgressPct = proof.state.progressPct;
    c.launchpadVerification = { program: MOONIT_PROGRAM.toBase58(), pool: proof.pool.toBase58(), verifiedAt: new Date(proof.at).toISOString(), phase: "active" };
    return c;
  }
  const proof = await pumpSnapshot(c.mint, fresh).catch(() => {
    throw new TradingError("Launchpad-only entry blocked: current Pump.fun mint/curve authority proof unavailable or invalid.");
  });
  if (proof.curve.complete) {
    const graduated = await verifyLaunchpadEntry(c.mint, fresh);
    if (graduated.phase !== "graduated") throw new TradingError("Pump.fun phase changed during verification; retry.");
    c.launchpad = "Pump.fun"; c.venue = "Verified graduated Pump.fun — canonical PumpSwap";
    c.poolAddress = graduated.pool.toBase58(); c.curveProgressPct = undefined;
    c.launchpadVerification = { program: PUMP_PROGRAM.toBase58(), pool: graduated.pool.toBase58(), verifiedAt: new Date().toISOString(), phase: "graduated" };
    return c;
  }
  c.launchpad = "Pump.fun"; c.venue = "Verified active Pump.fun bonding curve";
  c.poolAddress = proof.pool.toBase58();
  c.curveProgressPct = proof.curve.progressPct;
  c.launchpadVerification = { program: PUMP_PROGRAM.toBase58(), pool: c.poolAddress, verifiedAt: new Date().toISOString(), phase: "active" };
  return c;
}
export function isVerifiedLaunchCandidate(c: Candidate) {
  return ENTRY_LAUNCH_PROGRAMS.some(p => p.toBase58() === c.launchpadVerification?.program);
}
