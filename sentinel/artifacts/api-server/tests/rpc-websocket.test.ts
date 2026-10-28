import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SystemProgram } from "@solana/web3.js";
import { PinnedRpcLogSubscriptions } from "../src/lib/sentinel/rpc-websocket";

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.emit("close"); }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("unsupported logsSubscribe disables streaming without reconnect storms; HTTP clients remain independent", async () => {
  const sockets: FakeSocket[] = [], states: string[] = [];
  const transport = new PinnedRpcLogSubscriptions("https://custom-rpc.example.org", {
    lookup: (async () => [{ address: "93.184.216.34", family: 4 }]) as any,
    socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    retryMs: 1,
  });
  try {
    transport.onStatus(s => states.push(s));
    transport.onLogs(SystemProgram.programId, () => undefined);
    await tick();
    sockets[0].emit("open");
    const req = JSON.parse(sockets[0].sent[0]);
    sockets[0].emit("message", JSON.stringify({ id: req.id, error: { code: -32601, message: "Method logsSubscribe not found" } }));
    transport.onLogs(SystemProgram.programId, () => undefined);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].sent.length, 1);
    assert.equal(states.at(-1), "unavailable");
  } finally { transport.close(); }
});

test("custom RPC websocket uses an isolated DNS-pinned public address and delivers logs", async () => {
  const sockets: FakeSocket[] = [];
  const observed: { url: string; options: any }[] = [];
  const states: string[] = [];
  const alerts: string[] = [];
  let lookups = 0;
  const transport = new PinnedRpcLogSubscriptions("https://custom-rpc.example.org/path?api-key=fixture-only", {
    lookup: (async () => { lookups++; return [{ address: "93.184.216.34", family: 4 }]; }) as any,
    socketFactory: (url, options) => {
      observed.push({ url, options });
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    retryMs: 5,
  });
  transport.onStatus(state => states.push(state));
  const localId = transport.onLogs(SystemProgram.programId, event => alerts.push(event.signature), "confirmed");
  await tick();

  assert.equal(localId, 1);
  assert.equal(lookups, 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].url, "wss://custom-rpc.example.org/path?api-key=fixture-only");
  assert.equal(observed[0].options.followRedirects, false);
  assert.equal(observed[0].options.maxPayload, 1024 * 1024);
  let resolvedAddress = "";
  observed[0].options.lookup("custom-rpc.example.org", {}, (_error: unknown, address: string) => { resolvedAddress = address; });
  let allAddresses: unknown;
  observed[0].options.lookup("custom-rpc.example.org", { all: true }, (_error: unknown, addresses: unknown) => { allAddresses = addresses; });
  assert.deepEqual(allAddresses, [{ address: resolvedAddress, family: 4 }], "Node all:true DNS lookup receives an address list");
  assert.equal(resolvedAddress, "93.184.216.34");
  let wrongHostError: unknown;
  observed[0].options.lookup("attacker.example.org", {}, (error: unknown) => { wrongHostError = error; });
  assert.ok(wrongHostError, "the pinned lookup must reject a different hostname");

  const socket = sockets[0];
  socket.emit("open");
  const request = JSON.parse(socket.sent[0]);
  assert.equal(request.method, "logsSubscribe");
  assert.deepEqual(request.params[0].mentions, [SystemProgram.programId.toBase58()]);
  socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 741 })));
  assert.ok(states.includes("connected"));
  socket.emit("message", Buffer.from(JSON.stringify({
    jsonrpc: "2.0", method: "logsNotification",
    params: { subscription: 741, result: { context: { slot: 9 }, value: { signature: "fixture-signature", err: null, logs: ["fixture"] } } },
  })));
  assert.deepEqual(alerts, ["fixture-signature"]);
  await transport.removeOnLogsListener(localId);
  transport.onLogs(SystemProgram.programId, () => undefined, "confirmed");
  await tick();
  assert.equal(lookups, 2, "every new socket resolves and pins the host again");
  assert.equal(sockets.length, 2);
  transport.close();
});

test("custom RPC websocket fails closed when DNS contains a private or mixed answer", async () => {
  for (const answers of [
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.8", family: 4 }],
  ]) {
    let socketCount = 0;
    const states: string[] = [];
    const transport = new PinnedRpcLogSubscriptions("https://custom-rpc.example.org/rpc", {
      lookup: (async () => answers) as any,
      socketFactory: () => { socketCount++; return new FakeSocket(); },
      retryMs: 5,
    });
    transport.onStatus(state => states.push(state));
    transport.onLogs(SystemProgram.programId, () => undefined, "confirmed");
    await tick();
    assert.equal(socketCount, 0, "no socket may be created for a private or mixed DNS result");
    assert.ok(states.includes("unavailable"));
    transport.close();
  }
});
