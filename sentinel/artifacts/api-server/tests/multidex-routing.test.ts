import test from "node:test";
import assert from "node:assert/strict";
import { quote } from "../src/lib/sentinel/routes";
import { SOL } from "../src/lib/sentinel/discovery-policy";
const mint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
test("Jupiter failures, unsupported routers and excess impact fall back to Raydium, with no broadcast", async () => {
  const original = globalThis.fetch;
  let mode = "outage";
  const paths: string[] = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url)); paths.push(u.hostname + u.pathname);
    assert.notEqual(init?.method, "POST"); // quote-only tests must never build, sign or broadcast
    if (u.hostname === "api.jup.ag") {
      if (mode === "outage") return new Response("unavailable", { status: 503 });
      return Response.json({ inputMint: mint, outputMint: SOL, inAmount: "100", outAmount: "1000",
        slippageBps: 100, priceImpactPct: mode === "impact" ? 5 : 0, router: mode === "maker" ? "jupiterz" : "metis" });
    }
    assert.equal(u.hostname, "transaction-v1.raydium.io");
    if (mode === "both-down") return new Response("unavailable", { status: 503 });
    return Response.json({ success: true, data: { swapType: "BaseIn", inputMint: mint, outputMint: SOL,
      inputAmount: "100", outputAmount: "1000", otherAmountThreshold: "990", slippageBps: 100, priceImpactPct: 0.1,
      routePlan: [{ poolId: mint, inputMint: mint, outputMint: SOL }] } });
  };
  try {
    for (mode of ["outage", "maker", "impact"]) {
      const q = await quote(mint, SOL, "100", 100, undefined, 0.5); assert.equal(q.router, "raydium");
    }
    mode = "good"; const count = paths.length;
    assert.equal((await quote(mint, SOL, "100", 100, undefined, 0.5)).router, "metis");
    assert.equal(paths.length, count + 1);
    mode = "both-down";
    // Force invalid primary output instead of issuing any real request.
    await assert.rejects(() => quote(mint, SOL, "101", 100, undefined, 0.5), /Neither Jupiter nor direct Raydium/);
  } finally { globalThis.fetch = original; }
});
