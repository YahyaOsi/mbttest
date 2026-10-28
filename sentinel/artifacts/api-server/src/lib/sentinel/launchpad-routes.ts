import BN from "bn.js";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { PUMP_SDK, getBuyV3TokenAmountFromQuoteAmount, getSellSolAmountFromTokenAmount } from "@pump-fun/pump-sdk";
import { SOL } from "./discovery-policy";
import { PUMP_PROGRAM, DBC_PROGRAM } from "./curve-policy";
import { rpc } from "./chain";
import { tokenAddress } from "./token-policy";
import { assertQuote, assertSingleTransaction, type ExecutionLimits } from "./route-policy";
import { curveAmounts, curveSwapInstruction, authorizeCurveBuild, venueName } from "./launchpad-policy";
import { pumpState, dbcState } from "./launchpad-state";
import { assertDbcEntryLiquidity } from "./dbc-entry-policy";
import { TradingError } from "./store";
import { isSolanaMainnet } from "./network-policy";
import { MOONIT_PROGRAM, moonitCurveAddress } from "./moonit-policy";

const bn = (n: bigint) => new BN(n.toString());
export async function buildCurveTransaction(connection: Connection, user: PublicKey, instructions: TransactionInstruction[],
  program: PublicKey, buy: boolean, input: bigint, minimum: bigint) {
  const swaps = instructions.filter(ix => ix.programId.equals(program));
  if (swaps.length !== 1) throw new TradingError("Curve builder must contain exactly one supported swap.");
  curveSwapInstruction(program.toBase58(), swaps[0].data, buy, input, minimum);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }), ...instructions] }).compileToV0Message());
  const encoded = Buffer.from(tx.serialize()).toString("base64");
  assertSingleTransaction(encoded, user.toBase58());
  if (tx.serialize().length > 1232) throw new TradingError("Curve transaction exceeds atomic packet size.");
  return { tx, encoded };
}
export async function nativeCurveQuote(inputMint: string, outputMint: string, amount: string,
  limits: ExecutionLimits, taker?: string, connection: Connection = rpc()) {
  const buy = inputMint === SOL;
  if (![inputMint, outputMint].includes(SOL) || inputMint === outputMint || !/^[1-9]\d*$/.test(amount)) throw new TradingError("Invalid native curve request.");
  curveAmounts(BigInt(amount), 10000n, limits.slippageBps);
  if (!isSolanaMainnet(await connection.getGenesisHash())) throw new TradingError("Native launchpad routes require verified Solana mainnet-beta.");
  const mint = new PublicKey(buy ? outputMint : inputMint), input = BigInt(amount);
  // The derived Pump PDA decides the protocol; a label/suffix never does.
  const { pumpCurveAddress } = await import("./curve-policy");
  const raw = await connection.getAccountInfo(pumpCurveAddress(mint));
  const isPump = raw?.owner.equals(PUMP_PROGRAM);
  if (!isPump && (await connection.getAccountInfo(moonitCurveAddress(mint)[0]))?.owner.equals(MOONIT_PROGRAM)) {
    const { moonitQuote } = await import("./moonit-routes");
    return moonitQuote(connection, mint, buy, input, limits, taker);
  }
  if (buy && !isPump) throw new TradingError("Only verified active Pump.fun launchpad buys are approved. DBC, unknown launchpads and ordinary pools are excluded.");
  let output: bigint, spotOutput: number, pool: PublicKey, router: string, identity: string;
  let instructions: TransactionInstruction[] = [];
  const user = taker ? new PublicKey(taker) : null;
  const quotedAt = Date.now();
  if (isPump) {
    const p = await pumpState(connection, mint);
    const args = { global: p.global, feeConfig: p.feeConfig, mintSupply: bn(p.supported.mint.supply),
      bondingCurve: p.curve, amount: bn(input) };
    output = BigInt((buy ? getBuyV3TokenAmountFromQuoteAmount({ ...args, curveBaseTokenBalance: bn(p.base.amount) })
      : getSellSolAmountFromTokenAmount(args)).toString());
    // Independent reserve/spot bounds reject extrapolation past migration and
    // include fees in the conservative impact (not a provider impact string).
    const x = BigInt(p.curve.virtualTokenReserves.toString()), y = BigInt(p.curve.virtualQuoteReserves.toString());
    if (x <= 0n || y <= 0n || output <= 0n ||
        output >= BigInt((buy ? p.curve.realTokenReserves : p.curve.realQuoteReserves).toString()) ||
        output > (buy ? input * x / (y + input) : input * y / (x + input))) throw new TradingError("Pump quote exceeds independent constant-product or real-reserve bounds.");
    spotOutput = Number(input) * (buy ? Number(x) / Number(y) : Number(y) / Number(x));
    const minimum = curveAmounts(input, output, limits.slippageBps);
    if (user) {
      const common = { bondingCurve: p.curve, mint, user, tokenProgram: p.supported.program,
        buybackFeeRecipient: p.global.buybackFeeRecipients[0], slippage: 0 };
      // Pass integer minimum directly; never round via a floating SDK slippage.
      instructions = buy ? await PUMP_SDK.buyExactQuoteInV3Instructions({ ...common,
        associatedUserAccountInfo: await connection.getAccountInfo(tokenAddress(user, mint, p.supported.program)),
        amount: bn(minimum), quoteAmount: bn(input), partialFill: false })
        : await PUMP_SDK.sellV3Instructions({ ...common, amount: bn(input), quoteAmount: bn(minimum) });
    }
    pool = p.pool; router = "pump"; identity = p.identity;
  } else {
    const d = await dbcState(connection, mint);
    if (buy) assertDbcEntryLiquidity(d.config);
    const slot = await connection.getSlot("confirmed");
    const time = d.config.activationType === 0 ? slot : await connection.getBlockTime(slot);
    if (time == null) throw new TradingError("Chain clock unavailable for DBC fee schedule.");
    const currentPoint = new BN(time);
    if (currentPoint.lt(d.state.activationPoint)) throw new TradingError("DBC pool not yet active.");
    // First-swap discount is deliberately not assumed. This quotes the more
    // conservative ordinary schedule; simulation must still meet the minimum.
    const r = d.client.pool.swapQuote({ virtualPool: d.virtualPool, config: d.config,
      swapBaseForQuote: !buy, amountIn: bn(input), slippageBps: 0, hasReferral: false,
      eligibleForFirstSwapWithMinFee: false, currentPoint });
    output = BigInt(r.outputAmount.toString());
    if (output <= 0n || output >= BigInt((buy ? d.state.baseReserve : d.state.quoteReserve).toString()) ||
        !r.referralFee.isZero()) throw new TradingError("DBC quote exceeds real reserves or includes a referral.");
    const sqrt = Number(d.state.sqrtPrice.toString()) / 2 ** 64;
    const price = sqrt * sqrt;
    spotOutput = Number(input) * (buy ? 1 / price : price);
    const minimum = curveAmounts(input, output, limits.slippageBps);
    if (user) instructions = (await d.client.pool.swap({ owner: user, pool: d.pool,
      amountIn: bn(input), minimumAmountOut: bn(minimum), swapBaseForQuote: !buy,
      referralTokenAccount: null })).instructions;
    pool = d.pool; router = "dbc"; identity = d.identity;
  }
  if (!Number.isFinite(spotOutput) || spotOutput <= 0 || Number(output) > spotOutput * 1.000001) throw new TradingError("Curve quote violates its independently read spot-price bound.");
  const q = { router, inputMint, outputMint, inAmount: amount, outAmount: output.toString(),
    slippageBps: limits.slippageBps, priceImpactPct: Math.max(0, (1 - Number(output) / spotOutput) * 100),
    quotedAt, routePoolIds: [pool.toBase58()], programIdentity: identity, venue: venueName(router),
    transaction: undefined as string | undefined };
  assertQuote(q, inputMint, outputMint, amount, limits);
  if (user) {
    const built = await buildCurveTransaction(connection, user, instructions, isPump ? PUMP_PROGRAM : DBC_PROGRAM,
      buy, input, curveAmounts(input, output, limits.slippageBps));
    q.transaction = built.encoded; authorizeCurveBuild(q, built.tx);
  }
  if (Date.now() - quotedAt > 30000) throw new TradingError("Curve state expired while quoting/building.");
  return q;
}
