import dns from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { Connection, SystemProgram } from "@solana/web3.js";
import { isSolanaMainnet } from "./network-policy";

export class RpcInputError extends Error {}
class RpcProbeError extends Error {
  constructor(readonly step: string, readonly httpStatus?: number, readonly providerCode?: number, readonly transport?: string) {
    super(`RPC_VERIFY_FAILED_${httpStatus ?? providerCode ?? transport ?? "UNKNOWN"}`);
  }
}
function probeError(step: string, cause: unknown): RpcProbeError {
  const chain: { message?: unknown; code?: unknown; cause?: unknown; name?: unknown }[] = [];
  let next = cause as { message?: unknown; code?: unknown; cause?: unknown; name?: unknown } | null;
  for (let i = 0; next && i < 4; i++, next = next.cause as typeof next) chain.push(next);
  const message = chain.map(e => typeof e.message === "string" ? e.message : "").join(" ");
  const httpMatch = message.match(/\b(401|403|404|429|5\d\d)\b/);
  let providerCode: number | undefined, transport: string | undefined;
  for (const e of chain) {
    if (!providerCode && typeof e.code === "number") providerCode = e.code;
    if (!providerCode && typeof e.code === "string" && /^-?\d{1,9}$/.test(e.code)) providerCode = Number(e.code);
    if (!transport && typeof e.message === "string") transport = e.message.match(/\bRPC_TRANSPORT_(TIMEOUT|TLS|DNS|NETWORK)\b/)?.[1];
    if (!transport && typeof e.code === "string" && /^ERR_TLS/.test(e.code)) transport = "TLS";
    if (!transport && typeof e.code === "string" && /^(ETIMEDOUT|ESOCKETTIMEDOUT)$/.test(e.code)) transport = "TIMEOUT";
    if (!transport && (e.name === "AbortError" || e.name === "TimeoutError")) transport = "TIMEOUT";
  }
  if (/\b(invalid|missing)\s+(?:helius\s+)?(?:api[- ]?)?key\b|unauthori[sz]ed|access denied|permission denied/i.test(message))
    return new RpcProbeError(step, 401);
  if (!transport && /rate.?limit|daily quota|compute units per second|too many requests/i.test(message)) return new RpcProbeError(step, 429);
  return new RpcProbeError(step, httpMatch ? Number(httpMatch[1]) : undefined, providerCode, transport);
}
async function probe<T>(step: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof RpcInputError) throw error;
    if (error instanceof RpcProbeError) throw error;
    throw probeError(step, error);
  }
}
export function parseRpcUrl(input: string) {
  if (input.length > 4096 || input !== input.trim() || /[\r\n]/.test(input)) throw new RpcInputError("Enter a valid HTTPS RPC URL, without surrounding spaces.");
  let url: URL;
  try { url = new URL(input); } catch { throw new RpcInputError("Enter a valid HTTPS RPC URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443" ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes(".") ||
      /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(url.hostname)) {
    throw new RpcInputError("Use a public HTTPS RPC hostname on port 443. IP addresses, local hosts, URL passwords and fragments are not accepted.");
  }
  return url;
}
export function publicRpcAddress(address: string) {
  // Fail closed on IPv6 rather than accidentally admitting IPv4-mapped,
  // link-local, transition or private ranges. Providers normally publish A records.
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) ||
    a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0);
}
export async function validateRpcHost(url: URL) {
  let rows;
  try { rows = await dns.lookup(url.hostname, { all: true, family: 4 }); }
  catch { throw new RpcInputError("RPC hostname could not be resolved to a public IPv4 address."); }
  if (!rows.length || rows.some(row => !publicRpcAddress(row.address))) throw new RpcInputError("RPC hostname resolves to a blocked or private network.");
  return rows[0];
}
/** Custom hosts get DNS-pinned HTTPS, bounded bodies and NO redirects. */
export async function safeRpcFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = parseRpcUrl(String(input)), ip = await validateRpcHost(url);
  return new Promise((resolve, reject) => {
    const fail = (error?: unknown) => {
      const e = error as { code?: unknown; name?: unknown } | null;
      const code = typeof e?.code === "string" ? e.code : "";
      const transport = code.startsWith("ERR_TLS") ? "TLS"
        : /^(ETIMEDOUT|ESOCKETTIMEDOUT)$/.test(code) || e?.name === "AbortError" || e?.name === "TimeoutError" ? "TIMEOUT"
          : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "DNS" : "NETWORK";
      reject(new Error(`RPC_TRANSPORT_${transport}`));
    };
    const request = https.request(url, {
      method: "POST", family: 4, headers: Object.fromEntries(new Headers(init?.headers).entries()),
      signal: init?.signal ?? AbortSignal.timeout(12000),
      // Modern Node may request all:true for autoSelectFamily. Returning the
      // single-address overload in that mode causes ERR_INVALID_IP_ADDRESS.
      // Honor both callback shapes using only the already validated, pinned IP.
      lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [{ address: ip.address, family: 4 }]);
        else callback(null, ip.address, 4);
      }) as any,
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { request.destroy(); fail(); } else chunks.push(chunk);
      });
      response.on("error", e => fail(e));
      response.on("end", () => {
        const status = response.statusCode ?? 502;
        // Never forward upstream bodies containing credentials/URLs into SDK errors.
        if (status < 200 || status >= 300) {
          resolve(new Response(JSON.stringify({ error: "RPC request refused" }), { status: status >= 300 && status < 400 ? 502 : status }));
        } else resolve(new Response(Buffer.concat(chunks), { status, headers: { "Content-Type": "application/json" } }));
      });
    });
    request.on("error", e => fail(e));
    request.end(typeof init?.body === "string" ? init.body : "");
  });
}
/** Only provider-controlled domains use the SDK's unpinned websocket path.
 * Other saved RPC hosts must use PinnedRpcLogSubscriptions after DNS validation. */
