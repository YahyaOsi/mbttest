import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  unpackMint, getExtensionTypes, ExtensionType, type Mint,
} from "@solana/spl-token";

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
export function validateMintTlv(data: Buffer): void {
  const seen = new Set<number>();
  for (let offset = 0; offset < data.length;) {
    // Zero padding is valid; a partial or truncated nonzero TLV is not.
    if (data.subarray(offset).every(byte => byte === 0)) return;
    if (offset + 4 > data.length) throw new Error("Truncated Token-2022 TLV header.");
    const type = data.readUInt16LE(offset), size = data.readUInt16LE(offset + 2);
    if (!type || seen.has(type) || offset + 4 + size > data.length)
      throw new Error("Invalid, duplicate or truncated Token-2022 extension.");
    seen.add(type);
    if (type === ExtensionType.MetadataPointer && size !== 64)
      throw new Error("Invalid metadata pointer length.");
    if (type === ExtensionType.TokenMetadata && size < 80)
      throw new Error("Invalid token metadata length.");
    offset += 4 + size;
  }
}
export function assertSupportedMint(mint: Mint): void {
  if (!mint.isInitialized || mint.mintAuthority || mint.freezeAuthority) throw new Error("Uninitialized mint or active mint/freeze authority.");
  if (mint.supply <= 0n || !Number.isInteger(mint.decimals) || mint.decimals > 12) throw new Error("Invalid supply or unsupported decimals.");
  const benign = new Set([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
  validateMintTlv(mint.tlvData);
  for (const extension of getExtensionTypes(mint.tlvData)) {
    if (!benign.has(extension)) throw new Error(`Unsupported Token-2022 extension (${extension}). Transfer fees, hooks, delegates, restrictions and unknown extensions are blocked.`);
  }
}
export function decodeSupportedMint(address: PublicKey, account: AccountInfo<Buffer> | null) {
  if (!account || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(account.owner.toBase58())) {
    throw new Error("Only SPL Token and supported Token-2022 mints are allowed.");
  }
  const mint = unpackMint(address, account, account.owner);
  assertSupportedMint(mint);
  return { mint, program: account.owner };
}
export function tokenAddress(owner: PublicKey, mint: PublicKey, program = TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}
export function allowedTokenInstruction(opcode: number) {
  return [1, 3, 9, 12, 16, 17, 18].includes(opcode);
}
