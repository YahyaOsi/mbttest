import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import type { Settings } from "./types";

// Fixed documented public mainnet service: no arbitrary URL or credential input.
const endpoint = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
let tips: { at: number; keys: string[] } | undefined;
async function call(method: string, params: unknown[], transport = fetch) {
  const r = await transport(endpoint, { method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(1500),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!r.ok) throw new Error("Jito unavailable");
  const result = await r.json() as { result?: unknown; error?: unknown };
  if (result.error || !result.result) throw new Error("Jito response unavailable");
  return result.result;
}
export function cappedTip(settings: Settings, principal: bigint, priorityLamports: number) {
  const relative = principal * BigInt(Math.floor((settings.jitoMaxTipPct ?? 0.25) * 10000)) / 1_000_000n;
  const cap = Math.min(Number(relative), settings.jitoMaxTipLamports ?? 100000);
  return cap < 1000 ? 0 : Math.floor(Math.min(cap, Math.max(1000, priorityLamports / 4)));
}
export async function tipAccount() {
  if (!tips || Date.now() - tips.at > 3600000) {
    const keys = await call("getTipAccounts", []);
    if (!Array.isArray(keys) || !keys.length || keys.length > 32 ||
      keys.some(k => typeof k !== "string" || !PublicKey.isOnCurve(new PublicKey(k).toBytes()))) throw new Error("Invalid Jito tip accounts");
    tips = { at: Date.now(), keys };
  }
  return new PublicKey(tips.keys[Math.floor(Math.random() * tips.keys.length)]);
}
export function appendTip(tx: VersionedTransaction, tables: AddressLookupTableAccount[], payer: PublicKey, recipient: PublicKey, lamports: number) {
  if (tx.signatures.some(s => s.some(Boolean)) || !Number.isSafeInteger(lamports) || lamports < 1000) throw new Error("Invalid unsigned tip");
  const m = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  m.instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports }));
  return new VersionedTransaction(m.compileToV0Message(tables));
}
export async function sendJitoBundle(bytes: Uint8Array, transport = fetch): Promise<string> {
  const id = await call("sendBundle", [[Buffer.from(bytes).toString("base64")], { encoding: "base64" }], transport);
  if (typeof id !== "string" || !/^[a-zA-Z0-9]{32,128}$/.test(id)) throw new Error("Jito bundle identifier unavailable");
  return id;
}
