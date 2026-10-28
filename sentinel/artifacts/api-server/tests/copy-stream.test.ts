import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { LeaderWalletStream } from "../src/lib/sentinel/copy-stream";
import type { LogsCallback } from "../src/lib/sentinel/rpc-websocket";

type Status = "connecting" | "connected" | "unavailable";
class FakeStream {
  listeners: ((status: Status) => void)[] = [];
  callbacks = new Map<string, LogsCallback>();
  unsupported = false;
  closed = false;
  onStatus(listener: (state: Status) => void) {
    this.listeners.push(listener); listener("connecting");
    return () => true;
  }
  onLogs(wallet: { toBase58(): string }, callback: LogsCallback) {
    this.callbacks.set(wallet.toBase58(), callback); return this.callbacks.size;
  }
  close() { this.closed = true; }
  capabilityUnavailable() { return this.unsupported; }
  emit(status: Status) { for (const listener of this.listeners) listener(status); }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 15));

test("wallet streams require acknowledgements, fail over secondary endpoints and deduplicate live signatures", async () => {
  const clients: FakeStream[] = [], urls: string[] = [];
  const wallet = Keypair.generate().publicKey.toBase58();
  const engine = new LeaderWalletStream({ endpoints: () => [{ id: "RPC 1", url: "background-a" }, { id: "RPC 4", url: "background-b" }],
    create: url => { urls.push(url); const client = new FakeStream(); clients.push(client); return client; },
    retryMs: 1, acknowledgementMs: 1000 });
  try {
    engine.sync([wallet], 1);
    assert.equal(engine.healthy(), false);
    clients[0].unsupported = true; clients[0].emit("unavailable");
    await pause();
    assert.deepEqual(urls, ["background-a", "background-b"]);
    assert.equal(clients[0].closed, true);
    clients[1].emit("connected");
    assert.equal(engine.healthy(), true);
    assert.match(engine.status(), /RPC 4.*connected/);
    const notice = { signature: "signature", err: null, logs: [] };
    clients[1].callbacks.get(wallet)!(notice, { slot: 1 });
    clients[1].callbacks.get(wallet)!(notice, { slot: 1 });
    assert.equal(engine.pending(new Set([wallet])).length, 1);
    engine.acknowledge("signature", wallet);
    assert.equal(engine.queued(), false);
    assert.equal(urls.some(url => url.includes("primary")), false);
  } finally { engine.close(); }
});
test("all unsupported secondary providers are reported honestly and are not hammered or replaced by HTTP polling", async () => {
  const clients: FakeStream[] = [];
  const engine = new LeaderWalletStream({ endpoints: () => [{ id: "RPC 1", url: "background" }],
    create: () => { const client = new FakeStream(); clients.push(client); return client; }, retryMs: 1 });
  try {
    engine.sync([Keypair.generate().publicKey.toBase58()], 1);
    clients[0].unsupported = true; clients[0].emit("unavailable");
    await pause();
    assert.equal(engine.healthy(), false);
    assert.equal(clients.length, 1);
    assert.match(engine.status(), /WebSocket-capable secondary RPC is required/);
    assert.match(engine.status(), /no history polling/);
  } finally { engine.close(); }
});
test("expired unresolved live notices record an observation gap; configuration changes close old streams", () => {
  let now = 100;
  const clients: FakeStream[] = [];
  const wallet = Keypair.generate().publicKey.toBase58();
  const engine = new LeaderWalletStream({ endpoints: () => [{ id: "RPC 2", url: "background" }], now: () => now,
    create: () => { const client = new FakeStream(); clients.push(client); return client; } });
  try {
    engine.sync([wallet], 1);
    clients[0].emit("connected");
    clients[0].callbacks.get(wallet)!({ signature: "old", err: null, logs: [] }, { slot: 1 });
    now += 30_001;
    assert.deepEqual(engine.pending(new Set([wallet])), []);
    assert.equal(engine.lastGapAt(), now);
    engine.sync([wallet], 2);
    assert.equal(clients[0].closed, true);
    clients[0].callbacks.get(wallet)!({ signature: "late-old-stream", err: null, logs: [] }, { slot: 2 });
    assert.equal(engine.queued(), false);
    assert.equal(engine.healthy(), false);
    engine.sync([], 2);
    assert.equal(clients[1].closed, true);
    assert.match(engine.status(), /No active target/);
  } finally { engine.close(); }
});
