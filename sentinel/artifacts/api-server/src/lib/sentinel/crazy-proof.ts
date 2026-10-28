import { checkSafety } from "./chain";
import { checkCrazySafety } from "./crazy-safety";
import { rpcGeneration } from "./rpc-config";
import type { Candidate, Settings } from "./types";
import { verifyTokenCandidate as verifyLaunchCandidate } from "./token-entry";

// Deliberately process-local and object-bound: never trust a persisted
// safetyChecked flag. Changing RPC, mint or thresholds invalidates the proof.
const proofs = new WeakMap<Candidate, {
  key: string; at: number;
  proof: Awaited<ReturnType<typeof readProof>>;
}>();
async function readProof(c: Candidate, settings: Settings) {
  await verifyLaunchCandidate(c);
  const safety = await checkSafety(c, settings, true);
  const holders = await checkCrazySafety(c, settings);
  return { ...safety, ...holders };
}
export async function crazyProof(c: Candidate, settings: Settings) {
  const key = `${rpcGeneration()}:${c.mint}:${settings.maxTopHolderPct}:${settings.crazyTop10Pct ?? 30}`;
  const old = proofs.get(c);
  if (old?.key === key && Date.now() - old.at < 15000) return old.proof;
  const proof = await readProof(c, settings);
  proofs.set(c, { key, at: Date.now(), proof });
  return proof;
}
