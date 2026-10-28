import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import dns from "node:dns/promises";
import https from "node:https";
import { pool } from "@workspace/db";
import { SOLANA_MAINNET_GENESIS } from "../src/lib/sentinel/network-policy";

// A separate test worker with fake password, session key, database and RPC.
// Never reads or mutates real credentials, production accounts or providers.
process.env.SENTINEL_APP_PASSWORD = "fixture-password-not-for-deployment";
process.env.SESSION_SECRET = "fixture-session-secret-not-for-deployment-123456";
process.env.SOLANA_TRADING_PRIVATE_KEY = "";
process.env.SENTINEL_READ_ONLY = "true";
process.env.ENABLE_MAINNET_TRADING = "false";
process.env.SENTINEL_OWNER_USER_ID = "isolated-rpc-owner";
process.env.SOLANA_RPC_URL = "https://rpc-provider.example.org/fallback?key=fixture";
process.env.LOG_LEVEL = "silent";
const sessions = new Map<string, { epoch: string; expires: number }>();
let ledger: any = {
  version: 2, settings: { mode: "paper" }, positions: [], candidates: [], assessments: {},
  activity: [], equity: [], cooldowns: {}, cashSol: null, pending: null, running: false,
};
let halted = false;
const query = async (sql: string, params: any[] = []): Promise<any> => {
  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.startsWith("INSERT INTO sentinel_diagnostics")) return { rows: [] };
  if (sql.startsWith("SELECT id FROM sentinel_owner_sessions")) {
    const s = sessions.get(params[0]);
    return { rows: s && s.epoch === params[1] && s.expires > Date.now() ? [{ id: params[0] }] : [] };
  }
  if (sql.startsWith("INSERT INTO sentinel_login_limits")) return { rows: [{ attempts: 1 }] };
  if (sql.startsWith("DELETE FROM sentinel_login_limits")) return { rows: [] };
  if (sql.startsWith("INSERT INTO sentinel_owner_sessions")) {
    sessions.set(params[0], { epoch: params[1], expires: +params[2] }); return { rows: [] };
  }
  if (sql.startsWith("DELETE FROM sentinel_owner_sessions")) return { rows: [] };
  if (sql.startsWith("INSERT INTO trading_accounts")) return { rows: [] };
  if (sql.startsWith("SELECT state FROM trading_accounts")) return { rows: [{ state: structuredClone(ledger) }] };
  if (sql.startsWith("UPDATE trading_accounts SET state=")) { ledger = JSON.parse(params[1]); return { rows: [] }; }
  if (sql.startsWith("UPDATE trading_accounts SET halted=")) { halted = params[1]; return { rows: [] }; }
  if (sql.startsWith("SELECT halted, emergency_requested")) return { rows: [{ halted, emergency_requested: false }] };
  if (sql.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
  if (sql.startsWith("SELECT pg_advisory_unlock")) return { rows: [] };
  throw new Error(`Unexpected SQL in isolated RPC test: ${sql.split(" ")[0]}`);
};
(pool as any).query = query;
(pool as any).connect = async () => ({ query, release() {} });
const { default: app } = await import("../src/app");

