import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ExtensionType, MintLayout, getAssociatedTokenAddressSync, type Mint } from "@solana/spl-token";
import { dexCandidate, jupiterCandidate, jupiterEvidence, discoveryMints, validMint } from "../src/lib/sentinel/discovery-policy";
import { assertSupportedMint, decodeSupportedMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, tokenAddress, allowedTokenInstruction } from "../src/lib/sentinel/token-policy";

const mint = Keypair.generate().publicKey.toBase58();
const token = {
  id: mint, name: "A non-memecoin", symbol: "USDC", launchpad: "bags",
  tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), usdPrice: 1, liquidity: 50000,
  firstPool: { createdAt: new Date(Date.now() - 86400000).toISOString() },
  stats24h: { buyVolume: 200000, sellVolume: 100000 },
  stats5m: { numBuys: 50, numSells: 20 }, updatedAt: new Date().toISOString(),
};
test("mint identity, not symbols or suffixes, selects Solana tokens", () => {
  assert.equal(validMint(mint), true);
  assert.equal(validMint("z".repeat(44)), false);
  assert.equal(validMint(undefined), false);
  const c = jupiterCandidate(token)!;
  assert.equal(c.mint, mint);
  assert.equal(c.launchpad, "bags");
  assert.equal(c.volume24hUsd, 300000);
  assert.equal(c.tokenProgram, TOKEN_2022_PROGRAM_ID.toBase58());
  assert.ok(c.ageMinutes > 1000);
  assert.equal(jupiterEvidence({ id: mint }).launchpad, null);
  assert.equal(jupiterEvidence({ audit: { isSus: false } }).flaggedSuspicious, true);
});
test("no fresh timestamp or known pool age is invented from incomplete Jupiter data", () => {
  const c = jupiterCandidate({ ...token, updatedAt: null, firstPool: null })!;
  assert.equal(c.updatedAt, new Date(0).toISOString());
  assert.equal(c.ageMinutes, 0);
});
test("DEX candidate mapping excludes other chains and normalizes malformed numeric data", () => {
  const pair = { chainId: "solana", baseToken: { address: mint, symbol: "SOL" }, priceUsd: "1", dexId: "pumpswap", liquidity: { usd: "NaN" } };
  assert.equal(dexCandidate({ ...pair, chainId: "ethereum" }), null);
  const c = dexCandidate(pair)!;
  assert.equal(c.mint, mint);
  assert.equal(c.venue, "pumpswap");
  assert.equal(c.liquidityUsd, 0);
  assert.equal(c.launchpad, null);
});
test("feed interleaving deduplicates mints without excluding launchpads or starving sources", () => {
  const b = Keypair.generate().publicKey.toBase58();
  const c = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(discoveryMints([[mint, b], [mint, c]], 3), [mint, b, c]);
});
function mintWith(extensions: number[] = []): Mint {
  const buffers = extensions.map(type => {
    const size = type === ExtensionType.MetadataPointer ? 64 : type === ExtensionType.TokenMetadata ? 80 : 0;
    const buffer = Buffer.alloc(4 + size);
    buffer.writeUInt16LE(type); buffer.writeUInt16LE(size, 2); return buffer;
  });
  return { mintAuthority: null, freezeAuthority: null, isInitialized: true, supply: 1000n, decimals: 6, tlvData: Buffer.concat(buffers) } as Mint;
}
test("only metadata-only Token-2022 extensions are admitted", () => {
  assert.doesNotThrow(() => assertSupportedMint(mintWith()));
  assert.doesNotThrow(() => assertSupportedMint(mintWith([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata])));
  for (const extension of [
    ExtensionType.TransferFeeConfig, ExtensionType.TransferHook, ExtensionType.PermanentDelegate,
    ExtensionType.DefaultAccountState, ExtensionType.NonTransferable, 60000,
  ]) assert.throws(() => assertSupportedMint(mintWith([extension])));
  assert.throws(() => assertSupportedMint({ ...mintWith(), freezeAuthority: Keypair.generate().publicKey }));
  assert.throws(() => assertSupportedMint({ ...mintWith(), mintAuthority: Keypair.generate().publicKey }));
  assert.throws(() => assertSupportedMint({ ...mintWith(), isInitialized: false }));
});
test("Token-2022 ATA derivation differs from SPL; approvals and extension instructions remain forbidden", () => {
  const owner = Keypair.generate().publicKey, key = Keypair.generate().publicKey;
  assert.notEqual(tokenAddress(owner, key, TOKEN_PROGRAM_ID).toBase58(), tokenAddress(owner, key, TOKEN_2022_PROGRAM_ID).toBase58());
  assert.equal(tokenAddress(owner, key, TOKEN_2022_PROGRAM_ID).toBase58(), getAssociatedTokenAddressSync(key, owner, false, TOKEN_2022_PROGRAM_ID).toBase58());
  assert.equal(allowedTokenInstruction(12), true);
  for (const forbidden of [4, 5, 6, 13, 26, 255]) assert.equal(allowedTokenInstruction(forbidden), false);
});
test("raw mint decoding enforces actual program ownership and initialized state", () => {
  const data = Buffer.alloc(82);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  const account = { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 };
  const address = new PublicKey(mint);
  assert.equal(decodeSupportedMint(address, account).program.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(decodeSupportedMint(address, { ...account, owner: TOKEN_2022_PROGRAM_ID }).program.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.throws(() => decodeSupportedMint(address, { ...account, owner: PublicKey.default }));
  assert.throws(() => decodeSupportedMint(address, null));
});
