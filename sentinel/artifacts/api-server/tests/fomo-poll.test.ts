import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { initialState } from "../src/lib/sentinel/store";
import { crazyState } from "../src/lib/sentinel/crazy-policy";
import { pollFomo } from "../src/lib/sentinel/fomo";
import type { Position } from "../src/lib/sentinel/types";

test("Crazy mode selects FOMO leaders alongside other strategies without HTTP wallet-history polling", async () => {
  const originalRpc = process.env.SOLANA_RPC_URL, beforeFetch = globalThis.fetch, at = Date.now();
  process.env.SOLANA_RPC_URL = "https://fomo-rpc.test.invalid";
  const wallet = Keypair.generate().publicKey.toBase58();
  const s = initialState();
  s.running = true; s.settings.riskMode = "crazy"; s.settings.crazyStrategy = "momentum"; s.settings.trackFomoHandles = true;
  globalThis.fetch = async input => {
    assert.equal(new URL(String(input)).hostname, "api.fomo-api.com", "no wallet history requests may run");
    return Response.json({ source: "fomo", stale: false, window: "24h", board: "fomo-parity",
      syncedAt: new Date(at).toISOString(),
      data: [{ rank: 1, handle: "fixture", pnlUsd: 10, wallets: [{ chain: "solana", address: wallet }] }] });
  };
  try {
    await pollFomo(s, at);
    assert.equal(crazyState(s).leaders[0].wallet, wallet);
    assert.equal(crazyState(s).cursors[wallet], undefined);
    assert.equal(crazyState(s).signals.length, 0, "no historical copies on startup");
    assert.doesNotMatch(s.activity.map(e => e.message).join(" "), /leader RPC poll incomplete/);
  } finally {
    globalThis.fetch = beforeFetch;
    if (originalRpc === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = originalRpc;
  }
});
test("paused copies with an offline observation gap require defensive exits without crawling old wallet transactions", async () => {
  const originalRpc = process.env.SOLANA_RPC_URL, beforeFetch = globalThis.fetch, at = Date.now();
  process.env.SOLANA_RPC_URL = "https://fomo-rpc.test.invalid";
  const wallet = Keypair.generate().publicKey.toBase58(), mint = Keypair.generate().publicKey.toBase58();
  const s = initialState(), state = crazyState(s);
  s.running = false;
  s.positions = [{ id: "copy", leaderWallet: wallet, leaderHandle: "fixture", mint, status: "open",
    openedAt: new Date(at - 3600000).toISOString() } as Position];
  state.cursors[wallet] = "prior";
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("No history or leaderboard request allowed for paused existing-copy monitoring"); };
  try {
    await pollFomo(s, at);
    assert.equal(requests, 0);
    assert.equal(state.signals.length, 0, "do not fabricate a leader sell from an observation gap");
    assert.equal(s.positions[0].copyExitUncertain, true);
    assert.ok(s.activity.some(e => e.category === "copy-gap"));
  } finally {
    globalThis.fetch = beforeFetch;
    if (originalRpc === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = originalRpc;
  }
});
