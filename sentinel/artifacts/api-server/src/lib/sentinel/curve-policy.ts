import { createHash } from "node:crypto";
import { MOONIT_PROGRAM, moonitCurveAddress } from "./moonit-policy";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import type { Candidate, Settings } from "./types";
import { SOL } from "./discovery-policy";

// Program identities and PDA seeds were checked against live mainnet accounts:
// a Pump.fun curve PDA matched Jupiter's routed AMM key, and graduated
// PumpSwap / Meteora DAMM v2 vault authorities matched these derivations.
export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DAMM_V2_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const CPMM_PROGRAM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
export const DBC_POOL_AUTHORITY = pda([Buffer.from("pool_authority")], DBC_PROGRAM);
export const DAMM_V2_POOL_AUTHORITY = pda([Buffer.from("pool_authority")], DAMM_V2_PROGRAM);
export const CPMM_AUTHORITY = pda([Buffer.from("vault_and_lp_mint_auth_seed")], CPMM_PROGRAM);
export const pumpCurveAddress = (mint: PublicKey) => pda([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM);

const PUMP_CURVE_DISCRIMINATOR = createHash("sha256").update("account:BondingCurve").digest().subarray(0, 8);
/** Real token reserves at Pump.fun curve creation (793.1M tokens, 6 decimals). */
export const PUMP_INITIAL_REAL_TOKENS = 793_100_000_000_000n;

export type PumpCurve = { realSolLamports: bigint; realTokenReserves: bigint; complete: boolean; progressPct: number };
export function decodePumpCurve(account: AccountInfo<Buffer> | null): PumpCurve | null {
  const d = account?.data;
  if (!account || !account.owner.equals(PUMP_PROGRAM) || !d || d.length < 49 ||
      !d.subarray(0, 8).equals(PUMP_CURVE_DISCRIMINATOR) || d[48]! > 1) return null;
  if (d.length >= 115 && ![PublicKey.default.toBase58(), SOL].includes(new PublicKey(d.subarray(83, 115)).toBase58())) return null;
  const realTokenReserves = d.readBigUInt64LE(24), realSolLamports = d.readBigUInt64LE(32);
  // Curve SOL is held as account lamports; reserves above them mean a corrupt/unknown layout.
  if (BigInt(account.lamports) < realSolLamports) return null;
  const sold = realTokenReserves >= PUMP_INITIAL_REAL_TOKENS ? 0n : PUMP_INITIAL_REAL_TOKENS - realTokenReserves;
  return { realSolLamports, realTokenReserves, complete: d[48] === 1, progressPct: Number(sold * 10000n / PUMP_INITIAL_REAL_TOKENS) / 100 };
}

export type VaultKind = "Pump.fun bonding curve" | "Moonit bonding curve" | "PumpSwap pool" | "Meteora DBC curve" | "Meteora DAMM v2 pool" | "Raydium CPMM vault";
export const PRE_MIGRATION_KINDS: readonly VaultKind[] = ["Pump.fun bonding curve", "Moonit bonding curve", "Meteora DBC curve"];
/**
 * Identifies token accounts controlled by a verified launchpad/AMM program.
 * Only tokens under program-controlled authority are excluded from holder
 * concentration; ordinary wallets, creators and unknown programs still count.
 */
export function classifyVault(mint: PublicKey, authority: PublicKey, authorityAccount: AccountInfo<Buffer> | null): VaultKind | null {
  if (authority.equals(pumpCurveAddress(mint)) && decodePumpCurve(authorityAccount)) return "Pump.fun bonding curve";
  if (authority.equals(moonitCurveAddress(mint)[0]) && authorityAccount?.owner.equals(MOONIT_PROGRAM)) return "Moonit bonding curve";
  if (authorityAccount?.owner.equals(PUMP_AMM_PROGRAM)) return "PumpSwap pool";
  if (authority.equals(DBC_POOL_AUTHORITY)) return "Meteora DBC curve";
  if (authority.equals(DAMM_V2_POOL_AUTHORITY)) return "Meteora DAMM v2 pool";
  if (authority.equals(CPMM_AUTHORITY)) return "Raydium CPMM vault";
  return null;
}

export type CurveStatus = { kind: VaultKind; complete: boolean; liquiditySol: number | null; progressPct: number | null };
/**
 * Untrusted provider labels only nominate a token for the curve gate; it is
 * applied for entry only after on-chain verification in the safety check.
 */
export function curveNominee(c: Candidate, s: Settings): boolean {
  if (!s.launchpadCurvesEnabled) return false;
  if (c.launchpadVerification?.phase === "graduated") return false;
  const label = `${c.launchpad ?? ""} ${c.venue ?? ""}`.toLowerCase();
  return /pump\.?fun|moonit|moonshot|met-dbc|dynamic bonding|bags/.test(label);
}
export type Holding = { amount: bigint; vault: VaultKind | null };
/** Largest non-program-controlled token account share, failing closed if every sampled account is a vault. */
export function nonVaultTopPct(supply: bigint, holdings: Holding[], sampleComplete: boolean): number {
  const holder = holdings.find(h => !h.vault);
  if (!holder) {
    if (!sampleComplete) throw new Error("Holder concentration beyond verified pool vaults is unavailable.");
    return 0;
  }
  return Number(holder.amount * 10000n / supply) / 100;
}
/** Pre-migration curve evidence, using the Pump.fun curve account when present. */
export function curveStatus(supply: bigint, holdings: Holding[], pump: PumpCurve | null): CurveStatus | null {
  if (pump) return { kind: "Pump.fun bonding curve", complete: pump.complete,
    liquiditySol: Number(pump.realSolLamports) / 1e9, progressPct: pump.progressPct };
  // DBC completion state is not decoded; an emptied DBC vault means it migrated or was drained.
  const dbc = holdings.find(h => h.vault === "Meteora DBC curve");
  if (dbc) return { kind: "Meteora DBC curve", complete: dbc.amount * 100n < supply, liquiditySol: null, progressPct: null };
  return null;
}
export function preMigration(curve: CurveStatus | null | undefined): boolean {
  return !!curve && PRE_MIGRATION_KINDS.includes(curve.kind) && !curve.complete;
}
