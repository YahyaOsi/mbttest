import { createHash } from "node:crypto";
import { PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { unpackAccount, unpackMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CPMM_PROGRAM, CPMM_AUTHORITY } from "./curve-policy";
import { SOL } from "./discovery-policy";
import { decodeSupportedMint } from "./token-policy";
import { verifyLaunchpadProgram } from "./launchpad-policy";
import { jsonFetch } from "./http";
import { TradingError } from "./store";

export const AMM_V4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const DEAD = new Set(["1nc1nerator11111111111111111111111111111111", PublicKey.default.toBase58()]);
const hints = new Map<string, string>();
export function rememberPool(mint: string, pool: string) { hints.set(mint, pool); }
/** Published Raydium packed PoolState and SDK liquidityStateV4Layout.
 * Provider lock badges are never evidence. Only burns and permanent sink
 * custody of ALL outstanding LP are supported; arbitrary lockers fail closed. */
export async function lockedPoolState(connection: Connection, mint: PublicKey, poolHint?: string) {
  let address = poolHint ?? hints.get(mint.toBase58());
  if (!address) {
    const pairs = await jsonFetch(`https://api.dexscreener.com/tokens/v1/solana/${mint.toBase58()}`);
    if (!Array.isArray(pairs)) throw new TradingError("Pool discovery unavailable.");
    address = pairs.filter(p => p.chainId === "solana" && [p.baseToken?.address, p.quoteToken?.address].includes(mint.toBase58()) &&
      [p.baseToken?.address, p.quoteToken?.address].includes(SOL)).sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0]?.pairAddress;
  }
  if (!address) throw new TradingError("No supported SOL pool with provable permanent LP protection found.");
  const pool = new PublicKey(address), raw = await connection.getAccountInfo(pool);
  if (!raw) throw new TradingError("Pool account unavailable.");
  const d = raw.data, cp = raw.owner.equals(CPMM_PROGRAM);
  if (!cp && !raw.owner.equals(AMM_V4)) throw new TradingError("Unsupported LP-lock protocol. A website lock badge cannot authorize a buy.");
  if ((cp && (d.length < 389 || !d.subarray(0, 8).equals(createHash("sha256").update("account:PoolState").digest().subarray(0, 8)) || (d[329] & 4))) ||
      (!cp && (d.length !== 752 || ![1n, 6n].includes(d.readBigUInt64LE(0))))) throw new TradingError("Unsupported or non-trading Raydium pool state.");
  const key = (offset: number) => new PublicKey(d.subarray(offset, offset + 32));
  const mint0 = key(cp ? 168 : 400), mint1 = key(cp ? 200 : 432);
  if (![mint0, mint1].some(k => k.equals(mint)) || ![mint0, mint1].some(k => k.toBase58() === SOL))
    throw new TradingError("Pool does not contain the exact token and native SOL.");
  const first = mint0.equals(mint), vault0 = key(cp ? 72 : 336), vault1 = key(cp ? 104 : 368), lpMint = key(cp ? 136 : 464);
  const authority = cp ? CPMM_AUTHORITY : PublicKey.findProgramAddressSync([Buffer.from("amm authority")], AMM_V4)[0];
  if ((cp && d[328] !== PublicKey.findProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed")], CPMM_PROGRAM)[1]) ||
      (!cp && d.readBigUInt64LE(8) !== BigInt(PublicKey.findProgramAddressSync([Buffer.from("amm authority")], AMM_V4)[1])))
    throw new TradingError("Pool authority bump mismatch.");
  const [baseRaw, quoteRaw, lpRaw, mintRaw] = await connection.getMultipleAccountsInfo([first ? vault0 : vault1, first ? vault1 : vault0, lpMint, mint]);
  const supported = decodeSupportedMint(mint, mintRaw);
  if (!lpRaw || !lpRaw.owner.equals(TOKEN_PROGRAM_ID)) throw new TradingError("Unsupported LP mint.");
  const lp = unpackMint(lpMint, lpRaw, TOKEN_PROGRAM_ID);
  if (!lp.isInitialized || lp.freezeAuthority || !lp.mintAuthority?.equals(authority)) throw new TradingError("LP mint authorities are not controlled exclusively by the verified pool.");
  const baseVault = first ? vault0 : vault1, quoteVault = first ? vault1 : vault0;
  const base = unpackAccount(baseVault, baseRaw, supported.program), quote = unpackAccount(quoteVault, quoteRaw, TOKEN_PROGRAM_ID);
  for (const account of [base, quote]) if (!account.owner.equals(authority) || account.isFrozen || account.delegate || account.closeAuthority || account.amount <= 0n)
    throw new TradingError("Pool vault is empty, delegated, frozen, closeable or has the wrong authority.");
  if (!base.mint.equals(mint) || quote.mint.toBase58() !== SOL) throw new TradingError("Pool vault mint mismatch.");
  const total = d.readBigUInt64LE(cp ? 333 : 720);
  if (total <= 0n || lp.supply > total) throw new TradingError("LP accounting changed or is unsupported.");
  let inaccessible = total - lp.supply;
  if (lp.supply > 0n) {
    const holders = (await connection.getTokenLargestAccounts(lpMint)).value;
    for (let i = 0; i < holders.length; i += 5) {
      const batch = holders.slice(i, i + 5), accounts = await connection.getMultipleAccountsInfo(batch.map(h => h.address));
      for (let j = 0; j < accounts.length; j++) {
        const a = unpackAccount(batch[j].address, accounts[j], TOKEN_PROGRAM_ID);
        if (!a.mint.equals(lpMint)) throw new TradingError("LP custody mint mismatch.");
        if (DEAD.has(a.owner.toBase58()) && !a.delegate && !a.closeAuthority && !a.isFrozen) inaccessible += a.amount;
      }
    }
  }
  if (inaccessible !== total) throw new TradingError("LP is not fully burned or permanently inaccessible. Partial burns, expiring/unknown lockers and removable LP are blocked.");
  const identity = await verifyLaunchpadProgram(connection, raw.owner);
  const openTime = Number(d.readBigUInt64LE(cp ? 373 : 224));
  if (!Number.isSafeInteger(openTime) || openTime <= 0 || openTime > Date.now() / 1000) throw new TradingError("Verified pool opening time unavailable.");
  hints.set(mint.toBase58(), address);
  return { phase: "pool" as const, pool, program: raw.owner, authority, vault0, vault1, baseVault, quoteVault, base, quote, supported, openTime, identity };
}
export type LockedPoolProof = Awaited<ReturnType<typeof lockedPoolState>>;
export function assertLockedPoolQuote(q: any, proof: LockedPoolProof) {
  const pools = (q.routePlan ?? []).map((r: any) => r.swapInfo?.ammKey ?? r.ammKey ?? r.poolId);
  if (q.router !== "raydium" || pools.length !== 1 || pools[0] !== proof.pool.toBase58())
    throw new TradingError("LP-protected buys require a single direct route through the independently verified pool.");
}
export function assertLockedPoolTransaction(tx: VersionedTransaction, keys: ReturnType<VersionedTransaction["message"]["getAccountKeys"]>, proof: LockedPoolProof) {
  let swaps = 0;
  for (const ix of tx.message.compiledInstructions) {
    const program = keys.get(ix.programIdIndex)!;
    if (program.equals(proof.program)) {
      swaps++;
      const poolIndex = proof.program.equals(CPMM_PROGRAM) ? 3 : 1;
      const cp = proof.program.equals(CPMM_PROGRAM);
      if (!keys.get(ix.accountKeyIndexes[poolIndex])?.equals(proof.pool) ||
          !keys.get(ix.accountKeyIndexes[cp ? 6 : 5])?.equals(cp ? proof.quoteVault : proof.vault0) ||
          !keys.get(ix.accountKeyIndexes[cp ? 7 : 6])?.equals(cp ? proof.baseVault : proof.vault1))
        throw new TradingError("Encoded swap pool/vaults do not match the verified LP protection.");
    } else if (!["11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", TOKEN_PROGRAM_ID.toBase58(),
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"].includes(program.toBase58()))
      throw new TradingError("LP-protected entry contains an unsupported program or opaque router.");
  }
  if (swaps !== 1) throw new TradingError("LP-protected entry must contain exactly one verified direct swap.");
}
