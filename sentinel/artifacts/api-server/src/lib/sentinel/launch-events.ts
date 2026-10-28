import { PublicKey, type ParsedTransactionWithMeta, type Connection } from "@solana/web3.js";
import { unpackMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { deriveDbcPoolAddress, createDbcProgram } from "@meteora-ag/dynamic-bonding-curve-sdk";
import bs58 from "bs58";
import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { PUMP_PROGRAM, DBC_PROGRAM, pumpCurveAddress } from "./curve-policy";
import { anchorTag } from "./launchpad-policy";
import { SOL, validMint } from "./discovery-policy";
import { MOONIT_PROGRAM, moonitCurveAddress, moonitSdk } from "./moonit-policy";
import { decodeMoonitCurve } from "./moonit-state";

export const LAUNCH_PROGRAMS = [PUMP_PROGRAM, DBC_PROGRAM, MOONIT_PROGRAM];
export type LaunchRecord = {
  mint: string; program: string; pool: string; signature: string; slot: number;
  createdAt: number | null; observedAt: number; tokenProgram: string;
  /** Program-emitted creation hint; canonical curve/mint are checked by discovery. */
  hintOnly?: boolean;
  name?: string;
  symbol?: string;
  creator?: string;
  backendAuthority?: string;
};

/** Exact pinned SDK instruction layouts, not suffixes, log text or provider labels.
 * A successful creation instruction must also have created this initialized mint
 * and its canonical program-owned pool. Unsupported ABI variants are ignored.
 */
export async function verifyCreation(
  connection: Connection, tx: ParsedTransactionWithMeta, signature: string, program: PublicKey, at: number,
): Promise<LaunchRecord | null> {
  if (!tx.meta || tx.meta.err || !LAUNCH_PROGRAMS.some(p => p.equals(program))) return null;
  const instructions = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap(i => i.instructions)];
  for (const ix of instructions) {
    if (!ix.programId.equals(program) || !("data" in ix)) continue;
    let bytes: Buffer;
    try { bytes = Buffer.from(bs58.decode(ix.data)); } catch { continue; }
    if (program.equals(MOONIT_PROGRAM)) {
      if (!bytes.subarray(0, 8).equals(anchorTag("token_mint"))) continue;
      const [creator, backend, pool, mint] = ix.accounts;
      if (!creator || !backend || !pool || !mint || !pool.equals(moonitCurveAddress(mint)[0])) continue;
      const keys = tx.transaction.message.accountKeys;
      const mintIndex = keys.findIndex(k => k.pubkey.equals(mint));
      if (mintIndex < 0 || tx.meta.preBalances[mintIndex] !== 0 || !(tx.meta.postBalances[mintIndex] > 0) ||
          !keys.some(k => k.pubkey.equals(creator) && k.signer) || !keys.some(k => k.pubkey.equals(backend) && k.signer)) continue;
      const [mintRaw, poolRaw] = await connection.getMultipleAccountsInfo([mint, pool]);
      if (!mintRaw || !poolRaw) throw new Error("Moonit creation account evidence unavailable; keep cursor.");
      try {
        if (!mintRaw.owner.equals(TOKEN_PROGRAM_ID)) continue;
        const decoded = unpackMint(mint, mintRaw);
        if (!decoded.isInitialized) continue;
        const state = decodeMoonitCurve(poolRaw, mint);
        if (state.total !== decoded.supply) continue;
        const params = (moonitSdk().provider.program.coder.instruction as any).decode(bytes)?.data?.mintParams;
        if (!params || params.decimals !== decoded.decimals) continue;
        return { mint: mint.toBase58(), pool: pool.toBase58(), program: program.toBase58(), signature, slot: tx.slot,
          creator: creator.toBase58(), backendAuthority: backend.toBase58(),
          createdAt: tx.blockTime && tx.blockTime > 0 && tx.blockTime * 1000 <= at ? tx.blockTime * 1000 : null,
          observedAt: at, tokenProgram: mintRaw.owner.toBase58(), name: String(params.name).slice(0, 80), symbol: String(params.symbol).slice(0, 20) };
      } catch { continue; }
    }
    const pump = program.equals(PUMP_PROGRAM);
    const names = pump ? ["create", "create_v2"] :
      ["initialize_virtual_pool_with_spl_token", "initialize_virtual_pool_with_token2022"];
    if (!names.some(n => bytes.subarray(0, 8).equals(anchorTag(n)))) continue;
    const mint = ix.accounts[pump ? 0 : 3], pool = ix.accounts[pump ? 2 : 5], config = ix.accounts[0];
    if (!mint || !pool || !validMint(mint.toBase58()) || mint.toBase58() === SOL) continue;
    const index = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.equals(mint));
    if (index < 0 || tx.meta.preBalances[index] !== 0 || !(tx.meta.postBalances[index] > 0)) continue;
    if (pump ? !pumpCurveAddress(mint).equals(pool) :
      !config || ix.accounts[4]?.toBase58() !== SOL || !deriveDbcPoolAddress(new PublicKey(SOL), mint, config).equals(pool)) continue;
    // One batch, below the provider's five-account limit.
    const [mintRaw, poolRaw] = await connection.getMultipleAccountsInfo([mint, pool]);
    if (!mintRaw || !poolRaw) throw new Error("Creation account evidence unavailable; retry the signature.");
    if (!poolRaw.owner.equals(program) ||
        ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(mintRaw.owner.toBase58())) continue;
    try {
      const decoded = unpackMint(mint, mintRaw, mintRaw.owner);
      if (!decoded.isInitialized) continue;
      if (pump) PUMP_SDK.decodeBondingCurve(poolRaw);
      else {
        const state = createDbcProgram(connection).coder.accounts.decode("virtualPool", poolRaw.data).poolState;
        if (!state.baseMint.equals(mint) || !state.config.equals(config)) continue;
      }
    } catch { continue; }
    return { mint: mint.toBase58(), pool: pool.toBase58(), program: program.toBase58(), signature, slot: tx.slot,
      createdAt: tx.blockTime && tx.blockTime > 0 && tx.blockTime * 1000 <= at ? tx.blockTime * 1000 : null,
      observedAt: at, tokenProgram: mintRaw.owner.toBase58() };
  }
  return null;
}
