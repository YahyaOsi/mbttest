import { PublicKey } from "@solana/web3.js";
import { rpc } from "./chain";
import { rpcGeneration } from "./rpc-config";
import { decodeSupportedMint } from "./token-policy";
import { decodePumpCurve, pumpCurveAddress, PUMP_PROGRAM } from "./curve-policy";
import { verifyLaunchpadProgram } from "./launchpad-policy";
import { TradingError } from "./store";

const snapshots = new Map<string, { at: number; value: Awaited<ReturnType<typeof read>> }>();
let identityAt = 0, identityGeneration = -1;
async function read(mint: string) {
  const connection = rpc(), key = new PublicKey(mint), pool = pumpCurveAddress(key);
  // Cheap discovery proof, NOT a transaction authorization. Fee schedules,
  // unsigned builds, vaults and simulations remain final-entry responsibilities.
  const [raw, mintRaw] = await connection.getMultipleAccountsInfo([pool, key]);
  const curve = decodePumpCurve(raw);
  if (!raw || !curve) throw new TradingError("Not a supported Pump.fun curve account");
  const supported = decodeSupportedMint(key, mintRaw);
  if (!identityAt || Date.now() - identityAt > 300000 || identityGeneration !== rpcGeneration()) {
    await verifyLaunchpadProgram(connection, PUMP_PROGRAM);
    identityAt = Date.now(); identityGeneration = rpcGeneration();
  }
  const creator = raw.data.length >= 81 ? new PublicKey(raw.data.subarray(49, 81)) : null;
  return { pool, curve, supported, creator, virtualTokens: raw.data.readBigUInt64LE(8),
    virtualSol: raw.data.readBigUInt64LE(16), at: Date.now() };
}
export async function pumpSnapshot(mint: string, fresh = false) {
  const key = `${rpcGeneration()}:${mint}`, old = snapshots.get(key);
  if (!fresh && old && Date.now() - old.at < 5000) return old.value;
  const value = await read(mint);
  snapshots.set(key, { at: Date.now(), value });
  while (snapshots.size > 240) snapshots.delete(snapshots.keys().next().value!);
  return value;
}
export function knownActivePump(mint: string) {
  const old = snapshots.get(`${rpcGeneration()}:${mint}`);
  return !!old && Date.now() - old.at < 60000 && !old.value.curve.complete;
}
export function knownPump(mint: string) {
  const old = snapshots.get(`${rpcGeneration()}:${mint}`);
  return !!old && Date.now() - old.at < 60000;
}