export function rpcWebsocketsAllowed(endpoint: string) {
  const host = new URL(endpoint).hostname;
  return ["api.mainnet-beta.solana.com", "rpc.ankr.com", "solana-rpc.publicnode.com", "mainnet.helius-rpc.com"].includes(host) ||
    [".quiknode.pro", ".helius-rpc.com", ".g.alchemy.com", ".rpcpool.com", ".chainstack.com", ".drpc.org"].some(suffix => host.endsWith(suffix));
}
export function rpcFailureMessage(error: unknown) {
  if (error instanceof RpcInputError) return error.message;
  if (error instanceof RpcProbeError) {
    if (error.httpStatus === 429) return `Helius/RPC rate limit or daily quota reached during the ${error.step} (HTTP 429). Check the Helius usage page, then retry after its reset.`;
    if (error.httpStatus === 401 || error.httpStatus === 403) return `Helius/RPC rejected the ${error.step} (HTTP ${error.httpStatus}). Check that this is the HTTPS Mainnet RPC URL, that its API key is valid, and that the project has RPC access enabled.`;
    if (error.httpStatus === 404) return `The ${error.step} URL returned HTTP 404. Use the HTTPS RPC endpoint from your Helius Mainnet project, not a dashboard or REST URL.`;
    if (error.httpStatus && error.httpStatus >= 500) return `Helius/RPC is temporarily unavailable during the ${error.step} (HTTP ${error.httpStatus}). Wait briefly, then test again.`;
    if (error.transport === "DNS") return `The RPC hostname could not be resolved during the ${error.step}. Check the hostname and retry.`;
    if (error.transport === "TLS") return `The HTTPS/TLS connection failed during the ${error.step}. Check the exact HTTPS RPC URL and retry.`;
    if (error.transport === "TIMEOUT") return `Helius/RPC timed out during the ${error.step}. Check provider status or retry shortly.`;
    if (error.providerCode) return `Helius/RPC rejected the ${error.step} (JSON-RPC error ${error.providerCode}). Check the Mainnet endpoint and RPC access in Helius.`;
    return `Helius/RPC could not complete the ${error.step}. Check the Mainnet RPC endpoint and provider status, then retry.`;
  }
  const message = error instanceof Error ? error.message : "";
  if (/\b429\b/.test(message)) return "RPC rate limit or daily quota reached (HTTP 429). Wait for the provider reset or use another endpoint.";
  if (/\b(401|403)\b/.test(message)) return "RPC access denied. Check the provider API key and endpoint permissions.";
  return "RPC unavailable, unsupported, or timed out. No endpoint was changed and no trade was authorized.";
}
export async function testRpcEndpoint(input: string) {
  const url = parseRpcUrl(input);
  await validateRpcHost(url);
  const connection = new Connection(url.href, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: safeRpcFetch });
  const genesis = await probe("mainnet genesis check", () => connection.getGenesisHash());
  if (!isSolanaMainnet(genesis)) throw new RpcInputError("This endpoint is not Solana mainnet-beta. It was not saved.");
  await probe("balance check", () => connection.getBalance(SystemProgram.programId));
  await probe("slot check", () => connection.getSlot());
  return url.href;
}
