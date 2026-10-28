import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Keypair, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";
import { defaults, initialState, normalize } from "../src/lib/sentinel/store";
import { snapshotExitPlan, tierAmount, markExitFill, moonbagDecision, liquidityDrop, moonbagPreset } from "../src/lib/sentinel/exit-policy";
import { raydiumQuote, impact, raySwapInstruction, assertSingleTransaction } from "../src/lib/sentinel/route-policy";
import { majorWalletOutflow, vaultSnapshot, blockLiquidityDrop } from "../src/lib/sentinel/chain-risk-policy";
import { walletTokenChanges } from "../src/lib/sentinel/transaction-policy";
import { tokenAddress, TOKEN_PROGRAM_ID } from "../src/lib/sentinel/token-policy";
import { SOL, USDC } from "../src/lib/sentinel/discovery-policy";
import type { Position } from "../src/lib/sentinel/types";

const mint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
function position(): Position {
  return { rawInitial: "1000", rawRemaining: "1000", exitPlan: snapshotExitPlan({ ...defaults, ...moonbagPreset, trailingStopPct: 8 }),
    firstTierDone: false, secondTierDone: false, highWaterPriceSol: 4, lastExitPriceSol: 4 } as Position;
}
test("50/30/20 uses original raw tokens, not 30% of the remainder", () => {
  const p = position();
  assert.equal(tierAmount(p, 1), 500n);
  p.rawRemaining = "500"; markExitFill(p);
  assert.equal(p.firstTierDone, true); assert.equal(p.secondTierDone, false);
  assert.equal(tierAmount(p, 2), 300n); // NOT 150
  p.rawRemaining = "200"; markExitFill(p);
  assert.equal(p.secondTierDone, true); assert.equal(tierAmount(p, 2), 0n);
});
test("tier boundaries, gap behavior and moon-bag trailing activation", () => {
  const p = position();
  assert.equal(moonbagDecision(p, 99.99, 2), null);
  assert.equal(moonbagDecision(p, 100, 2)?.tier, 1);
  assert.equal(moonbagDecision(p, 900, 10)?.tier, 1); // one reconciled fill at a time
  p.rawRemaining = "500"; markExitFill(p);
  assert.equal(moonbagDecision(p, 299.99, 0.1), null); // no early moon-bag trail
  assert.equal(moonbagDecision(p, 300, 4)?.tier, 2);
  p.rawRemaining = "200"; markExitFill(p);
  assert.equal(moonbagDecision(p, 500, 3.7), null);
  assert.equal(moonbagDecision(p, 500, 3.68)?.full, "Moon bag trailing stop");
});
test("partial fills and restarts do not duplicate or advance an unfilled tier", () => {
  const p = position();
  assert.equal(p.firstTierDone, false);
  p.rawRemaining = "700"; markExitFill(p);
  assert.equal(p.firstTierDone, false); assert.equal(tierAmount(p, 1), 200n);
  const restored = JSON.parse(JSON.stringify(p)) as Position;
  assert.equal(tierAmount(restored, 1), 200n);
  restored.rawRemaining = "0"; markExitFill(restored);
  assert.equal(restored.secondTierDone, false); // emergency liquidation isn't a profit target
});
test("snapshots retain their own targets and reject zero moon bags", () => {
  const p = position();
  const changed = { ...defaults, takeProfitPct: 200 };
  assert.equal(p.exitPlan?.firstTargetPct, 100);
  assert.equal(snapshotExitPlan(changed)?.firstTargetPct, 200);
  assert.throws(() => snapshotExitPlan({ ...defaults, firstSellPct: 70, secondSellPct: 30 }));
});
test("migration changes future entry plan without changing budget, mode or existing exposure", () => {
  const s = initialState(); delete s.exitPlanVersion;
  s.settings = { ...s.settings, mode: "live", takeProfitPct: 20, secondTakeProfitPct: 50, exitStrategy: "adaptive", positionSizeUsd: 5.5 };
  s.positions = [{ ...position(), exitPlan: undefined, status: "open", walletAddress: "original-wallet", rawRemaining: "400" } as Position];
  const migrated = normalize(s);
  assert.equal(migrated.settings.mode, "live"); assert.equal(migrated.settings.positionSizeUsd, 5.5);
  assert.equal(migrated.settings.exitStrategy, "moonbag"); assert.equal(migrated.settings.takeProfitPct, 100);
  assert.equal(migrated.positions[0].rawRemaining, "400");
  assert.equal(migrated.positions[0].exitPlan, undefined);
  assert.equal(migrated.positions[0].legacyExitSettings?.takeProfitPct, 20);
  const custom = { ...migrated, settings: { ...migrated.settings, takeProfitPct: 120 } };
  assert.equal(normalize(custom).settings.takeProfitPct, 120); // one-time migration
});
const rayResponse = () => ({ success: true, data: { swapType: "BaseIn", inputMint: SOL, outputMint: mint,
  inputAmount: "100", outputAmount: "1000", otherAmountThreshold: "990", slippageBps: 100, priceImpactPct: 0.05,
  routePlan: [{ poolId: mint, inputMint: SOL, outputMint: mint }], referrerAmount: "0" } });
