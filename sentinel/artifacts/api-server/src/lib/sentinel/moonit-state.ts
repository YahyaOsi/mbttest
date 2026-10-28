import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { unpackAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ConstantProductCurveV1Adapter } from "@moonit/sdk";
import { MOONIT_PROGRAM, MOONIT_CONFIG, MOONIT_DEX_FEE, MOONIT_HELIO_FEE, moonitCurveAddress, moonitSdk } from "./moonit-policy";
import { decodeSupportedMint, tokenAddress } from "./token-policy";
import { verifyLaunchpadProgram } from "./launchpad-policy";
import { TradingError } from "./store";
import { rpcGeneration } from "./rpc-config";
import type { LaunchRecord } from "./launch-events";

const origins = new Map<string, LaunchRecord>();
export function registerMoonitOrigins(records: LaunchRecord[]) {
  origins.clear();
  for (const r of records) if (r.program === MOONIT_PROGRAM.toBase58() && !r.hintOnly && r.creator && r.backendAuthority &&
    r.signature && r.slot > 0 && r.pool === moonitCurveAddress(new PublicKey(r.mint))[0].toBase58()) origins.set(r.mint, r);
}
export const moonitOrigin = (mint: string) => origins.get(mint);
export function decodeMoonitCurve(raw: AccountInfo<Buffer> | null, mint: PublicKey) {
  if (!raw?.owner.equals(MOONIT_PROGRAM)) throw new TradingError("Moonit curve program ownership unavailable.");
  const c = moonitSdk().provider.program.coder.accounts.decode("curveAccount", raw.data) as any;
  const total = BigInt(c.totalSupply.toString()), remaining = BigInt(c.curveAmount.toString());
  if (!c.mint.equals(mint) || c.decimals !== 9 || total !== 1000000000000000000n || remaining <= 0n || remaining > total ||
      !c.collateralCurrency.sol || !c.marketcapCurrency.sol || !c.curveType.constantProductV1 ||
      c.bump !== moonitCurveAddress(mint)[1]) throw new TradingError("Unsupported Moonit curve/currency/decimals/mint/PDA. Flat, anti-snipe, linear and V2 variants are disabled.");
  const sold = total - remaining;
  // Only the standard CP-V1 curve is supported; never extrapolate past migration.
  if (sold >= 799820983207404442n || BigInt(c.marketcapThreshold.toString()) !== 345000000000n)
    throw new TradingError("Moonit curve completed/migrating or nonstandard threshold.");
  return { decoded: c, total, remaining, sold, progressPct: Number(sold * 10000n / 799820983207404442n) / 100 };
}
export function decodeMoonitControls(raw: AccountInfo<Buffer> | null, creator?: PublicKey, backend?: PublicKey) {
  if (!raw?.owner.equals(MOONIT_PROGRAM)) throw new TradingError("Moonit global controls unavailable.");
  const c = moonitSdk().provider.program.coder.accounts.decode("configAccount", raw.data) as any;
  const authorities: PublicKey[] = [c.migrationAuthority, c.backendAuthority, c.configAuthority];
  if (authorities.some(k => k.equals(PublicKey.default) || (creator && k.equals(creator))) ||
      (backend && !backend.equals(c.backendAuthority)) || !c.dexFee.equals(MOONIT_DEX_FEE) ||
      !c.helioFee.equals(MOONIT_HELIO_FEE) || c.feeBps !== 100 || c.dexFeeShare > 100)
    throw new TradingError("Moonit controls/fees unsupported or creator can control migration/configuration.");
  // Official IDL migrate_funds requires BOTH protocol authorities; there is no
  // token-creator withdraw instruction. Token authorities/vault delegates are
  // separately rejected. Protocol upgrades remain a disclosed trust risk.
  return c;
}
const sourceProofs = new WeakMap<object, { generation: number; at: number }>();
export async function verifyMoonitSource(connection: Connection, at = Date.now(), identity: object = connection) {
  const sourceProof = sourceProofs.get(identity);
  if (sourceProof?.generation === rpcGeneration() && at - sourceProof.at < 300000) return;
  await verifyLaunchpadProgram(connection, MOONIT_PROGRAM);
  decodeMoonitControls(await connection.getAccountInfo(MOONIT_CONFIG));
  sourceProofs.set(identity, { generation: rpcGeneration(), at });
}
const snapshots = new WeakMap<Connection, Map<string, { at: number; generation: number; origin: string | undefined; proof: Awaited<ReturnType<typeof readMoonitState>> }>>();
/** Full proof by default. Read-only monitoring can reuse five seconds of
 * generation/origin-bound evidence; quote construction and signing stay fresh. */
