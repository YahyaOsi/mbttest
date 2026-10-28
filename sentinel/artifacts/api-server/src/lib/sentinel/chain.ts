import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { TradingError } from "./store";
import { moonitOrigin, moonitState } from "./moonit-state";
import { lockedPoolState } from "./locked-pool";
import type { Candidate, Settings, State } from "./types";
import { ownerId, passwordConfigured } from "../owner-auth";
import { walletProblem } from "./wallet-policy";
import { isSolanaMainnet } from "./network-policy";
import { decodeSupportedMint, tokenAddress } from "./token-policy";
import { unpackAccount } from "@solana/spl-token";
import { classifyVault, curveStatus, decodePumpCurve, nonVaultTopPct, pumpCurveAddress, DBC_POOL_AUTHORITY, DBC_PROGRAM, type Holding, type VaultKind } from "./curve-policy";
import { dbcState, accountBatches } from "./launchpad-state";
import { hasDedicatedRpc, rpcConfigProblem, rpcEndpoint, rpcIsOverride } from "./rpc-config";
import { safeRpcFetch } from "./rpc-endpoint";
import { assertDbcEntryLiquidity } from "./dbc-entry-policy";
import { graduatedPumpState } from "./pump-graduated";
import { rpcPool, type RpcMission } from "./rpc-pool";
import { rpcTask } from "./rpc-context";

