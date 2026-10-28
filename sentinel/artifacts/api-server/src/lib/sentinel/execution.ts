import { PublicKey, SystemProgram, VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import bs58 from "bs58";
import { rpc, signer, requireLive, walletAddress } from "./chain";
import { rpcPool } from "./rpc-pool";
import { event, flags, now, TradingError } from "./store";
import { SOL, jsonFetch } from "./market";
import type { Position, State } from "./types";
import { clearPendingTransactionLock, inspectMissingPending } from "./pending-expiry";
import { withRpcMission } from "./rpc-context";
import { sellableTokens, protectedTokens, updateRetention } from "./retention-policy";
import { verifyQuoteLiquidity } from "./chain";
import { verifyTokenEntry as verifyLaunchpadEntry } from "./token-entry";
import { assertLockedPoolQuote, assertLockedPoolTransaction, type LockedPoolProof } from "./locked-pool";
import { assertNativeSwap, nativeSwapDelta, solFill } from "./native-accounting";
import { TOKEN_2022_PROGRAM_ID, decodeSupportedMint, tokenAddress, allowedTokenInstruction } from "./token-policy";
import { RAYDIUM_PROGRAMS, assertQuote, assertSingleTransaction, raySwapInstruction, type ExecutionLimits } from "./route-policy";
import { rayQuote, quote } from "./routes";
import { markExitFill } from "./exit-policy";
import { walletTokenChanges } from "./transaction-policy";
import { LAUNCHPAD_PROGRAMS, curveSwapInstruction, assertAuthorizedCurveBuild, venueName } from "./launchpad-policy";
import { accountBatches } from "./launchpad-state";
import { nativeCurveQuote } from "./launchpad-routes";
import { pumpRentDelta, pumpSwapRentDelta } from "./launchpad-rent";
import { applyPriorityFee, priorityFeeEstimate } from "./priority-fees";
import { appendTip, cappedTip, sendJitoBundle, tipAccount } from "./jito";
import { livePumpBurst } from "./pump-live-feed";
import { metric } from "./telemetry";
import { assertGraduatedAuthorization, assertGraduatedTransaction, assertGraduatedSimulation } from "./graduated-route-policy";
export { impact } from "./route-policy";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PROGRAMS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111", TOKEN.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), ATA.toBase58(),
]);
function accountAmount(a: { data: Buffer } | null) {
  if (!a || a.data.length < 72) return 0n;
  return a.data.readBigUInt64LE(64);
}
export async function executeLive(
  userId: string, s: State, p: Position, q: any,
  direction: "buy" | "sell", fraction: number, reason: string,
  save: () => Promise<void>, limits: ExecutionLimits = s.settings,
) {
  requireLive(userId, s, direction === "sell");
  if (p.walletAddress !== walletAddress()) throw new TradingError("Position belongs to a different wallet. Restore its original key before any execution.", 409);
  if (s.pending) throw new TradingError("An order is awaiting reconciliation. No duplicate order will be sent.", 409);
  if (direction === "buy") {
    const f = await flags(userId);
    if (f.halted || f.emergency) throw new TradingError("Owner stop or protective liquidation blocks new entries.");
    if (s.watchlist?.[p.mint] && Date.now() >= Date.parse(s.watchlist[p.mint].expiresAt))
      throw new TradingError("15-minute watch deadline expired; no buy authorized.");
  }
  const k = signer()!;
  if ((direction === "buy" && (q.inputMint !== SOL || q.outputMint !== p.mint)) ||
      (direction === "sell" && (q.inputMint !== p.mint || q.outputMint !== SOL))) {
    throw new TradingError("Only SOL→token and token→SOL settlement is authorized.");
  }
  if (!s.solPriceUsd) throw new TradingError("Fresh SOL/USD reference missing.");
  const connection = rpc("priority");
  let dispatchExpiry: { blockhash: string; lastValidBlockHeight: number } | undefined;
  let tipLamports = 0, recipient: PublicKey | undefined;
  let simulationSlot: number | undefined, simulationRentLamports = 0, simulationUnits: number | undefined;
  const prepare = async () => {
  let graduated: Extract<Awaited<ReturnType<typeof verifyLaunchpadEntry>>, { phase: "graduated" }> | undefined;
  let locked: LockedPoolProof | undefined;
  if (direction === "buy") {
    const proof = await verifyLaunchpadEntry(p.mint, true, p.riskPoolIds?.[0]);
    if (proof.phase !== "pool" && !s.settings.launchpadCurvesEnabled) throw new TradingError("Launchpad entries are disabled in Strategy.");
    if (proof.phase === "active") {
      if (q.router !== ("math" in proof ? "moonit" : "pump"))
        throw new TradingError("Active launchpad entries require their verified native protocol route; aggregator buys are disabled.");
    } else if (proof.phase === "pool") {
      assertLockedPoolQuote(q, proof); locked = proof;
    } else {
      assertGraduatedAuthorization(q, proof, p.mint);
      graduated = proof;
    }
  }
  if (direction === "buy") await verifyQuoteLiquidity(p.mint, q);
  assertQuote(q, direction === "buy" ? SOL : p.mint, direction === "buy" ? p.mint : SOL, String(q.inAmount), limits);
  const authorizedBuy = s.settings.riskMode === "crazy" && p.authorizedBuyLamports
    ? BigInt(p.authorizedBuyLamports) : BigInt(Math.floor(s.settings.positionSizeUsd / s.solPriceUsd! * 1e9));
  if (BigInt(q.inAmount) > (direction === "buy" ? authorizedBuy : sellableTokens(p))) {
    throw new TradingError("Requested swap exceeds the authorized principal or remaining token quantity.");
  }
  if (!q.transaction || !["metis", "raydium", "pump", "dbc", "moonit"].includes(q.router) || (q.router === "metis" && !q.requestId) ||
      !Number.isFinite(q.quotedAt) || Date.now() - q.quotedAt > 30000) throw new TradingError("Expired or unsupported atomic swap route.");
  let tx = assertSingleTransaction(q.transaction, k.publicKey.toBase58());
  const curve = q.router === "pump" || q.router === "dbc" || q.router === "moonit";
  if (curve && direction === "buy" && !s.settings.launchpadCurvesEnabled) throw new TradingError("Native curve entries are disabled in Strategy.");
  if (curve) assertAuthorizedCurveBuild(q, tx);
  const tables = await Promise.all(tx.message.addressTableLookups.map(async l => {
    const t = await connection.getAddressLookupTable(l.accountKey);
    if (!t.value) throw new TradingError("Transaction address lookup table unavailable.");
    return t.value;
  }));
  const launchAgeSeconds = (p.entryTokenAgeMinutes ?? Infinity) * 60 + Math.max(0, Date.now() - Date.parse(p.openedAt)) / 1000;
  const early = direction === "buy" && s.settings.riskMode === "crazy" &&
    (p.crazyStrategy === "sniper" && launchAgeSeconds <= 60 || livePumpBurst(p.mint));
  if (s.settings.riskMode === "crazy") tx = await applyPriorityFee(tx, { addressLookupTableAccounts: tables },
    early ? s.settings.snipePriorityMultiplier ?? 2 : 1);
  tipLamports = 0; recipient = undefined;
  if (early && s.settings.jitoEnabled) {
    const amount = cappedTip(s.settings, BigInt(q.inAmount), priorityFeeEstimate(tx));
    if (amount) try {
      recipient = await tipAccount();
      tx = appendTip(tx, tables, k.publicKey, recipient, amount);
      tipLamports = amount;
    } catch {
      event(s, "execution", "Jito tip discovery unavailable before signing; preparing a normal priority transaction.", "warning", p.mint);
    }
  }
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: tables });
  if (graduated) assertGraduatedTransaction(tx, keys, q, graduated);
  let raySwaps = 0;
  let curveSwaps = 0;
  const minimumOutput = BigInt(q.outAmount) * BigInt(10000 - limits.slippageBps) / 10000n;
  for (const ix of tx.message.compiledInstructions) {
    const program = keys.get(ix.programIdIndex)?.toBase58() ?? "";
    const venueProgram = curve ? LAUNCHPAD_PROGRAMS.has(program) : q.router === "raydium" ? RAYDIUM_PROGRAMS.has(program) : program === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
    if ((!PROGRAMS.has(program) && !venueProgram) ||
        (program === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" && q.router !== "metis")) throw new TradingError("Unsupported transaction program. Refusing signature.");
    if (program === "11111111111111111111111111111111" && (ix.data.length < 4 || ![0, 2, 3, 11].includes(Buffer.from(ix.data).readUInt32LE(0)))) throw new TradingError("Unsupported System Program instruction.");
    if ([TOKEN.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(program) && !allowedTokenInstruction(ix.data[0])) {
      throw new TradingError("Token approval/authority instruction is not permitted.");
    }
    if (q.router === "raydium" && RAYDIUM_PROGRAMS.has(program) && raySwapInstruction(program, ix.data, BigInt(q.inAmount), minimumOutput)) raySwaps++;
    if (curve && LAUNCHPAD_PROGRAMS.has(program) && curveSwapInstruction(program, ix.data, direction === "buy", BigInt(q.inAmount), minimumOutput)) curveSwaps++;
  }
  if (q.router === "raydium" && raySwaps !== 1) throw new TradingError("Direct Raydium must contain one verifiable exact-input swap.");
  if (locked) assertLockedPoolTransaction(tx, keys, locked);
  if (curve && curveSwaps !== 1) throw new TradingError("Native curve must contain one verifiable exact-input swap.");
  // Authorization above binds the original unsigned message. Only its recent
  // blockhash is refreshed here; accounts/instructions remain unchanged. Fee
  // estimation and simulation below use this EXACT hash, as does dispatch.
  const expiry = await connection.getLatestBlockhash("confirmed");
  if (!Number.isSafeInteger(expiry.lastValidBlockHeight) || expiry.lastValidBlockHeight <= 0)
    throw new TradingError("Primary RPC did not provide a valid transaction expiry.");
  new PublicKey(expiry.blockhash);
  tx.message.recentBlockhash = expiry.blockhash;
  const mintKey = new PublicKey(p.mint);
  let program: PublicKey;
  try { program = decodeSupportedMint(mintKey, await connection.getAccountInfo(mintKey)).program; }
  catch { throw new TradingError("Mint program or Token-2022 extensions are unsupported. Refusing signature."); }
  const tokenAta = tokenAddress(k.publicKey, mintKey, program);
  const nativeAta = tokenAddress(k.publicKey, new PublicKey(SOL));
  const addressMap = new Map([k.publicKey, tokenAta, nativeAta].map(a => [a.toBase58(), a]));
  for (let i = 0; i < keys.length; i++) if (tx.message.isAccountWritable(i)) {
    const key = keys.get(i)!; addressMap.set(key.toBase58(), key);
  }
  const addresses = [...addressMap.values()];
  if (addresses.length > 64) throw new TradingError("Swap exceeds the supported simulation account budget.");
  const [before, estimatedFee] = await Promise.all([
    accountBatches(connection, addresses), connection.getFeeForMessage(tx.message),
  ]);
  if (estimatedFee.value === null) throw new TradingError("Network fee could not be verified. Refusing signature.");
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: false,
    ...(graduated ? { innerInstructions: true } : {}),
    accounts: { encoding: "base64", addresses: addresses.map(a => a.toBase58()) },
  });
  if (sim.value.err || !sim.value.accounts?.[0] || !before[0] || sim.value.accounts.length !== addresses.length) throw new TradingError("Transaction simulation failed or returned incomplete wallet balances.");
  if (graduated) assertGraduatedSimulation(sim.value.innerInstructions, keys, graduated);
  const after = sim.value.accounts!;
  const afterAmount = (index: number) => after[index] ? accountAmount({ data: Buffer.from(after[index]!.data[0], "base64") }) : 0n;
  const tokenDelta = afterAmount(1) - accountAmount(before[1]);
  if (direction === "sell") {
    const reserve = s.positions.filter(row => row.mode === "live" && row.walletAddress === p.walletAddress &&
      row.mint === p.mint && ["open", "retained"].includes(row.status)).reduce((sum, row) => {
        const raw = BigInt(row.rawRemaining), protectedRaw = protectedTokens(row);
        return sum + (raw < protectedRaw ? raw : protectedRaw);
      }, 0n);
    if (afterAmount(1) < reserve) throw new TradingError("Simulation would consume the permanent 1% reserve. Refresh wallet balances; no signature authorized.");
  }
  if (afterAmount(2) !== accountAmount(before[2])) throw new TradingError("Swap must settle to native SOL, not leave or consume an existing WSOL balance.");
  const routeMints = new Set<string>([SOL, p.mint, ...(q.routePlan ?? []).flatMap((r: any) =>
    [r.inputMint ?? r.swapInfo?.inputMint, r.outputMint ?? r.swapInfo?.outputMint]).filter((m: unknown): m is string => typeof m === "string")]);
  let rentDelta = walletTokenChanges(k.publicKey, p.mint, routeMints, addresses, before, after as Parameters<typeof walletTokenChanges>[5]);
  if (q.router === "pump") rentDelta += await pumpRentDelta(connection, k.publicKey, mintKey, addresses, before, after as Parameters<typeof walletTokenChanges>[5]);
  if (graduated) rentDelta += await pumpSwapRentDelta(connection, k.publicKey, mintKey, addresses, before, after as Parameters<typeof walletTokenChanges>[5]);
  if (recipient) {
    const i = addresses.findIndex(a => a.equals(recipient!));
    if (i < 0 || !after[i] || after[i]!.lamports - (before[i]?.lamports ?? 0) !== tipLamports)
      throw new TradingError("Jito tip simulation mismatch; nothing signed.");
  }
  const nativeDelta = nativeSwapDelta(before[0]!.lamports, after[0]!.lamports, estimatedFee.value + tipLamports, rentDelta);
  try { assertNativeSwap(direction, nativeDelta, tokenDelta, BigInt(q.inAmount), minimumOutput); }
  catch { throw new TradingError("Simulation changes do not match the authorized native SOL swap."); }
  if (estimatedFee.value + tipLamports + Math.max(0, rentDelta) > 5_000_000) {
    throw new TradingError("Network fees/account rent exceed the hard 0.005 SOL overhead cap, excluding the authorized swap principal.");
  }
  if (Date.now() - q.quotedAt > 30000) throw new TradingError("Quote expired during validation. Nothing signed.");
  if (direction === "buy" && after[0]!.lamports < Math.ceil(s.settings.solReserve * 1e9)) throw new TradingError("This buy would consume the protected SOL fee reserve.");
  if (direction === "sell" && after[0]!.lamports <= before[0]!.lamports) throw new TradingError("Exit would cost more native SOL in fees than it returns. Manual dust-position review required.");
  if (graduated) {
    const current = await verifyLaunchpadEntry(p.mint, true);
    if (current.phase !== "graduated") throw new TradingError("Migration provenance changed during simulation.");
    assertGraduatedAuthorization(q, current, p.mint);
  }
  dispatchExpiry = expiry;
  simulationSlot = sim.context.slot; simulationRentLamports = rentDelta; simulationUnits = sim.value.unitsConsumed;
  return tx;
  };
  let tx: VersionedTransaction | undefined;
  const original = q;
  const fallbacks = direction === "buy" ? [] : q.router === "metis" ? [rayQuote, nativeCurveQuote] : q.router === "raydium" ? [nativeCurveQuote] : [];
  let failure: unknown;
  for (let attempt = 0; attempt <= fallbacks.length; attempt++) {
    try {
      if (attempt) {
        q = await fallbacks[attempt - 1](original.inputMint, original.outputMint, String(original.inAmount), limits, k.publicKey.toBase58());
        if (direction === "buy") {
          const conservativeTokens = BigInt(q.outAmount) * BigInt(10000 - limits.slippageBps) / 10000n;
          const reverse = await quote(p.mint, SOL, conservativeTokens.toString(), limits.slippageBps, undefined, limits.maxPriceImpactPct);
          const maxLossPct = s.settings.riskMode === "crazy" ? limits.slippageBps / 100 + 3 : 5;
          if (BigInt(reverse.outAmount) * 10000n < BigInt(q.inAmount) * BigInt(Math.round((100 - maxLossPct) * 100))) {
            throw new TradingError("The fallback buy fails its own reverse-route / round-trip-cost check.");
          }
        }
      }
      tx = await prepare();
      if (attempt) event(s, "routing", `${p.symbol}: previous route failed before signing; a fresh ${venueName(q.router)} route passed the same simulation checks.`, "warning", p.mint);
      break;
    } catch (error) { failure = error; }
  }
  if (!tx || !dispatchExpiry) throw failure ?? new TradingError("Transaction expiry could not be verified; nothing signed.");
  if (direction === "buy") {
    const f = await flags(userId);
    if (f.halted || f.emergency) throw new TradingError("Owner stop or protective liquidation arrived before signing.");
  }
  if (Date.now() - q.quotedAt > 30000) throw new TradingError("Quote expired before signing. Nothing signed.");
  p.executionVenue = venueName(q.router);
  p.riskPoolIds = [...new Set([...(p.riskPoolIds ?? []), ...(q.routePoolIds ?? [])])].slice(0, 4) as string[];
  if (direction === "buy" && s.watchlist?.[p.mint] && Date.now() >= Date.parse(s.watchlist[p.mint].expiresAt))
    throw new TradingError("Watch deadline expired during simulation; no signature authorized.");
  const hasNonce = tx.message.compiledInstructions.some(instruction =>
    tx.message.staticAccountKeys[instruction.programIdIndex]?.equals(SystemProgram.programId) &&
    instruction.data.length >= 4 && Buffer.from(instruction.data).readUInt32LE(0) === 4);
  if (hasNonce) throw new TradingError("Durable-nonce swaps are unsupported; nothing signed.");
  tx.sign([k]);
  const signature = bs58.encode(tx.signatures[0]);
  s.pending = {
    signature, positionId: p.id, direction, inputMint: q.inputMint, outputMint: q.outputMint,
    inputAmount: String(q.inAmount), quotedOutput: String(q.outAmount), createdAt: now(), fraction, reason,
    solPriceUsd: s.solPriceUsd, wallet: k.publicKey.toBase58(), venue: q.router,
    recentBlockhash: tx.message.recentBlockhash, durableNonce: false,
    lastValidBlockHeight: dispatchExpiry.lastValidBlockHeight,
    tipLamports, tipAccount: recipient?.toBase58(), priorityFeeLamports: priorityFeeEstimate(tx),
    simulationSlot, simulationRentLamports, simulationUnits, dispatchSlot: simulationSlot,
  };
  p.status = "pending";
  p.txSignature = signature;
  event(s, "execution", `${p.symbol}: ${direction} signed via ${p.executionVenue}; awaiting finalized chain reconciliation.`, "warning", p.mint);
  // Persist intent and deterministic signature BEFORE network submission. A
  // crash or timeout can never authorize a second order for this account.
  metric(s, "order-dispatched", p.mint, { signature, direction, simulation: "passed", simulationSlot,
    simulationUnits, simulationRentLamports, tipLamports, priorityFeeLamports: priorityFeeEstimate(tx) });
  await save();
  try {
    if (tipLamports) {
      try {
        const bundleId = await sendJitoBundle(tx.serialize());
        s.pending!.bundleId = bundleId;
        event(s, "execution", `Jito accepted bundle ${bundleId}; tip ${tipLamports} lamports. Acceptance is not finality.`, "info", p.mint);
        await save();
      } catch {
        // SAME immutable swap+tip transaction, same signature. Never send a
        // second standalone tip or rebuild on an ambiguous bundle response.
        event(s, "execution", "Jito unavailable/uncertain; primary fallback sends identical signed bytes including the capped atomic tip.", "warning", p.mint);
        await rpcPool.broadcast(tx.serialize(), signature);
      }
    } else await rpcPool.broadcast(tx.serialize(), signature);
  } catch {
    event(s, "execution", "Submission response unknown. Worker and scanning continue; new orders wait for reconciliation of the existing signature, not resubmission.", "error", p.mint);
  }
  try { await reconcile(s); }
  catch { event(s, "execution", "Original signature remains pending; confirmation RPC unavailable. Retrying reconciliation next cycle without a replacement order.", "warning", p.mint); }
}
export function reconcile(s: State) {
  return withRpcMission("priority", () => reconcilePending(s));
}
async function reconcilePending(s: State) {
  const o = s.pending;
  if (!o) return;
  const p = s.positions.find(p => p.id === o.positionId);
  if (!p) throw new TradingError("Order position missing. Manual reconciliation required.", 409);
  const connection = rpc();
  const statuses = await connection.getSignatureStatuses([o.signature], { searchTransactionHistory: true });
  let status = statuses.value[0];
  let recoveredTransaction: VersionedTransactionResponse | undefined;
  if (!status) {
    const result = await inspectMissingPending(o, connection, statuses.context.slot);
    if (result.kind === "expired") {
      p.status = o.direction === "buy" ? "error" : "open";
      p.exitReason = "Expired transaction absent from finalized chain";
      if (o.direction === "sell") p.exitRetryReason = o.reason;
      clearPendingTransactionLock(s);
      event(s, "execution", `${p.symbol}: primary RPC finalized beyond the expiry fence; signature history and transaction lookup remain empty. Pending lock released, no fill or P&L invented.`, "warning", p.mint);
      return;
    }
    if (result.kind === "landed") {
      recoveredTransaction = result.transaction;
      status = { slot: recoveredTransaction.slot, confirmations: null,
        confirmationStatus: "finalized", err: recoveredTransaction.meta!.err };
    } else {
      s.lastError = o.lastValidBlockHeight || o.expiryFence
        ? `Transaction not found yet. Waiting for finalized blockhash expiry at height ${o.lastValidBlockHeight ?? o.expiryFence!.lastValidBlockHeight} before releasing the pending lock; scanning continues.`
        : "Unresolved transaction signature. Awaiting primary RPC expiry evidence; no duplicate order will be sent.";
      return;
    }
  }
  if (status.confirmationStatus !== "finalized") return;
  if (status.err) {
    metric(s, "order-failed", p.mint, { signature: o.signature, slot: status.slot, error: "finalized-on-chain" });
    p.status = o.direction === "buy" ? "error" : "open";
    p.exitReason = "On-chain transaction failed";
    event(s, "execution", `${p.symbol}: transaction finalized with an error. Network fees may still have been charged.`, "error", p.mint);
    if (o.direction === "sell") p.exitRetryReason = o.reason;
    clearPendingTransactionLock(s); return;
  }
  const tx = recoveredTransaction ?? await connection.getTransaction(o.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  if (!tx?.meta || tx.meta.err) return;
  const owner = o.wallet;
  if (owner !== walletAddressForReconcile() || tx.transaction.message.staticAccountKeys[0]?.toBase58() !== owner) {
    throw new TradingError("Configured signer changed or transaction payer mismatch. Manual reconciliation is required.", 409);
  }
  const tokenBalance = (balances: typeof tx.meta.preTokenBalances, mint: string) =>
    (balances ?? []).filter(b => b.owner === owner && b.mint === mint).reduce((v, b) => v + BigInt(b.uiTokenAmount.amount), 0n);
  const tokenInput = tokenBalance(tx.meta.preTokenBalances, p.mint) - tokenBalance(tx.meta.postTokenBalances, p.mint);
  const tokenOutput = -tokenInput;
  let nativeSol: number;
  try { nativeSol = solFill(o.direction, tx.meta.preBalances[0], tx.meta.postBalances[0]); }
  catch { s.lastError = "Native wallet cash movement could not be reconciled. Worker and scanner continue; new orders wait."; return; }
  if ((o.direction === "buy" && tokenOutput <= 0n) || (o.direction === "sell" && (tokenInput <= 0n || tokenInput > BigInt(p.rawRemaining)))) {
    s.lastError = "Finalized transaction balances could not be reconciled; manual review required. Worker and scanner continue; new orders wait."; return;
  }
  if (o.direction === "buy") {
    const cost = nativeSol * o.solPriceUsd;
    p.rawRemaining = tokenOutput.toString(); p.rawInitial = tokenOutput.toString(); p.quantity = Number(tokenOutput) / 10 ** p.decimals;
    p.retainedRaw = undefined; protectedTokens(p);
    p.originalCostSol = nativeSol; p.remainingCostSol = nativeSol; p.realizedPnlSol = 0;
    p.originalCostUsd = cost; p.remainingCostUsd = cost;
    p.entryPriceUsd = Number(BigInt(o.inputAmount)) / 1e9 * o.solPriceUsd / p.quantity;
    p.currentPriceUsd = p.entryPriceUsd; p.highWaterPriceUsd = p.entryPriceUsd;
    p.highWaterPriceSol = p.entryPriceUsd / o.solPriceUsd;
    s.liveCashSol -= nativeSol; s.liveCashUsd = s.liveCashSol * o.solPriceUsd; p.status = "open";
    updateRetention(p);
  } else {
    const rawBefore = BigInt(p.rawRemaining);
    const fraction = Number(tokenInput) / Number(rawBefore);
    const basis = p.remainingCostUsd * fraction;
    const proceeds = nativeSol * o.solPriceUsd;
    p.realizedPnlUsd += proceeds - basis;
    const basisSol = p.remainingCostSol * fraction;
    p.realizedPnlSol += nativeSol - basisSol; p.remainingCostSol -= basisSol;
    p.remainingCostUsd -= basis; p.rawRemaining = (rawBefore - tokenInput).toString();
    p.unrealizedPnlUsd *= (1 - fraction);
    p.quantity = Number(BigInt(p.rawRemaining)) / 10 ** p.decimals;
    s.liveCashSol += nativeSol; s.liveCashUsd = s.liveCashSol * o.solPriceUsd;
    p.stage++;
    markExitFill(p);
    p.status = BigInt(p.rawRemaining) <= 0n ? "closed" : "open";
    updateRetention(p);
    if (p.status === "closed") {
      p.closedAt = now(); p.unrealizedPnlUsd = 0;
      p.pnlPct = p.originalCostSol > 0 ? p.realizedPnlSol / p.originalCostSol * 100 : 0;
    }
    p.exitReason = o.reason;
  }
  const outputRaw = o.direction === "buy" ? tokenOutput.toString()
    : String(Math.round(nativeSol * 1e9) + tx.meta.fee + (o.tipLamports ?? 0) + (o.simulationRentLamports ?? 0));
  const output = Number(outputRaw);
  const quoted = Number(o.quotedOutput);
  metric(s, "order-finalized", p.mint, { signature: o.signature, direction: o.direction,
    positionStatus: p.status, realizedPnlSol: p.realizedPnlSol, realizedPnlUsd: p.realizedPnlUsd,
    holdTimeMs: Math.max(0, Date.now() - Date.parse(p.openedAt)),
    bundleId: o.bundleId ?? null, tipLamports: o.tipLamports ?? 0, slot: tx.slot,
    slotDelta: o.dispatchSlot != null ? tx.slot - o.dispatchSlot : null,
    signToFinalizedMs: Date.now() - Date.parse(o.createdAt), feeLamports: tx.meta.fee,
    includedAt: tx.blockTime != null ? new Date(tx.blockTime * 1000).toISOString() : null,
    finalizedObservedAt: now(),
    priorityFeeLamports: o.priorityFeeLamports ?? null,
    priorityFeeEvidence: o.priorityFeeLamports != null ? "finalized signed CU-price × CU-limit; ceiling-rounded" : "unavailable",
    rentLamports: o.simulationRentLamports ?? null, rentEvidence: "simulation estimate; native SOL accounting uses actual wallet movement",
    quotedOutput: o.quotedOutput, outputAmount: outputRaw,
    outputEvidence: o.direction === "buy" ? "finalized owner token balances" : "finalized wallet SOL + actual fee + simulation rent estimate",
    slippageBps: quoted > 0 ? (quoted - output) / quoted * 10000 : null });
  event(s, "execution", `${p.symbol}: ${o.direction} finalized and reconciled (${nativeSol.toFixed(9)} native SOL wallet movement, including fees/rent). Signature ${o.signature}.`, "success", p.mint);
  clearPendingTransactionLock(s);
}
function walletAddressForReconcile() {
  const a = signer()?.publicKey.toBase58();
  if (!a) throw new TradingError("Wallet unavailable for reconciliation.", 403);
  return a;
}
