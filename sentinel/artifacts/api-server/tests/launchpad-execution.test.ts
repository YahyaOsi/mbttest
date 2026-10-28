import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { PublicKey, SystemProgram, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { userVolumeAccumulatorPda } from "@pump-fun/pump-sdk";
import { pool } from "@workspace/db";
import { fixture, account, token, blank, encode } from "./helpers/launchpad-fixtures";
import { nativeCurveQuote } from "../src/lib/sentinel/launchpad-routes";
import { executeLive, reconcile } from "../src/lib/sentinel/execution";
import { initialState, normalize } from "../src/lib/sentinel/store";
import { PUMP_PROGRAM } from "../src/lib/sentinel/curve-policy";
import { tokenAddress } from "../src/lib/sentinel/token-policy";
import { SOL } from "../src/lib/sentinel/discovery-policy";
import type { Position } from "../src/lib/sentinel/types";

for (const kind of ["pump"] as const) {
  test(`${kind}: simulation failures sign nothing; mocked fills persist before send, reconcile after restart, and never duplicate ambiguous orders`, async () => {
    // This test replaces ALL network and DB access before using the executor.
    // Only an ephemeral test key exists in this isolated test process.
    const savedEnv = { ...process.env }, originalFetch = globalThis.fetch, originalQuery = pool.query;
    const originalNow = Date.now; let clockOffset = 0;
    Date.now = () => originalNow() + clockOffset;
    const f = fixture(kind), owner = f.user.toBase58(), mint = f.mint.toBase58();
    Object.assign(process.env, { SOLANA_RPC_URL: "https://fixture.invalid", JUPITER_API_KEY: "fixture",
      SOLANA_TRADING_PRIVATE_KEY: JSON.stringify([...f.keypair.secretKey]), SENTINEL_OWNER_USER_ID: "fixture",
      SENTINEL_APP_PASSWORD: "long-fixture-password", SESSION_SECRET: "long-fixture-session-secret-123456789",
      AI_INTEGRATIONS_OPENAI_BASE_URL: "https://fixture.invalid", ENABLE_MAINNET_TRADING: "true",
      SENTINEL_ALWAYS_ON_CONFIRMED: "true", SENTINEL_READ_ONLY: "false" });
    (pool as any).query = async () => ({ rows: [{ halted: false }] });
    let signedTx: VersionedTransaction | undefined;
    let sends = 0, saved = false, failure = "", finalized = false, chainError = false;
    let currentQ: any, direction: "buy" | "sell" = "buy";
    let addresses: string[] = [], pre: (AccountInfo<Buffer> | null)[] = [], post: (AccountInfo<Buffer> | null)[] = [];
    const tokenAta = tokenAddress(f.user, f.mint).toBase58();
    const make = () => {
      const s = initialState();
      s.settings = { ...s.settings, mode: "live", acknowledgeRisk: true, launchpadCurvesEnabled: true, solReserve: 0.01, maxPriceImpactPct: 5 };
      s.walletBinding = owner; s.solPriceUsd = 100; s.liveCashSol = 1; s.liveCashUsd = 100; s.running = true;
      const p = { id: "fixture-position", mint, symbol: "FIXTURE", mode: "live", status: "open", walletAddress: owner,
        rawInitial: "1000000", rawRemaining: "1000000", decimals: 6, quantity: 1, originalCostUsd: 0.1, remainingCostUsd: 0.1,
        originalCostSol: 0.001, remainingCostSol: 0.001, realizedPnlSol: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0,
        stage: 0, entryPriceUsd: 0.1, currentPriceUsd: 0.1, highWaterPriceUsd: 0.1, highWaterPriceSol: 0.001 } as Position;
      s.positions = [p]; return { s, p };
    };
    const wire = (a: AccountInfo<Buffer> | null) => a ? { ...a, owner: a.owner.toBase58(), data: [a.data.toString("base64"), "base64"] } : null;
    const rpcResult = (id: string, result: any) => Response.json({ jsonrpc: "2.0", id, result });
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).hostname, "fixture.invalid", "A test must never reach a real provider");
      const req = JSON.parse(String(init!.body)), method = req.method, context = { slot: 123 };
      if (method === "getLatestBlockhash") return rpcResult(req.id, { context,
        value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1000 } });
      if (method === "getBlockHeight") return rpcResult(req.id, 1);
      if (method === "isBlockhashValid") return rpcResult(req.id, { context, value: true });
      if (method === "getGenesisHash") return rpcResult(req.id, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
      if (method === "getMultipleAccounts") {
        assert.ok(req.params[0].length <= 5);
        return rpcResult(req.id, { context, value: req.params[0].map((k: string) => wire(f.accounts.get(k) ?? null)) });
      }
      if (method === "getAccountInfo") return rpcResult(req.id, { context, value: wire(f.accounts.get(req.params[0]) ?? null) });
      if (method === "getFeeForMessage") return rpcResult(req.id, { context, value: 5000 });
      if (method === "getMinimumBalanceForRentExemption") return rpcResult(req.id, 1844400);
      if (method === "simulateTransaction") {
        addresses = req.params[1].accounts.addresses;
        pre = addresses.map(k => f.accounts.get(k) ?? null);
        post = pre.map(a => a ? { ...a, data: Buffer.from(a.data) } : null);
        const wi = addresses.indexOf(owner), ti = addresses.indexOf(tokenAta);
        const rent = direction === "buy" ? 2039280 + (kind === "pump" ? 1844400 : 0) : 0;
        post[wi]!.lamports += direction === "buy" ? -Number(currentQ.inAmount) - rent - 5000 : Number(currentQ.outAmount) - 5000;
        post[ti] = token(f.mint, f.user, direction === "buy" ? BigInt(currentQ.outAmount) : BigInt(currentQ.inAmount) / 99n,
          failure === "delegate" ? f.mint : PublicKey.default);
        if (kind === "pump") {
          const vi = addresses.indexOf(userVolumeAccumulatorPda(f.user).toBase58());
          post[vi] = account(PUMP_PROGRAM, encode(f.program, "userVolumeAccumulator",
            { ...blank(f.program, "userVolumeAccumulator"), user: f.user }), 1844400);
        }
        if (failure === "minimum") post[ti] = token(f.mint, f.user, 1n);
        return rpcResult(req.id, { context, value: { err: failure === "simulation" ? { InstructionError: [0, "Custom"] } : null,
          logs: [], accounts: post.map(wire), unitsConsumed: 100000 } });
      }
      if (method === "sendTransaction") {
        sends++; assert.equal(saved, true, "Intent/signature must be durable before submission");
        signedTx = VersionedTransaction.deserialize(Buffer.from(req.params[0], "base64"));
        assert.ok(signedTx.signatures[0].some(n => n !== 0));
        if (failure === "timeout") throw new Error("Synthetic ambiguous submission");
        return rpcResult(req.id, bs58.encode(signedTx.signatures[0]));
      }
      if (method === "getSignatureStatuses") return rpcResult(req.id, { context, value: [finalized ?
        { slot: 123, confirmations: null, confirmationStatus: "finalized", err: chainError ? { InstructionError: [0, "Custom"] } : null } : null] });
      if (method === "getTransaction") {
        const message = signedTx!.message;
        const tokenIndex = message.staticAccountKeys.findIndex(k => k.toBase58() === tokenAta);
        const balance = (value: string) => [{ accountIndex: tokenIndex, owner, mint,
          uiTokenAmount: { amount: value, decimals: 6, uiAmount: null, uiAmountString: value } }];
        return rpcResult(req.id, { slot: 123, blockTime: 1800000000, version: 0,
          transaction: { signatures: [bs58.encode(signedTx!.signatures[0])], message: {
            accountKeys: message.staticAccountKeys.map(k => k.toBase58()), header: message.header,
            recentBlockhash: message.recentBlockhash, addressTableLookups: [],
            instructions: message.compiledInstructions.map(i => ({ programIdIndex: i.programIdIndex, accounts: [...i.accountKeyIndexes], data: bs58.encode(i.data) })) } },
          meta: { err: null, fee: 5000, preBalances: [1e9], postBalances: [post[0]!.lamports],
            preTokenBalances: direction === "buy" ? [] : balance((BigInt(currentQ.inAmount) * 100n / 99n).toString()),
            postTokenBalances: direction === "buy" ? balance(currentQ.outAmount) : balance((BigInt(currentQ.inAmount) / 99n).toString()),
            loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [], logMessages: [] } });
      }
      throw new Error(`Unexpected mock RPC ${method}`);
    };
    try {
      f.accounts.set(owner, account(SystemProgram.programId, Buffer.alloc(0), 1e9));
      for (const fail of ["simulation", "delegate", "minimum"]) {
        const { s, p } = make(); failure = fail;
        currentQ = await nativeCurveQuote(SOL, mint, "1000000", s.settings, owner, f.connection);
        await assert.rejects(() => executeLive("fixture", s, p, currentQ, "buy", 1, "fixture", async () => { saved = true; }));
        assert.equal(sends, 0); assert.equal(saved, false); assert.equal(s.pending, null);
      }
      failure = "";
      const stale = make();
      currentQ = await nativeCurveQuote(SOL, mint, "1000000", stale.s.settings, owner, f.connection);
      currentQ.quotedAt = Date.now() - 31000;
      await assert.rejects(() => executeLive("fixture", stale.s, stale.p, currentQ, "buy", 1, "stale", async () => {}), /Expired/);
      assert.equal(sends, 0);
      const unsaved = make();
      currentQ = await nativeCurveQuote(SOL, mint, "1000000", unsaved.s.settings, owner, f.connection);
      await assert.rejects(() => executeLive("fixture", unsaved.s, unsaved.p, currentQ, "buy", 1, "save failure",
        async () => { throw new Error("Synthetic durable-save failure"); }), /durable-save failure/);
      assert.equal(sends, 0, "A failed durable save must not submit a signed transaction");
      failure = "timeout";
      const { s, p } = make();
      currentQ = await nativeCurveQuote(SOL, mint, "1000000", s.settings, owner, f.connection);
      await executeLive("fixture", s, p, currentQ, "buy", 1, "fixture", async () => { saved = !!s.pending?.signature; });
      assert.equal(sends, 1); assert.equal(s.running, true); assert.ok(s.pending);
      assert.equal(s.pending.lastValidBlockHeight, 1000);
      assert.equal(s.pending.recentBlockhash, signedTx!.message.recentBlockhash);
      assert.equal(s.pending.durableNonce, false);
      const signature = s.pending.signature;
      const restored = normalize(JSON.parse(JSON.stringify(s)));
      await assert.rejects(() => executeLive("fixture", restored, restored.positions[0], currentQ, "buy", 1, "duplicate", async () => {}), /awaiting reconciliation/);
      assert.equal(sends, 1); assert.equal(restored.pending!.signature, signature);
      finalized = true; failure = "";
      clockOffset += 3000; // provider cooldown after the ambiguous submission
      await reconcile(restored);
      assert.equal(restored.pending, null); assert.equal(restored.positions[0].status, "open");
      assert.equal(restored.positions[0].rawRemaining, currentQ.outAmount);
      assert.ok(restored.positions[0].originalCostSol > Number(currentQ.inAmount) / 1e9); // fees/rent in basis
      // A real executor sell uses the same simulation and durable-intent path.
      direction = "sell"; saved = false; finalized = false;
      f.accounts.set(tokenAta, token(f.mint, f.user, 1000000n));
      if (kind === "pump") f.accounts.set(userVolumeAccumulatorPda(f.user).toBase58(),
        account(PUMP_PROGRAM, encode(f.program, "userVolumeAccumulator", { ...blank(f.program, "userVolumeAccumulator"), user: f.user }), 1844400));
      const sale = make();
      currentQ = await nativeCurveQuote(mint, SOL, "990000", { ...sale.s.settings, maxPriceImpactPct: 5 }, owner, f.connection);
      // Pump's fixture price makes this sell dust; use a proportionate larger
      // sell with real modeled reserves so the net-native exit check can pass.
      if (Number(currentQ.outAmount) <= 5000) {
        sale.p.rawInitial = sale.p.rawRemaining = "1000000000";
        f.accounts.set(tokenAta, token(f.mint, f.user, 1000000000n));
        currentQ = await nativeCurveQuote(mint, SOL, "990000000", { ...sale.s.settings, maxPriceImpactPct: 5 }, owner, f.connection);
      }
      await executeLive("fixture", sale.s, sale.p, currentQ, "sell", 1, "fixture exit", async () => { saved = true; });
      finalized = true;
      const saleRestart = normalize(JSON.parse(JSON.stringify(sale.s)));
      await reconcile(saleRestart);
      assert.equal(saleRestart.pending, null); assert.equal(saleRestart.positions[0].rawRemaining, (BigInt(sale.p.rawInitial!) / 100n).toString());
      assert.equal(saleRestart.positions[0].status, "retained");
      const failed = normalize(JSON.parse(JSON.stringify(s)));
      chainError = true;
      await reconcile(failed);
      assert.equal(failed.pending, null); assert.equal(failed.positions[0].status, "error");
      assert.equal(sends, 2, "reconciliation never submits another transaction");
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch; pool.query = originalQuery;
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });
}