test("Raydium quotes preserve exact mints/amounts, slippage and route continuity", () => {
  const limits = { slippageBps: 100, maxPriceImpactPct: 0.5 };
  assert.equal(raydiumQuote(rayResponse(), SOL, mint, "100", limits).router, "raydium");
  const r = rayResponse(); r.data.otherAmountThreshold = "1";
  assert.throws(() => raydiumQuote(r, SOL, mint, "100", limits));
  assert.throws(() => raydiumQuote(rayResponse(), SOL, mint, "101", limits));
  const swapped = rayResponse(); swapped.data.routePlan[0].outputMint = USDC;
  assert.throws(() => raydiumQuote(swapped, SOL, mint, "100", limits));
  const fees = rayResponse(); fees.data.referrerAmount = "1";
  assert.throws(() => raydiumQuote(fees, SOL, mint, "100", limits));
});
test("unknown or excessive impacts are not coerced into zero", () => {
  for (const value of [null, undefined, "", [], false, {}, "bad", 0.6]) assert.throws(() => impact({ priceImpactPct: value }, 0.5));
  impact({ priceImpactPct: 0 }, 0.5);
});
test("Raydium encoded amount/minimum output and exact input are enforced", () => {
  const program = "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS";
  const data = Buffer.alloc(17); data[0] = 0; data.writeBigUInt64LE(100n, 1); data.writeBigUInt64LE(990n, 9);
  assert.equal(raySwapInstruction(program, data, 100n, 990n), true);
  assert.throws(() => raySwapInstruction(program, data, 101n, 990n));
  assert.throws(() => raySwapInstruction(program, data, 100n, 991n));
  data[0] = 7; assert.throws(() => raySwapInstruction(program, data, 100n, 990n));
});
test("wrong signer/fee payer is rejected before any signature", () => {
  const owner = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner,
    recentBlockhash: SystemProgram.programId.toBase58(), instructions: [] }).compileToV0Message());
  assertSingleTransaction(Buffer.from(tx.serialize()).toString("base64"), owner.toBase58());
  assert.throws(() => assertSingleTransaction(Buffer.from(tx.serialize()).toString("base64"), other.toBase58()));
});
function parsedTx() {
  return { slot: 123, transaction: { message: { accountKeys: [{ pubkey: mint, signer: true },
    { pubkey: SOL, signer: false }, { pubkey: USDC, signer: false }] } },
    meta: { err: null, preBalances: [100, 0, 0], postBalances: [200, 0, 0],
      preTokenBalances: [{ accountIndex: 1, owner: mint, mint, uiTokenAmount: { amount: "20000" } }],
      postTokenBalances: [{ accountIndex: 1, owner: mint, mint, uiTokenAmount: { amount: "5000" } }] } };
}
test("major wallet outflow requires a signer, >=1% supply, half holdings and proceeds", () => {
  assert.equal(majorWalletOutflow(parsedTx(), mint, 1000000n), mint);
  const pool = parsedTx(); pool.transaction.message.accountKeys[0].signer = false;
  assert.equal(majorWalletOutflow(pool, mint, 1000000n), null);
  const transfer = parsedTx(); transfer.meta.postBalances[0] = 50;
  assert.equal(majorWalletOutflow(transfer, mint, 1000000n), null);
  assert.equal(majorWalletOutflow(parsedTx(), mint, 100000000n), null);
});
test("30% single-block reserve drops require ordered contiguous verified changes", () => {
  assert.equal(liquidityDrop(100, 70), true); assert.equal(liquidityDrop(100, 70.01), false);
  assert.equal(liquidityDrop(NaN, 1), false);
  const samples = new Map([["first", { before: 100, after: 80 }], ["last", { before: 80, after: 69 }]]);
  assert.equal(blockLiquidityDrop(samples, ["first", "last"]), true);
  assert.equal(blockLiquidityDrop(samples, ["last", "first"]), false);
  samples.set("last", { before: 79, after: 60 });
  assert.equal(blockLiquidityDrop(samples, ["first", "last"]), false);
});
test("vault snapshots use actual token account indices and ignore failed transactions", () => {
  const tx = parsedTx();
  tx.meta.preTokenBalances = [
    { accountIndex: 1, mint, owner: "", uiTokenAmount: { amount: "100" } },
    { accountIndex: 2, mint: SOL, owner: "", uiTokenAmount: { amount: "100" } }];
  tx.meta.postTokenBalances = tx.meta.preTokenBalances.map(b => ({ ...b, uiTokenAmount: { amount: "60" } }));
  const pool = { pool: mint, vaultA: SOL, vaultB: USDC, mintA: mint, mintB: SOL, decimalsA: 0, decimalsB: 0 };
  assert.deepEqual(vaultSnapshot(tx, pool, { [mint]: 1, [SOL]: 1 }), { before: 200, after: 120 });
  (tx.meta as any).err = { bad: true }; assert.equal(vaultSnapshot(tx, pool, { [mint]: 1, [SOL]: 1 }), null);
});
test("simulation forbids foreign wallet-token spending or delegate changes", () => {
  const owner = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
  const token = (m: string, qty: bigint, delegate = false) => {
    const data = Buffer.alloc(165);
    AccountLayout.encode({ mint: new PublicKey(m), owner, amount: qty, delegateOption: delegate ? 1 : 0,
      delegate: other, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
      closeAuthorityOption: 0, closeAuthority: SystemProgram.programId }, data);
    return { owner: TOKEN_PROGRAM_ID, lamports: 2039280, data, executable: false, rentEpoch: 0 };
  };
  const addresses = [owner, tokenAddress(owner, new PublicKey(mint)), tokenAddress(owner, new PublicKey(USDC))];
  const before = [null, token(mint, 10n), token(USDC, 20n)];
  const asSim = (a: any) => a ? { ...a, owner: a.owner.toBase58(), data: [a.data.toString("base64"), "base64"] } : null;
  const unchanged = before.map(asSim);
  assert.equal(walletTokenChanges(owner, mint, new Set([mint, USDC]), addresses, before, unchanged), 0);
  assert.throws(() => walletTokenChanges(owner, mint, new Set([mint, USDC]), addresses, before, [null, asSim(token(mint, 15n, true)), unchanged[2]]));
  assert.throws(() => walletTokenChanges(owner, mint, new Set([mint, USDC]), addresses, before, [null, unchanged[1], asSim(token(USDC, 19n))]));
});