test("owner can verify, switch, persist across reload, and revert RPC without trading or revealing the URL", async () => {
  const beforeDns = dns.lookup, beforeRequest = https.request;
  (dns as any).lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const methods: string[] = [];
  let genesis = SOLANA_MAINNET_GENESIS, status = 200;
  (https as any).request = (_url: URL, _options: unknown, callback: (res: any) => void) => {
    const request: any = new EventEmitter();
    request.end = (body: string) => {
      const q = JSON.parse(body); methods.push(q.method);
      const response: any = new EventEmitter(); response.statusCode = status;
      callback(response);
      const result = q.method === "getGenesisHash" ? genesis
        : q.method === "getBalance" ? { context: { slot: 1 }, value: 0 } : 1;
      response.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: q.id, result })));
      response.emit("end");
    };
    request.destroy = () => {};
    request.on("error", () => {});
    return request;
  };
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  const origin = `https://127.0.0.1:${port}`;
  const send = (path: string, method = "GET", data?: object, cookie?: string, withOrigin = true) =>
    fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(withOrigin ? { Origin: origin } : {}), "Content-Type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
  const replacement = "https://new-rpc.example.org/mainnet?api-key=fixture-private-credential";
  try {
    assert.equal((await send("/api/sentinel/rpc")).status, 401);
    assert.equal((await send("/api/sentinel/rpc", "PUT", { url: replacement })).status, 401);
    const login = await send("/api/auth/login", "POST", { password: process.env.SENTINEL_APP_PASSWORD });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await send("/api/sentinel/rpc", "PUT", { url: replacement }, cookie, false)).status, 403);
    assert.equal((await send("/api/sentinel/rpc/test", "POST", { url: replacement }, cookie, false)).status, 403);
    const probe = await send("/api/sentinel/rpc/test", "POST", { url: replacement }, cookie);
    assert.equal(probe.status, 200); assert.equal((await probe.json()).success, true);
    assert.equal(ledger.rpcConnection, undefined, "Test-only must not persist or switch providers");
    assert.equal((await send("/api/sentinel/rpc", "PUT", { url: "http://127.0.0.1" }, cookie)).status, 400);
    assert.equal(ledger.rpcConnection, undefined);
    genesis = "wrong-network";
    assert.equal((await send("/api/sentinel/rpc", "PUT", { url: replacement }, cookie)).status, 400);
    assert.equal(ledger.rpcConnection, undefined);
    genesis = SOLANA_MAINNET_GENESIS;
    const saved = await send("/api/sentinel/rpc", "PUT", { url: replacement }, cookie);
    assert.equal(saved.status, 200);
    const savedStatus = await saved.json();
    assert.equal(savedStatus.source, "app");
    assert.equal(savedStatus.websocketAlerts, true, "a validated custom HTTPS host is supported through the pinned websocket transport");
    assert.match(savedStatus.message, /pinned connections/);
    assert.equal(halted, true);
    assert.equal(ledger.running, false);
    assert.equal(ledger.rpcConnection.encryptedUrl.includes("fixture-private-credential"), false);
    assert.equal(JSON.stringify(ledger).includes("fixture-private-credential"), false);
    const persisted = structuredClone(ledger);
    assert.equal((await (await send("/api/sentinel/rpc", "GET", undefined, cookie)).json()).configured, true);
    assert.deepEqual(ledger.rpcConnection, persisted.rpcConnection);
    assert.equal((await send("/api/sentinel/rpc", "PUT", { url: replacement }, cookie)).status, 200);
    ledger.running = true;
    assert.equal((await send("/api/sentinel/rpc", "DELETE", undefined, cookie)).status, 409);
    assert.equal((await send("/api/sentinel/rpc", "PUT", { url: replacement }, cookie)).status, 409);
    ledger.running = false; ledger.pending = { id: "unfinished" };
    assert.equal((await send("/api/sentinel/rpc", "DELETE", undefined, cookie)).status, 409);
    ledger.pending = null;
    status = 429;
    const failedRevert = await send("/api/sentinel/rpc", "DELETE", undefined, cookie);
    assert.equal(failedRevert.status, 400);
    assert.ok(JSON.stringify(await failedRevert.json()).includes("429"));
    assert.equal(ledger.rpcConnection.encryptedUrl !== null, true, "failed fallback cannot discard working override");
    status = 200;
    const reset = await send("/api/sentinel/rpc", "DELETE", undefined, cookie);
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).source, "environment");
    assert.equal(ledger.rpcConnection.encryptedUrl, null);
    assert.equal(halted, true);
    assert.ok(methods.every(method => ["getGenesisHash", "getBalance", "getSlot"].includes(method)));
  } finally {
    (dns as any).lookup = beforeDns; (https as any).request = beforeRequest;
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await pool.end();
  }
});
