import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { SOLANA_MAINNET_GENESIS } from "../src/lib/sentinel/network-policy";
import { sealRpc, unsealRpc, syncRpcConfig, rpcEndpoint, rpcIsOverride, rpcConfigProblem } from "../src/lib/sentinel/rpc-config";
import { parseRpcUrl, publicRpcAddress, rpcFailureMessage, rpcWebsocketsAllowed, testRpcEndpoint } from "../src/lib/sentinel/rpc-endpoint";

test("RPC secrets are encrypted, owner-bound, tamper evident and never silently fall back", () => {
  process.env.SESSION_SECRET = "isolated-test-key-only-not-a-workspace-secret-012345";
  process.env.SOLANA_RPC_URL = "https://fallback.rpc.example.com";
  const url = "https://mainnet.helius-rpc.com/?api-key=fixture-only-not-real";
  try {
    const encryptedUrl = sealRpc(url, "fixture-owner");
    assert.ok(!encryptedUrl.includes("fixture-only") && !encryptedUrl.includes("helius"));
    assert.equal(unsealRpc(encryptedUrl, "fixture-owner"), url);
    assert.throws(() => unsealRpc(encryptedUrl, "another-owner"));
    const parts = encryptedUrl.split(".");
    parts[1] = (parts[1][0] === "A" ? "B" : "A") + parts[1].slice(1);
    assert.throws(() => unsealRpc(parts.join("."), "fixture-owner"));
    const stored = { encryptedUrl, updatedAt: new Date().toISOString() };
    syncRpcConfig(stored, "fixture-owner");
    assert.equal(rpcEndpoint(), url);
    assert.equal(rpcIsOverride(), true);
    const persisted = JSON.parse(JSON.stringify(stored));
    syncRpcConfig(persisted, "fixture-owner");
    assert.equal(rpcEndpoint(), url);
    process.env.SESSION_SECRET = "rotated-key-only-not-the-old-value-012345";
    syncRpcConfig({ ...stored, updatedAt: new Date(Date.now() + 1000).toISOString() }, "fixture-owner");
    assert.match(rpcConfigProblem()!, /cannot be decrypted/);
    assert.throws(() => rpcEndpoint(), /cannot be decrypted/);
    syncRpcConfig({ encryptedUrl: null, updatedAt: new Date(Date.now() + 2000).toISOString() }, "fixture-owner");
    assert.equal(rpcEndpoint(), process.env.SOLANA_RPC_URL);
  } finally {
    // Fixture process is isolated per test file. Do not read or restore any
    // ambient workspace secret value in order to run this test.
  }
});
test("RPC URL policy rejects SSRF endpoints and treats provider 429 as a safe message", () => {
  for (const u of ["http://mainnet.helius-rpc.com", "https://localhost/rpc", "https://127.0.0.1",
    "https://[::1]", "https://user:pass@rpc.example.com", "https://rpc.example.com:8080",
    "https://rpc.example.com/#secret", "https://internal", "https://rpc.example.com/\nmetadata"]) {
    assert.throws(() => parseRpcUrl(u), undefined, u);
  }
  for (const ip of ["127.0.0.1", "10.0.0.2", "169.254.169.254", "172.20.0.2",
    "192.168.1.2", "100.64.1.1", "192.0.0.1", "::ffff:127.0.0.1", "198.18.0.1"]) {
    assert.equal(publicRpcAddress(ip), false, ip);
  }
  assert.equal(publicRpcAddress("8.8.8.8"), true);
  assert.equal(rpcWebsocketsAllowed("https://node.quiknode.pro/some-key"), true);
  assert.equal(rpcWebsocketsAllowed("https://unknown-public.example.org/rpc"), false);
  assert.match(rpcFailureMessage(new Error("RPC URL with supersecret credential returned 429")), /rate limit/);
  assert.ok(!rpcFailureMessage(new Error("RPC URL with supersecret credential returned 429")).includes("supersecret"));
});
test("connection test performs only read-only mainnet genesis, balance and slot RPC, without saving", async () => {
  const beforeDns = dns.lookup, beforeRequest = https.request;
  const methods: string[] = [];
  (dns as any).lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  let genesis = SOLANA_MAINNET_GENESIS, status = 200, rpcError: { code: number; message: string } | null = null;
  let transportCode: string | null = null;
  (https as any).request = (_url: URL, options: { lookup: Function; family: number }, callback: (res: any) => void) => {
    assert.equal(options.family, 4);
    options.lookup("ignored-name.example.org", { all: true }, (error: unknown, addresses: unknown) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }], "Node all:true requires an address array");
    });
    options.lookup("ignored-name.example.org", { all: false }, (error: unknown, address: unknown, family: unknown) => {
      assert.equal(error, null); assert.equal(address, "93.184.216.34"); assert.equal(family, 4);
    });
    const request: any = new EventEmitter();
    request.end = (body: string) => {
      if (transportCode) {
        const error = Object.assign(new Error("fixture-private-url-must-not-escape"), { code: transportCode });
        request.emit("error", error);
        return;
      }
      const q = JSON.parse(body); methods.push(q.method);
      const reply: any = new EventEmitter(); reply.statusCode = status;
      callback(reply);
      const result = q.method === "getGenesisHash" ? genesis
        : q.method === "getBalance" ? { context: { slot: 1 }, value: 0 } : 1;
      reply.emit("data", Buffer.from(JSON.stringify(rpcError
        ? { jsonrpc: "2.0", id: q.id, error: rpcError }
        : { jsonrpc: "2.0", id: q.id, result })));
      reply.emit("end");
    };
    request.destroy = () => {};
    return request;
  };
  try {
    const url = "https://rpc-provider.example.org/secure?api-key=fixture-only";
    assert.equal(await testRpcEndpoint(url), url);
    assert.deepEqual(methods, ["getGenesisHash", "getBalance", "getSlot"]);
    genesis = "not-mainnet"; methods.length = 0;
    await assert.rejects(testRpcEndpoint(url), /not Solana mainnet/);
    assert.deepEqual(methods, ["getGenesisHash"], "do not continue testing a wrong network");
    genesis = SOLANA_MAINNET_GENESIS; methods.length = 0;
    rpcError = { code: -32001, message: "Invalid API key: fake-never-real-secret" };
    await assert.rejects(testRpcEndpoint(url), error => {
      const message = rpcFailureMessage(error);
      assert.match(message, /HTTP 401/);
      assert.match(message, /mainnet genesis check/);
      assert.ok(!message.includes("fake-never-real-secret"));
      return true;
    });
    rpcError = { code: -32005, message: "daily quota exceeded, fake-never-real-secret" };
    await assert.rejects(testRpcEndpoint(url), error => {
      const message = rpcFailureMessage(error);
      assert.match(message, /quota/);
      assert.ok(!message.includes("fake-never-real-secret"));
      return true;
    });
    rpcError = null;
    transportCode = "ERR_TLS_CERT_ALTNAME_INVALID";
    await assert.rejects(testRpcEndpoint(url), error => {
      const message = rpcFailureMessage(error);
      assert.match(message, /TLS connection failed/);
      assert.ok(!message.includes("fixture-private-url"));
      return true;
    });
    transportCode = null;
    status = 429;
    await assert.rejects(testRpcEndpoint(url), /429/);
  } finally {
    (dns as any).lookup = beforeDns; (https as any).request = beforeRequest;
  }
});
