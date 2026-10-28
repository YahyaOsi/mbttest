import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MintLayout, MINT_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountType, ExtensionType } from "@solana/spl-token";
import { pumpCurveAddress } from "../src/lib/sentinel/curve-policy";
import { SOL } from "../src/lib/sentinel/discovery-policy";
import { checkLivePumpMints, inspectLiveMint, livePumpActivity, livePumpBurst, livePumpHint,
  livePumpRecord, livePumpRecords, observeLivePumpMessage, parseLivePumpEvent } from "../src/lib/sentinel/pump-live-feed";

const creation = () => {
  const key = Keypair.generate().publicKey;
  return { txType: "create", mint: key.toBase58(), signature: "3".repeat(88),
    bondingCurveKey: pumpCurveAddress(key).toBase58(), quoteMint: SOL, name: "Test", symbol: "TST" };
};
test("live hints require a canonical curve address and native-SOL market", () => {
  const event = creation();
  assert.equal(parseLivePumpEvent(event)?.type, "create");
  assert.equal(parseLivePumpEvent({ ...event, quoteMint: Keypair.generate().publicKey.toBase58() }), null);
  assert.equal(parseLivePumpEvent({ ...event, bondingCurveKey: Keypair.generate().publicKey.toBase58() }), null);
  assert.equal(parseLivePumpEvent({ ...event, mint: "not-a-mint" }), null);
  assert.equal(parseLivePumpEvent({ type: "error", message: "provider unavailable" }), null);
  assert.equal(parseLivePumpEvent({ ...event, signature: "" }), null);
});
test("fast authority check fails closed for uninitialized, mintable, frozen, unsupported or missing accounts", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const raw = (mintAuthorityOption = 0, freezeAuthorityOption = 0, initialized = true) => {
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode({ mintAuthorityOption, mintAuthority: PublicKey.default, supply: 100_000n, decimals: 6,
      isInitialized: initialized, freezeAuthorityOption, freezeAuthority: PublicKey.default }, data);
    return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 100_000, rentEpoch: 0 };
  };
  assert.equal(inspectLiveMint(mint, raw()), true);
  assert.equal(inspectLiveMint(mint, raw(1)), false);
  assert.equal(inspectLiveMint(mint, raw(0, 1)), false);
  assert.equal(inspectLiveMint(mint, raw(0, 0, false)), false);
  assert.equal(inspectLiveMint(mint, { ...raw(), owner: PublicKey.default }), false);
  assert.throws(() => inspectLiveMint(mint, null), /not yet visible/);
});
test("Token-2022 revoked authorities pass; padded TLVs use SDK extension IDs and fail closed on dangerous or malformed data", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const raw = (extensions: { type: number; size: number; lengthOverride?: number }[] = []) => {
    const data = Buffer.alloc(extensions.length ? 166 + extensions.reduce((n, e) => n + 4 + e.size, 0) : MINT_SIZE);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 100_000n, decimals: 6,
      isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
    if (extensions.length) {
      data[165] = AccountType.Mint;
      let at = 166;
      for (const extension of extensions) {
        data.writeUInt16LE(extension.type, at); data.writeUInt16LE(extension.lengthOverride ?? extension.size, at + 2);
        at += 4 + extension.size;
      }
    }
    return { data, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 100_000, rentEpoch: 0 };
  };
  assert.equal(inspectLiveMint(mint, raw()), true);
  assert.equal(inspectLiveMint(mint, raw([{ type: ExtensionType.MetadataPointer, size: 64 },
    { type: ExtensionType.TokenMetadata, size: 80 }])), true);
  for (const type of [ExtensionType.PermanentDelegate, ExtensionType.DefaultAccountState,
    ExtensionType.TransferFeeConfig, ExtensionType.TransferHook, ExtensionType.NonTransferable, 65535])
    assert.equal(inspectLiveMint(mint, raw([{ type, size: 32 }])), false, `dangerous/unknown extension ${type}`);
  assert.equal(ExtensionType.PermanentDelegate, 12);
  assert.equal(ExtensionType.DefaultAccountState, 6);
  assert.equal(inspectLiveMint(mint, raw([{ type: ExtensionType.MetadataPointer, size: 64, lengthOverride: 200 }])), false);
  assert.equal(inspectLiveMint(mint, raw([{ type: ExtensionType.MetadataPointer, size: 1 }])), false);
  assert.equal(inspectLiveMint(mint, raw([{ type: ExtensionType.MetadataPointer, size: 64 },
    { type: ExtensionType.MetadataPointer, size: 64 }])), false);
  const activeMint = raw(); activeMint.data.writeUInt32LE(1, 0);
  const activeFreeze = raw(); activeFreeze.data.writeUInt32LE(1, 46);
  assert.equal(inspectLiveMint(mint, activeMint), false);
  assert.equal(inspectLiveMint(mint, activeFreeze), false);
});
test("all 245 received mints are queued and checked; duplicates cannot consume more checks", async () => {
  const events = Array.from({ length: 245 }, creation);
  const seen = new Set<string>();
  for (const event of events) { observeLivePumpMessage(event); observeLivePumpMessage(event); }
  assert.equal(events.some(e => !!livePumpHint(e.mint)), false);
  for (let i = 0; i < 50; i++) await checkLivePumpMints(Date.now(), async mint => { seen.add(mint); return true; });
  for (const event of events) assert.equal(seen.has(event.mint), true);
  const retained = new Set(livePumpRecords().map(r => r.mint));
  for (const event of events) assert.equal(retained.has(event.mint), true);
  const hint = livePumpHint(events[0].mint)!;
  const record = livePumpRecord(hint);
  assert.equal(record.createdAt, null, "a third-party notice must never fabricate an on-chain birth time");
  assert.equal(record.slot, 0);
  assert.equal(record.hintOnly, true);
  assert.equal(record.signature, events[0].signature);
});
test("creation alone never becomes a buy signal; duplicate trades and non-PumpSwap filtering are safe", async () => {
  const event = creation();
  observeLivePumpMessage(event);
  await checkLivePumpMints(Date.now(), async () => true);
  assert.equal(livePumpBurst(event.mint), false);
  for (let n = 0; n < 3; n++) {
    const trade = { ...event, txType: "buy", solAmount: 0.01, traderPublicKey: Keypair.generate().publicKey.toBase58(), signature: String(n + 4).repeat(88) };
    observeLivePumpMessage(trade);
    observeLivePumpMessage(trade);
  }
  assert.equal(livePumpActivity(event.mint).count, 3);
  assert.equal(livePumpBurst(event.mint), false, "three buys alone are not a greater-than-3:1 ratio");
  observeLivePumpMessage({ ...event, txType: "buy", solAmount: 0.01, signature: "7".repeat(88) });
  assert.equal(livePumpBurst(event.mint), true);
  observeLivePumpMessage({ ...event, txType: "sell", solAmount: 100, signature: "8".repeat(88), source: "pumpswap" });
  assert.equal(livePumpActivity(event.mint).sells, 0);
  assert.equal(livePumpBurst(event.mint, Date.now() + 11_000), false);
});
test("secondary RPC failures remain queued for retry, and unsafe mints never become live candidates", async () => {
  const event = creation();
  observeLivePumpMessage(event);
  let attempts = 0;
  await checkLivePumpMints(Date.now(), async () => { attempts++; throw new Error("provider rate limited"); });
  assert.equal(attempts, 1);
  assert.equal(livePumpHint(event.mint), undefined);
  await checkLivePumpMints(Date.now() + 20_000, async () => { attempts++; return false; });
  assert.equal(attempts, 2);
  assert.equal(livePumpHint(event.mint), undefined);
});
