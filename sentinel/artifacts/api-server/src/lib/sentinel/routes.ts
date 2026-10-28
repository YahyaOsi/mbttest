import { PublicKey } from "@solana/web3.js";
import { SOL, validMint } from "./discovery-policy";
import { jsonFetch } from "./http";
import { rpc } from "./chain";
import { decodeSupportedMint, tokenAddress } from "./token-policy";
import { assertQuote, assertSingleTransaction, raydiumQuote, type ExecutionLimits } from "./route-policy";
import { TradingError } from "./store";
import { moonitOrigin } from "./moonit-state";
import { nativeCurveQuote } from "./launchpad-routes";
import { knownPump } from "./pump-snapshot";
import { verifyTokenEntry as verifyLaunchpadEntry } from "./token-entry";
import { assertLockedPoolQuote } from "./locked-pool";
import { authorizeGraduatedQuote } from "./graduated-route-policy";

const RAY = "https://transaction-v1.raydium.io";
export async function rayQuote(input: string, output: string, amount: string, limits: ExecutionLimits, taker?: string) {
  const params = new URLSearchParams({ inputMint: input, outputMint: output, amount,
    slippageBps: String(limits.slippageBps), txVersion: "V0" });
  const response = await jsonFetch(`${RAY}/compute/swap-base-in?${params}`);
  const q = raydiumQuote(response, input, output, amount, limits);
  if (!taker) return q;
  const owner = new PublicKey(taker);
  const mintKey = new PublicKey(input === SOL ? output : input);
  const mint = decodeSupportedMint(mintKey, await rpc().getAccountInfo(mintKey));
  const ata = tokenAddress(owner, mintKey, mint.program).toBase58();
  const built = await jsonFetch(`${RAY}/transaction/swap-base-in`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ computeUnitPriceMicroLamports: "50000", swapResponse: response,
      txVersion: "V0", wallet: taker, wrapSol: input === SOL, unwrapSol: output === SOL,
      ...(input === SOL ? { outputAccount: ata } : { inputAccount: ata }) }),
  });
  if (Date.now() - q.quotedAt > 30000 || !built?.success || !Array.isArray(built.data) ||
      built.data.length !== 1 || typeof built.data[0]?.transaction !== "string") {
    throw new TradingError("Raydium requires an expired, multi-transaction or unsupported swap. Nothing signed.", 422);
  }
  assertSingleTransaction(built.data[0].transaction, taker);
  return { ...q, transaction: built.data[0].transaction };
}
let lastQuoteAt = 0;
let queue: Promise<unknown> = Promise.resolve();
export async function quote(input: string, output: string, amount: string, slippageBps: number, taker?: string, maxPriceImpactPct = 5): Promise<any> {
  if (!validMint(input) || !validMint(output) || input === output || ![input, output].includes(SOL) || !/^[1-9]\d*$/.test(amount)) {
    throw new TradingError("Invalid SOL swap request.", 422);
  }
  const limits = { slippageBps, maxPriceImpactPct };
  const job = queue.then(async () => {
    const wait = 2100 - (Date.now() - lastQuoteAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastQuoteAt = Date.now();
    if (input === SOL) {
      const proof = await verifyLaunchpadEntry(output, true);
      if (proof.phase === "pool") {
        const q = await rayQuote(input, output, amount, limits, taker);
        assertLockedPoolQuote(q, proof);
        return q;
      }
      // An active curve never gets an aggregator fallback.
      if (proof.phase === "active") return nativeCurveQuote(input, output, amount, limits, taker);
      const params = new URLSearchParams({ inputMint: input, outputMint: output, amount,
        slippageBps: String(slippageBps), onlyDirectRoutes: "true", dexes: "Pump.fun Amm",
        excludeRouters: "okx,dflow,jupiterz" });
      if (taker) params.set("taker", taker);
      let q: any;
      try {
        q = await jsonFetch(`https://api.jup.ag/swap/v2/order?${params}`, {
          headers: process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {},
        });
        assertQuote(q, input, output, amount, limits);
        if (taker) {
          if (!q.requestId || !q.transaction) throw new TradingError("Jupiter returned no atomic unsigned build.");
          assertSingleTransaction(q.transaction, taker);
        }
        q = { ...q, quotedAt: Date.now(), routePoolIds: [proof.pool.toBase58()] };
        authorizeGraduatedQuote(q, proof, output);
      } catch (e) {
        throw new TradingError(`Graduated Pump.fun Jupiter route rejected: ${e instanceof TradingError ? e.message : "provider quote/build unavailable"}. No alternate pool buy authorized.`);
      }
      return q;
    }
    if (knownPump(input) || moonitOrigin(input)) {
      try { return await nativeCurveQuote(input, output, amount, limits, taker); }
      catch { /* Migration/provider failure: retain legacy protective sell fallbacks. */ }
    }
    try {
      const params = new URLSearchParams({ inputMint: input, outputMint: output, amount, slippageBps: String(slippageBps) });
      // Only Metis transactions pass the signing policy; stop Jupiter from
      // selecting third-party routers that would just be rejected.
      if (taker) { params.set("taker", taker); params.set("excludeRouters", "okx,dflow,jupiterz"); }
      const q = await jsonFetch(`https://api.jup.ag/swap/v2/order?${params}`, {
        headers: process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {},
      });
      assertQuote(q, input, output, amount, limits);
      if (q.router !== "metis" || (taker && (!q.requestId || !q.transaction))) throw new TradingError("Unsupported Jupiter transaction type.");
      if (taker) assertSingleTransaction(q.transaction, taker);
      return { ...q, quotedAt: Date.now(), routePoolIds: (q.routePlan ?? [])
        .map((r: any) => r.swapInfo?.ammKey).filter(validMint).slice(0, 4) };
    } catch {
      // This is quote/build fallback only. Never retry another route after signing/submission.
      try { return await rayQuote(input, output, amount, limits, taker); }
      catch {
        try { return await nativeCurveQuote(input, output, amount, limits, taker); }
        catch { throw new TradingError("Neither Jupiter nor direct Raydium nor a verified native Pump.fun/Meteora DBC curve returned an executable route within your limits. No transaction signed.", 422); }
      }
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