export function rpc(mission: RpcMission = rpcTask()?.mission ?? "priority") {
  return new Connection(rpcPool.endpoint(mission), {
    commitment: "confirmed", confirmTransactionInitialTimeout: 20000,
    fetch: (_url, init) => {
      const signal = rpcTask()?.signal;
      return rpcPool.read({ ...init, ...(signal ? { signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal } : {}) }, mission);
    },
    disableRetryOnRateLimit: true,
  });
}
export function signer(): Keypair | null {
  if (!process.env.SOLANA_TRADING_PRIVATE_KEY) return null;
  try {
    const secret = process.env.SOLANA_TRADING_PRIVATE_KEY;
    const bytes = secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret);
    if (bytes.length !== 64) return null;
    return Keypair.fromSecretKey(bytes);
  } catch { return null; }
}
export function walletAddress() { return signer()?.publicKey.toBase58() ?? null; }
export function liveBlockers(userId: string, settings?: Settings, state?: State): string[] {
  const blocks: string[] = [];
  if (process.env.SENTINEL_READ_ONLY === "true") blocks.push("This environment is in read-only verification mode. Mainnet signing is disabled.");
  if (!hasDedicatedRpc()) blocks.push(rpcConfigProblem() ?? "Connect a dedicated Solana mainnet RPC in Setup.");
  if (!process.env.JUPITER_API_KEY) blocks.push("Configure JUPITER_API_KEY for reliable production quotes and execution.");
  if (!signer()) blocks.push("Configure a separate low-balance trading wallet through SOLANA_TRADING_PRIVATE_KEY in Secrets. Never use your main wallet.");
  if (ownerId() !== userId) blocks.push("This is not the single owner's ledger.");
  if (settings && !passwordConfigured()) blocks.push("Configure the private console password in Secrets before starting.");
  if (state) { const problem = walletProblem(state, walletAddress()); if (problem) blocks.push(problem); }
  if (process.env.ENABLE_MAINNET_TRADING !== "true") blocks.push("Explicit server-side mainnet approval is off (ENABLE_MAINNET_TRADING).");
  if (process.env.SENTINEL_ALWAYS_ON_CONFIRMED !== "true") blocks.push("Publish on an always-on Reserved VM and confirm SENTINEL_ALWAYS_ON_CONFIRMED=true. Autoscale and Preview are not reliable for unattended trading.");
  if (settings?.riskMode !== "crazy" && !process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) blocks.push("AI analysis provider is unavailable.");
  if (settings && !settings.acknowledgeRisk) blocks.push("Acknowledge trading, signing-key, operating-cost and total-loss risks in Strategy.");
  return blocks;
}
export function requireLive(userId: string, state: State, isExit = false) {
  // Loss acknowledgement isn't required to rescue an existing position, but
  // server-side owner and signing gates remain mandatory.
  const b = liveBlockers(userId, isExit ? undefined : state.settings, state);
  if (b.length) throw new TradingError(`Mainnet locked: ${b.join(" ")}`, 403);
}
export async function verifyEntryLiquidity(c: Candidate) {
  const declaredDbc = /dbc|dynamic bonding/i.test(`${c.venue ?? ""} ${c.launchpad ?? ""}`);
  const connection = rpc();
  const pool = c.poolAddress ? await connection.getAccountInfo(new PublicKey(c.poolAddress)) : null;
  if (!declaredDbc && !pool?.owner.equals(DBC_PROGRAM)) return;
  const verified = await dbcState(connection, new PublicKey(c.mint), true);
  if (pool?.owner.equals(DBC_PROGRAM) && verified.pool.toBase58() !== c.poolAddress)
    throw new TradingError("DBC market pool does not match the independently verified mint pool.");
  assertDbcEntryLiquidity(verified.config);
}
/** Inspect route pool owners too: aggregator branding cannot bypass DBC rules. */
export async function verifyQuoteLiquidity(mint: string, q: { routePlan?: any[] }) {
  const pools = [...new Set<string>((q.routePlan ?? []).map(h => h.swapInfo?.ammKey ?? h.ammKey).filter(k => typeof k === "string"))];
  if (pools.length > 16) throw new TradingError("Entry route exceeds the pool-verification budget.");
  if (!pools.length) return;
  const connection = rpc(), accounts = await accountBatches(connection, pools.map(k => new PublicKey(k)));
  for (let i = 0; i < pools.length; i++) if (accounts[i]?.owner.equals(DBC_PROGRAM)) {
    const verified = await dbcState(connection, new PublicKey(mint), true);
    if (verified.pool.toBase58() !== pools[i]) throw new TradingError("DBC route mint/pool identity could not be verified.");
    assertDbcEntryLiquidity(verified.config);
  }
}
export async function checkSafety(c: Candidate, settings: Settings, forEntry = false) {
  const connection = rpc();
  const mint = new PublicKey(c.mint);
  const [account, holders] = await Promise.all([
    connection.getAccountInfo(mint),
    connection.getTokenLargestAccounts(mint),
  ]);
  let info;
  try { info = decodeSupportedMint(mint, account).mint; }
  catch (e) { throw new TradingError(e instanceof Error ? e.message : "Unsupported or unreadable mint."); }
  const supply = info.supply;
  const moonit = moonitOrigin(c.mint) ? await moonitState(connection, mint) : null;
  const locked = forEntry && c.lpVerification ? await lockedPoolState(connection, mint, c.lpVerification.pool) : null;
  if (!holders.value.length) throw new TradingError("Holder concentration information unavailable.");
  // Token-account concentration is a conservative proxy, not beneficial-owner
  // analysis. Only accounts whose authority is a verified launchpad/AMM
  // program (curve or pool vault) are excluded; unknown accounts still count.
  const sample = holders.value.slice(0, 4); // 4 + curve PDA: some RPC plans cap batched reads at 5
  const curveKey = pumpCurveAddress(mint);
  const tokenAccounts = await connection.getMultipleAccountsInfo([...sample.map(h => h.address), curveKey]);
  const authorities = sample.map((h, i) => {
    try { return unpackAccount(h.address, tokenAccounts[i], account!.owner).owner; } catch { return null; }
  });
  const known = authorities.filter((a): a is PublicKey => !!a);
  const authorityInfos = known.length ? await connection.getMultipleAccountsInfo(known) : [];
  // DBC's shared authority alone is not evidence that a token account belongs
  // to this curve. Verify the actual pool, config, PDA and both token vaults.
  const hasDbc = known.some(a => a.equals(DBC_POOL_AUTHORITY));
  const dbc = hasDbc ? await dbcState(connection, mint, true) : null;
  const pump = decodePumpCurve(tokenAccounts[sample.length] ?? null);
  const graduated = forEntry && pump?.complete ? await graduatedPumpState(connection, mint) : null;
  if (dbc && forEntry) assertDbcEntryLiquidity(dbc.config);
  const holdings: Holding[] = sample.map((h, i) => {
    const authority = authorities[i];
    let vault = authority ? classifyVault(mint, authority, authorityInfos[known.indexOf(authority)] ?? null) : null;
    if (locked && h.address.equals(locked.baseVault) && authority?.equals(locked.authority)) vault = "Raydium CPMM vault";
    if (forEntry && vault === "Raydium CPMM vault" && (!locked || !h.address.equals(locked.baseVault))) vault = null;
    if (vault === "Meteora DBC curve" && !h.address.equals(dbc!.state.baseVault)) vault = null;
    if (vault === "Pump.fun bonding curve" && !h.address.equals(tokenAddress(curveKey, mint, account!.owner))) vault = null;
    if (vault === "Moonit bonding curve" && (!moonit || !h.address.equals(moonit.baseVault))) vault = null;
    if (forEntry && vault === "PumpSwap pool" && (!graduated || !h.address.equals(graduated.baseVault))) vault = null;
    return { amount: BigInt(h.amount), vault };
  });
  let topPct: number;
  try { topPct = nonVaultTopPct(supply, holdings, holders.value.length <= sample.length); }
  catch (e) { throw new TradingError(e instanceof Error ? e.message : "Holder concentration unavailable."); }
  if (topPct > settings.maxTopHolderPct) throw new TradingError(`Largest non-pool token account holds ${topPct.toFixed(2)}% of supply, above your limit.`);
  const curve = moonit ? { kind: "Moonit bonding curve" as const, complete: false,
    liquiditySol: Number(moonit.realSolLamports) / 1e9, progressPct: moonit.state.progressPct } : dbc ? { kind: "Meteora DBC curve" as const,
    complete: !!dbc.state.isMigrated || dbc.state.quoteReserve.gte(dbc.config.migrationQuoteThreshold),
    liquiditySol: Number(dbc.state.quoteReserve.toString()) / 1e9,
    progressPct: Number(dbc.state.quoteReserve.muln(10000).div(dbc.config.migrationQuoteThreshold).toString()) / 100 }
    : curveStatus(supply, holdings, pump);
  return { decimals: info.decimals as number, tokenProgram: account!.owner.toBase58(),
    topPct, curve, vaults: [...new Set(holdings.map(h => h.vault).filter(Boolean))] as VaultKind[] };
}
export async function walletBalances() {
  const k = signer();
  if (!k) throw new TradingError("Trading wallet is not configured.", 403);
  const r = rpc("wallet");
  const [sol, genesis] = await Promise.all([
    r.getBalance(k.publicKey), r.getGenesisHash(),
  ]);
  if (!isSolanaMainnet(genesis)) throw new TradingError("RPC is not Solana mainnet-beta.", 403);
  return { sol: sol / 1e9 };
}