export async function moonitState(connection: Connection, mint: PublicKey, requireOrigin = true, fresh = true) {
  const origin = moonitOrigin(mint.toBase58())?.signature;
  if (requireOrigin && !origin) throw new TradingError("Moonit creator/creation transaction proof missing; no entry.");
  const key = mint.toBase58(), cache = snapshots.get(connection) ?? new Map();
  snapshots.set(connection, cache);
  const previous = cache.get(key);
  if (!fresh && previous && previous.origin === origin && previous.generation === rpcGeneration() && Date.now() - previous.at < 5000) return previous.proof;
  const proof = await readMoonitState(connection, mint, requireOrigin);
  cache.delete(key); cache.set(key, { at: Date.now(), origin, generation: rpcGeneration(), proof });
  if (cache.size > 240) cache.delete(cache.keys().next().value!);
  return proof;
}
async function readMoonitState(connection: Connection, mint: PublicKey, requireOrigin = true) {
  const [pool] = moonitCurveAddress(mint), baseVault = tokenAddress(pool, mint);
  const [mintRaw, raw, vaultRaw, configRaw] = await connection.getMultipleAccountsInfo([mint, pool, baseVault, MOONIT_CONFIG]);
  const supported = decodeSupportedMint(mint, mintRaw);
  if (!supported.program.equals(TOKEN_PROGRAM_ID)) throw new TradingError("Moonit supports legacy SPL tokens only.");
  const state = decodeMoonitCurve(raw, mint), origin = moonitOrigin(mint.toBase58());
  if (requireOrigin && !origin) throw new TradingError("Moonit creator/creation transaction proof missing; no entry.");
  const creator = origin?.creator ? new PublicKey(origin.creator) : null;
  const config = decodeMoonitControls(configRaw, creator ?? undefined,
    origin?.backendAuthority ? new PublicKey(origin.backendAuthority) : undefined);
  const identity = await verifyLaunchpadProgram(connection, MOONIT_PROGRAM);
  if (!vaultRaw) throw new TradingError("Moonit token vault unavailable.");
  const base = unpackAccount(baseVault, vaultRaw, TOKEN_PROGRAM_ID);
  if (!base.isInitialized || !base.mint.equals(mint) || !base.owner.equals(pool) || base.amount !== state.remaining || base.delegate || base.closeAuthority ||
      base.isFrozen || supported.mint.supply !== state.total) throw new TradingError("Moonit vault supply/authority/delegate/lock evidence invalid.");
  const rent = await connection.getMinimumBalanceForRentExemption(raw!.data.length);
  const realSolLamports = BigInt(raw!.lamports) - BigInt(rent);
  const virtualTokens = 1073000000000000000n - state.sold;
  const virtualSol = 32190000000000000000000000000n / virtualTokens;
  const required = virtualSol - 30000000000n;
  if (realSolLamports <= 0n || realSolLamports < required || BigInt(state.decoded.migrationFee.toString()) !== BigInt(config.migrationFee.toString()))
    throw new TradingError("Moonit collateral reserves or migration fees cannot be independently verified.");
  const math = new ConstantProductCurveV1Adapter(moonitSdk().provider, mint.toBase58());
  return { pool, baseVault, base, creator, supported, identity, state, config, realSolLamports, virtualTokens, virtualSol, math,
    curve: { realQuoteReserves: realSolLamports }, at: Date.now() };
}
