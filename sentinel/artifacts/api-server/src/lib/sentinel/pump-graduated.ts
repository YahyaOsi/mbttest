import { PublicKey, type Connection } from "@solana/web3.js";
import { unpackAccount, unpackMint, TOKEN_2022_PROGRAM_ID, getExtensionTypes, ExtensionType } from "@solana/spl-token";
import { canonicalPumpPoolPda, pumpPoolAuthorityPda, PUMP_SDK } from "@pump-fun/pump-sdk";
import { createHash } from "node:crypto";
import { PUMP_PROGRAM, PUMP_AMM_PROGRAM, pumpCurveAddress, decodePumpCurve } from "./curve-policy";
import { accountBatches } from "./launchpad-state";
import { decodeSupportedMint, tokenAddress, TOKEN_PROGRAM_ID } from "./token-policy";
import { verifyLaunchpadProgram } from "./launchpad-policy";
import { SOL } from "./discovery-policy";
import { TradingError } from "./store";

const tag = createHash("sha256").update("account:Pool").digest().subarray(0, 8);
const pda = (seed: string, key: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), key.toBuffer()], PUMP_AMM_PROGRAM)[0];

/** Official migration creates index=0 with Pump's pool-authority PDA and burns
 * the LP tokens. Pool.lp_supply is NOT burn evidence; the actual mint is.
 * https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md
 * Deliberately no provider-nominated or historical Raydium pool authorization.
 */
export async function graduatedPumpState(connection: Connection, mint: PublicKey) {
  const curveKey = pumpCurveAddress(mint), pool = canonicalPumpPoolPda(mint);
  const [curveRaw, mintRaw, raw] = await accountBatches(connection, [curveKey, mint, pool]);
  const simple = decodePumpCurve(curveRaw);
  if (!curveRaw || !simple?.complete || simple.realTokenReserves !== 0n)
    throw new TradingError("Graduated entry: completed official Pump.fun origin is not proven.");
  const curve = PUMP_SDK.decodeBondingCurve(curveRaw);
  if (curve.isMayhemMode || curve.isCashbackCoin || ![PublicKey.default.toBase58(), SOL].includes(curve.quoteMint.toBase58()))
    throw new TradingError("Graduated entry: unsupported Pump.fun migration mode.");
  let supported: ReturnType<typeof decodeSupportedMint>;
  try { supported = decodeSupportedMint(mint, mintRaw); }
  catch { throw new TradingError("Graduated entry: token mint/freeze authority, supply or extension checks failed."); }
  if (!raw) throw new TradingError("Pump.fun migration pending: canonical PumpSwap pool is unavailable. Legacy Raydium and other pools are unsupported.");
  const d = raw.data;
  if (!raw.owner.equals(PUMP_AMM_PROGRAM) || d.length < 211 || !d.subarray(0, 8).equals(tag) ||
      d.readUInt16LE(9) !== 0 || !new PublicKey(d.subarray(11, 43)).equals(pumpPoolAuthorityPda(mint)) ||
      !new PublicKey(d.subarray(43, 75)).equals(mint) || new PublicKey(d.subarray(75, 107)).toBase58() !== SOL ||
      (d.length > 243 && d[243] !== 0) || (d.length > 244 && d[244] !== 0) ||
      (d.length >= 261 && d.subarray(245, 261).some(v => v !== 0)) ||
      (d.length >= 270 && d[269] !== 0))
    throw new TradingError("Graduated entry: unsupported/noncanonical PumpSwap state or controls.");
  const lpMint = pda("pool_lp_mint", pool);
  const baseVault = tokenAddress(pool, mint, supported.program), quoteVault = tokenAddress(pool, new PublicKey(SOL));
  if (!new PublicKey(d.subarray(107, 139)).equals(lpMint) ||
      !new PublicKey(d.subarray(139, 171)).equals(baseVault) ||
      !new PublicKey(d.subarray(171, 203)).equals(quoteVault))
    throw new TradingError("Graduated entry: canonical LP mint/vault derivation mismatch.");
  const global = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMP_AMM_PROGRAM)[0];
  const [a, b, lpRaw, g] = await accountBatches(connection, [baseVault, quoteVault, lpMint, global]);
  const readVault = (address: PublicKey, info: typeof a, tokenMint: PublicKey, program: PublicKey) => {
    if (!info?.owner.equals(program)) throw new TradingError("Graduated pool vault token program mismatch.");
    const v = unpackAccount(address, info, program);
    if (!v.mint.equals(tokenMint) || !v.owner.equals(pool) || v.delegate || v.closeAuthority || v.isFrozen || !v.isInitialized || v.amount <= 0n)
      throw new TradingError("Graduated pool vault is empty, frozen or externally controlled.");
    return v;
  };
  const base = readVault(baseVault, a, mint, supported.program);
  const quote = readVault(quoteVault, b, new PublicKey(SOL), TOKEN_PROGRAM_ID);
  if (!quote.isNative || quote.rentExemptReserve === null ||
      BigInt(b!.lamports) < quote.amount + quote.rentExemptReserve)
    throw new TradingError("Graduated quote vault WSOL reserves are not backed by real lamports.");
  // PumpSwap LP mints use Token-2022, with only MetadataPointer/TokenMetadata.
  // The standard mint decoder also rejects freeze/transfer-altering extensions,
  // but LP mint authority is intentionally the pool PDA, not revoked.
  if (!lpRaw || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(lpRaw.owner.toBase58()))
    throw new TradingError("Graduated LP mint program unsupported.");
  const lp = unpackMint(lpMint, lpRaw, lpRaw.owner);
  if (getExtensionTypes(lp.tlvData).some(t => ![ExtensionType.MetadataPointer, ExtensionType.TokenMetadata].includes(t)))
    throw new TradingError("Graduated LP mint extension layout unsupported.");
  if (lp.supply !== 0n || lp.freezeAuthority || !lp.mintAuthority?.equals(pool) || !lp.isInitialized)
    throw new TradingError("Graduated LP supply is removable, freezeable or not controlled by the canonical pool.");
  const globalTag = createHash("sha256").update("account:GlobalConfig").digest().subarray(0, 8);
  if (!g?.owner.equals(PUMP_AMM_PROGRAM) || g.data.length < 57 || !g.data.subarray(0, 8).equals(globalTag) ||
      (g.data[56]! & 24) !== 0)
    throw new TradingError("PumpSwap provider/state unavailable or buys/sells disabled by protocol.");
  await verifyLaunchpadProgram(connection, PUMP_PROGRAM);
  await verifyLaunchpadProgram(connection, PUMP_AMM_PROGRAM);
  return { phase: "graduated" as const, pool, curve, supported, baseVault, quoteVault, base, quote, lpMint, at: Date.now() };
}
