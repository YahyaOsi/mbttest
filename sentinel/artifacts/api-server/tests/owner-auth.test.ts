import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { pool } from "@workspace/db";
import { passwordReady, derivePassword, passwordEqual, passwordEpoch, tokenHash } from "../src/lib/owner-policy";

// Isolated test-process fixtures, NOT workspace secrets. All database calls are
// replaced with an in-memory adapter before importing the real Express app.
const fixture = "fixture-password-not-for-deployment";
process.env.SENTINEL_APP_PASSWORD = fixture;
process.env.SESSION_SECRET = "fixture-session-secret-not-for-deployment-123456";
process.env.SOLANA_TRADING_PRIVATE_KEY = "";
process.env.ENABLE_MAINNET_TRADING = "false";
process.env.SENTINEL_OWNER_USER_ID = "isolated-auth-fixture";
process.env.LOG_LEVEL = "silent";
const sessions = new Map<string, { epoch: string; expires: number }>();
const limits = new Map<string, number>();
(pool as any).query = async (sql: string, params: any[] = []) => {
  if (sql.startsWith("SELECT id FROM sentinel_owner_sessions")) {
    const s = sessions.get(params[0]);
    return { rows: s && s.epoch === params[1] && s.expires > Date.now() ? [{ id: params[0] }] : [] };
  }
  if (sql.startsWith("INSERT INTO sentinel_login_limits")) {
    const attempts = (limits.get(params[0]) ?? 0) + 1; limits.set(params[0], attempts);
    return { rows: [{ attempts }] };
  }
  if (sql.startsWith("DELETE FROM sentinel_login_limits")) {
    if (params[0]) limits.delete(params[0]);
    return { rows: [] };
  }
  if (sql.startsWith("INSERT INTO sentinel_owner_sessions")) {
    sessions.set(params[0], { epoch: params[1], expires: +params[2] }); return { rows: [] };
  }
  if (sql.startsWith("DELETE FROM sentinel_owner_sessions")) {
    if (sql.includes("epoch!=$1")) {
      for (const [id, s] of sessions) if (s.epoch !== params[0] || s.expires <= Date.now() || id === params[1]) sessions.delete(id);
    } else sessions.delete(params[0]);
    return { rows: [] };
  }
  if (sql.startsWith("INSERT INTO trading_accounts")) return { rows: [] };
  if (sql.startsWith("SELECT state FROM trading_accounts")) return { rows: [{ state: {
    version: 2, settings: { mode: "paper" }, positions: [], candidates: [], assessments: {}, activity: [],
    equity: [], cooldowns: {}, cashSol: null, scanned: 0,
  } }] };
  throw new Error("Unexpected SQL in isolated authentication test.");
};
const { default: app } = await import("../src/app");

test("password derivation, constant-time comparison and rotation fingerprints", async () => {
  assert.equal(passwordReady("short", "s".repeat(32)), false);
  assert.equal(passwordReady(fixture, "short"), false);
  assert.equal(passwordReady(fixture, "s".repeat(32)), true);
  const expected = await derivePassword(fixture, "fixture-salt");
  assert.equal(passwordEqual(await derivePassword(fixture, "fixture-salt"), expected), true);
  assert.equal(passwordEqual(await derivePassword("wrong", "fixture-salt"), expected), false);
  assert.notEqual(passwordEpoch(fixture, "fixture-a"), passwordEpoch(fixture, "fixture-b"));
  assert.notEqual(tokenHash("cookie-a"), tokenHash("cookie-b"));
});
test("real Express auth routes enforce lock, origin, sessions, revocation and rate limits", async () => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const origin = `https://127.0.0.1:${address.port}`;
  const request = (path: string, options: RequestInit = {}) => fetch(base + path, options);
  const login = (password: string) => request("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ password }),
  });
  try {
    assert.equal((await request("/api/sentinel/dashboard")).status, 401);
    assert.equal((await request("/api/sentinel/candidates")).status, 401);
    assert.equal((await request("/api/sentinel/rpc")).status, 401);
    assert.equal((await request("/api/sentinel/rpc/test", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://rpc-provider.example.org/?key=fixture" }) })).status, 401);
    assert.equal((await request("/api/sentinel/settings", { headers: { Authorization: "Bearer old-clerk-token" } })).status, 401);
    assert.equal((await request("/api/auth/session")).headers.get("cache-control"), "no-store");
    assert.equal((await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: fixture }) })).status, 403);
    assert.equal((await login("incorrect")).status, 401);
    const unlocked = await login(fixture);
    assert.equal(unlocked.status, 200);
    const setCookie = unlocked.headers.get("set-cookie")!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=None", "Partitioned", "Path=/api"]) assert.ok(setCookie.includes(flag));
    assert.equal(setCookie.includes(fixture), false);
    const cookie = setCookie.split(";")[0];
    assert.equal((await (await request("/api/auth/session", { headers: { Cookie: cookie } })).json()).authenticated, true);
    assert.equal((await request("/api/sentinel/rpc/test", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://rpc-provider.example.org/?key=fixture" }) })).status, 403);
    const rpcStatus = await request("/api/sentinel/rpc", { headers: { Cookie: cookie } });
    assert.equal(rpcStatus.status, 200);
    assert.equal(JSON.stringify(await rpcStatus.json()).includes("rpc-provider.example.org"), false);
    assert.equal((await request("/api/sentinel/connections", { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: "https://attacker.invalid" } })).status, 403);
    assert.equal((await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status, 200);
    assert.equal((await request("/api/sentinel/connections", { headers: { Cookie: cookie } })).status, 401);
    const rotated = (await login(fixture)).headers.get("set-cookie")!.split(";")[0];
    process.env.SENTINEL_APP_PASSWORD = fixture + "-rotated";
    assert.equal((await request("/api/sentinel/connections", { headers: { Cookie: rotated } })).status, 401);
    process.env.SENTINEL_APP_PASSWORD = fixture;
    const expiring = (await login(fixture)).headers.get("set-cookie")!.split(";")[0];
    for (const s of sessions.values()) s.expires = 0;
    assert.equal((await request("/api/sentinel/connections", { headers: { Cookie: expiring } })).status, 401);
    limits.clear();
    for (let i = 0; i < 12; i++) assert.equal((await login("bad")).status, 401);
    const blocked = await login(fixture);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "900");
    process.env.SENTINEL_APP_PASSWORD = "";
    assert.equal((await (await request("/api/auth/session")).json()).configured, false);
    assert.equal((await login(fixture)).status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await pool.end();
  }
});
