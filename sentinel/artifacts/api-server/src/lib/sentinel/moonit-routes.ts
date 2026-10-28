import { PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import BN from "bn.js";
import { moonitState } from "./moonit-state";
import { moonitSdk, MOONIT_PROGRAM, MOONIT_CONFIG, MOONIT_DEX_FEE, MOONIT_HELIO_FEE } from "./moonit-policy";
import { tokenAddress } from "./token-policy";
import { SOL } from "./discovery-policy";
import { TradingError } from "./store";
import { curveAmounts, authorizeCurveBuild } from "./launchpad-policy";
import { buildCurveTransaction } from "./launchpad-routes";
import { assertQuote, type ExecutionLimits } from "./route-policy";

export async function moonitQuote(connection: Connection, mint: PublicKey, buy: boolean, input: bigint, limits: ExecutionLimits, taker?: string) {
  const p = await moonitState(connection, mint, buy), quotedAt = Date.now();
  const direction = buy ? "BUY" : "SELL";
  const output = buy ? p.math.getTokenAmountByCollateralSync({ collateralAmount: input, curvePosition: p.state.sold, tradeDirection: direction })
    : p.math.getCollateralAmountByTokensSync({ tokenAmount: input, curvePosition: p.state.sold, tradeDirection: direction });
  const independent = buy ? input * p.virtualTokens / (p.virtualSol + input) : input * p.virtualSol / (p.virtualTokens + input);
  if (output <= 0n || output > independent || output >= (buy ? p.base.amount : p.realSolLamports))
    throw new TradingError("Moonit quote exceeds independently verified constant-product/real reserves.");
  const minimum = curveAmounts(input, output, limits.slippageBps);
  const spot = Number(input) * (buy ? Number(p.virtualTokens) / Number(p.virtualSol) : Number(p.virtualSol) / Number(p.virtualTokens));
  const q: any = { router: "moonit", inputMint: buy ? SOL : mint.toBase58(), outputMint: buy ? mint.toBase58() : SOL,
    inAmount: input.toString(), outAmount: output.toString(), slippageBps: limits.slippageBps, quotedAt,
    routePoolIds: [p.pool.toBase58()], programIdentity: p.identity, venue: "Native Moonit CP-V1",
    priceImpactPct: Math.max(0, (1 - Number(output) / spot) * 100), gasless: false,
    routePlan: [{ swapInfo: { ammKey: p.pool.toBase58(), label: "Native Moonit CP-V1", inputMint: buy ? SOL : mint.toBase58(),
      outputMint: buy ? mint.toBase58() : SOL, inAmount: input.toString(), outAmount: output.toString() }, percent: 100 }] };
  assertQuote(q, q.inputMint, q.outputMint, q.inAmount, limits);
  if (taker) {
    const user = new PublicKey(taker), ata = tokenAddress(user, mint);
    const args = { tokenAmount: new BN((buy ? minimum : input).toString()), collateralAmount: new BN((buy ? input : minimum).toString()),
      fixedSide: 0, slippageBps: new BN(0) };
    const program = moonitSdk().provider.program;
    const method = buy ? program.methods.buy(args) : program.methods.sell(args);
    const swap = await method.accounts({ sender: user, senderTokenAccount: ata, curveAccount: p.pool, curveTokenAccount: p.baseVault,
      dexFee: MOONIT_DEX_FEE, helioFee: MOONIT_HELIO_FEE, mint, configAccount: MOONIT_CONFIG,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction();
    const instructions = buy ? [createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint), swap] : [swap];
    const built = await buildCurveTransaction(connection, user, instructions, MOONIT_PROGRAM, buy, input, minimum);
    q.transaction = built.encoded; authorizeCurveBuild(q, built.tx);
  }
  if (Date.now() - quotedAt > 30000) throw new TradingError("Moonit quote expired.");
  return q;
}
