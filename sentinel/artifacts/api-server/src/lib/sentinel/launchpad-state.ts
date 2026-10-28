import { PublicKey, type Connection, type AccountInfo } from "@solana/web3.js";
import { unpackAccount } from "@solana/spl-token";
import { PUMP_SDK, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, PUMP_FEE_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { DynamicBondingCurveClient, deriveDbcPoolAddress, deriveDbcTokenVaultAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PUMP_PROGRAM, DBC_PROGRAM, DBC_POOL_AUTHORITY, pumpCurveAddress, decodePumpCurve } from "./curve-policy";
import { decodeSupportedMint, tokenAddress, TOKEN_PROGRAM_ID } from "./token-policy";
import { SOL } from "./discovery-policy";
import { TradingError } from "./store";
import { verifyLaunchpadProgram } from "./launchpad-policy";

export async function accountBatches(connection: Connection, keys: PublicKey[]) {
  const result: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += 5) result.push(...await connection.getMultipleAccountsInfo(keys.slice(i, i + 5)));
  return result;
}
function vault(address: PublicKey, raw: AccountInfo<Buffer> | null, mint: PublicKey, authority: PublicKey, program: PublicKey) {
  if (!raw || !raw.owner.equals(program)) throw new TradingError("Curve vault program mismatch.");
  const v = unpackAccount(address, raw, program);
  if (!v.mint.equals(mint) || !v.owner.equals(authority) || v.delegate || v.closeAuthority || v.isFrozen) {
    throw new TradingError("Curve vault mint, authority or delegate is invalid.");
  }
  return v;
}
export async function pumpState(connection: Connection, mint: PublicKey) {
  const pool = pumpCurveAddress(mint);
  const [raw, mintRaw] = await accountBatches(connection, [pool, mint]);
  if (!raw || !decodePumpCurve(raw)) throw new TradingError("No verified Pump.fun curve.");
  const supported = decodeSupportedMint(mint, mintRaw);
  const curve = PUMP_SDK.decodeBondingCurve(raw);
  if (curve.complete || curve.isMayhemMode || curve.isCashbackCoin ||
      ![PublicKey.default.toBase58(), SOL].includes(curve.quoteMint.toBase58()) ||
      curve.realQuoteReserves.isZero() || curve.realTokenReserves.isZero()) throw new TradingError("Completed, empty, non-SOL or unsupported Pump curve mode.");
  if (BigInt(curve.realQuoteReserves.add(curve.creatorFee).add(curve.protocolFees).toString()) > BigInt(raw.lamports)) throw new TradingError("Pump reserves and accrued fees exceed native SOL holdings.");
  const baseVault = tokenAddress(pool, mint, supported.program);
  const base = vault(baseVault, await connection.getAccountInfo(baseVault), mint, pool, supported.program);
  if (base.amount < BigInt(curve.realTokenReserves.toString())) throw new TradingError("Pump real reserves exceed its verified token vault.");
  const identity = await verifyLaunchpadProgram(connection, PUMP_PROGRAM);
  // These reads decode current fee schedules locally, not a remote trade quote.
  const [g, f] = await accountBatches(connection, [GLOBAL_PDA, PUMP_FEE_CONFIG_PDA]);
  if (!g?.owner.equals(PUMP_PROGRAM) || !f?.owner.equals(PUMP_FEE_PROGRAM_ID)) throw new TradingError("Unverified Pump global/fee configuration.");
  await verifyLaunchpadProgram(connection, PUMP_FEE_PROGRAM_ID);
  const global = PUMP_SDK.decodeGlobal(g), feeConfig = PUMP_SDK.decodeFeeConfig(f);
  return { pool, curve, baseVault, base, global, feeConfig, supported, identity };
}
export async function dbcState(connection: Connection, mint: PublicKey, allowComplete = false) {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const found = await client.state.getPoolByBaseMint(mint);
  if (!found) throw new TradingError("No Meteora DBC pool for this mint.");
  const pool = found.publicKey, state = found.account.poolState;
  const [poolRaw, configRaw, mintRaw] = await accountBatches(connection, [pool, state.config, mint]);
  if (!poolRaw?.owner.equals(DBC_PROGRAM) || !configRaw?.owner.equals(DBC_PROGRAM) ||
      await client.state.isTransferHookPool(pool) || await client.state.isTransferHookConfig(state.config)) {
    throw new TradingError("Unverified or transfer-hook DBC state.");
  }
  const config = await client.state.getPoolConfig(state.config);
  if (!config || config.quoteMint.toBase58() !== SOL || !state.baseMint.equals(mint) ||
      !deriveDbcPoolAddress(config.quoteMint, mint, state.config).equals(pool) ||
      !deriveDbcTokenVaultAddress(pool, mint).equals(state.baseVault) ||
      !deriveDbcTokenVaultAddress(pool, config.quoteMint).equals(state.quoteVault) ||
      (!allowComplete && (state.isMigrated || state.quoteReserve.gte(config.migrationQuoteThreshold) ||
      state.baseReserve.isZero() || state.quoteReserve.isZero()))) throw new TradingError("Completed, empty, non-SOL or unverified DBC curve.");
  const supported = decodeSupportedMint(mint, mintRaw);
  const [a, b] = await accountBatches(connection, [state.baseVault, state.quoteVault]);
  const base = vault(state.baseVault, a, mint, DBC_POOL_AUTHORITY, supported.program);
  const quote = vault(state.quoteVault, b, config.quoteMint, DBC_POOL_AUTHORITY, TOKEN_PROGRAM_ID);
  if (base.amount < BigInt(state.baseReserve.toString()) || quote.amount < BigInt(state.quoteReserve.toString())) {
    throw new TradingError("DBC reserves exceed verified vault balances.");
  }
  const identity = await verifyLaunchpadProgram(connection, DBC_PROGRAM);
  return { client, pool, state, virtualPool: found.account, config, supported, base, quote, identity };
}
