import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export type SavedRpc = { encryptedUrl: string | null; updatedAt: string };
let active: { owner: string; saved?: SavedRpc; url: string | null; urls: string[]; error: boolean } | undefined;
let generation = 0;
function key() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error("RPC encryption is unavailable. Configure a strong SESSION_SECRET.");
  return Buffer.from(hkdfSync("sha256", process.env.SESSION_SECRET, "sentinel-rpc-v1", "endpoint-encryption", 32));
}
export function sealRpc(url: string, owner: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(`sentinel:rpc:${owner}`));
  const data = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
export function unsealRpc(value: string, owner: string): string {
  const [version, iv, tag, encrypted, extra] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted || extra) throw new Error("Invalid encrypted RPC configuration.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(`sentinel:rpc:${owner}`)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
/** Loaded at owner ledger boundaries; encrypted configuration is never a response field. */
export function syncRpcConfig(saved: SavedRpc | undefined, owner: string) {
  if (active?.owner === owner && Date.parse(active.saved?.updatedAt ?? "") > Date.parse(saved?.updatedAt ?? "1970-01-01")) return;
  if (active?.owner === owner && active.saved?.encryptedUrl === saved?.encryptedUrl && active.saved?.updatedAt === saved?.updatedAt) return;
  let url: string | null = null, urls: string[] = [], error = false;
  if (saved?.encryptedUrl) {
    try {
      const text = unsealRpc(saved.encryptedUrl, owner);
      urls = text.startsWith("[") ? JSON.parse(text) : [text];
      if (!Array.isArray(urls) || !urls.length || urls.length > 6 || urls.some(u => typeof u !== "string" || !u.startsWith("https://"))) throw new Error();
      url = urls[0];
    } catch { error = true; urls = []; }
  }
  active = { owner, saved, url, urls, error }; generation++;
}
export function environmentRpcEndpoints() {
  const numbered = Array.from({ length: 6 }, (_, i) => process.env[`RPC_URL_${i + 1}`]).filter((u): u is string => !!u);
  return [...new Set(numbered.length ? numbered : process.env.SOLANA_RPC_URL ? [process.env.SOLANA_RPC_URL] : [])];
}
export function rpcEndpoints() {
  if (active?.error) throw new Error("Saved RPC cannot be decrypted. Re-enter it in Setup; no fallback was selected.");
  const urls = active?.urls.length ? active.urls : environmentRpcEndpoints();
  return (urls.length ? urls : ["https://api.mainnet-beta.solana.com"]).map((url, i) => ({ id: `RPC ${i + 1}`, url, pinned: rpcIsOverride() }));
}
export function rpcEndpoint() {
  if (active?.error) throw new Error("Saved RPC cannot be decrypted. Re-enter it in Setup; no fallback was selected.");
  return rpcEndpoints()[0].url;
}
export function rpcIsOverride() { return !!active?.saved?.encryptedUrl; }
export function hasDedicatedRpc() { return !!(active?.url || environmentRpcEndpoints().length) && !active?.error; }
export function rpcGeneration() { return generation; }
export function rpcConfigProblem() { return active?.error ? "Saved RPC cannot be decrypted. Re-enter it in Setup." : null; }
export function rpcEncryptionReady() { try { key(); return true; } catch { return false; } }
