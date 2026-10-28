import test from "node:test";
import assert from "node:assert/strict";
import { RpcPool } from "../src/lib/sentinel/rpc-pool";
import { boundedEvidence, rpcTask, withRpcMission } from "../src/lib/sentinel/rpc-context";
import { SOLANA_MAINNET_GENESIS } from "../src/lib/sentinel/network-policy";

const nodes = Array.from({ length: 4 }, (_, i) => ({ id: `RPC ${i + 1}`, url: `https://node${i}.invalid`, pinned: false }));
const payload = { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [] }) };
const result = (method: string) => Response.json({ result: method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS : 123 });

test("all background nodes may fail without sending anything to primary or poisoning its wallet health", async () => {
  const calls: string[] = [];
  const pool = new RpcPool(() => nodes, async (e, init) => {
    calls.push(e.id);
    if (e.id !== "RPC 3") return new Response("quota", { status: 429 });
    return result(JSON.parse(String(init.body)).method);
  });
  await assert.rejects(pool.read(payload, "background"), /Background RPCs/);
  assert.ok(!calls.includes("RPC 3"));
  assert.equal(pool.status()[2].healthy, true);
  await pool.read(payload, "wallet");
  assert.equal(calls.at(-1), "RPC 3");
  assert.equal(pool.endpoint("priority"), nodes[2].url);
});
test("primary outage never silently reroutes wallet or swaps through background", async () => {
  let primaryCalls = 0, backgroundCalls = 0;
  const pool = new RpcPool(() => nodes, async (e, init) => {
    if (e.id === "RPC 3") { primaryCalls++; throw new Error("primary offline"); }
    backgroundCalls++; return result(JSON.parse(String(init.body)).method);
  });
  await assert.rejects(pool.read(payload, "wallet"), /Primary RPC/);
  assert.equal(backgroundCalls, 0);
  await assert.rejects(pool.broadcast(new Uint8Array([1]), "sig"));
  assert.equal(backgroundCalls, 0); assert.equal(primaryCalls, 1);
  await pool.read(payload, "background");
  assert.ok(backgroundCalls > 0);
});
test("a single configured endpoint is primary only, never an implicit scan fallback", async () => {
  let calls = 0;
  const pool = new RpcPool(() => nodes.slice(0, 1), async () => { calls++; return result("getBalance"); });
  await assert.rejects(pool.read(payload, "background"));
  assert.throws(() => pool.endpoint("background"), /add a secondary/);
  assert.equal(calls, 0);
  await pool.read(payload, "wallet"); assert.equal(calls, 1);
});
test("priority nested inside a cancelled background task has an independent RPC cancellation scope", async () => {
  const controller = new AbortController(); controller.abort();
  await withRpcMission("background", async () => {
    assert.equal(rpcTask()?.signal?.aborted, true);
    await withRpcMission("priority", async () => {
      assert.equal(rpcTask()?.mission, "priority");
      assert.equal(rpcTask()?.signal, undefined);
    });
    assert.equal(rpcTask()?.mission, "background");
  }, controller.signal);
  assert.equal(rpcTask(), undefined);
});
test("stalled optional AI evidence times out while wallet traffic proceeds independently", async () => {
  let signal: AbortSignal | undefined;
  const evidence = boundedEvidence(() => {
    signal = rpcTask()?.signal;
    assert.equal(rpcTask()?.mission, "background");
    return new Promise<never>(() => {}); // uncooperative provider, no socket/network
  }, 15);
  const rejection = assert.rejects(evidence, /Optional AI evidence timed out/);
  const pool = new RpcPool(() => nodes, async (e, init) => {
    assert.equal(e.id, "RPC 3"); return result(JSON.parse(String(init.body)).method);
  });
  await pool.read(payload, "wallet");
  await rejection;
  assert.equal(signal?.aborted, true); assert.equal(rpcTask(), undefined);
});
