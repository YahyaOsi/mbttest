import { PublicKey } from "@solana/web3.js";
import { Moonit, Environment } from "@moonit/sdk";

/** Official Solana SDK 1.5.0 IDL. Never infer this identity from branding. */
export const MOONIT_PROGRAM = new PublicKey("MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG");
export const MOONIT_CONFIG = PublicKey.findProgramAddressSync([Buffer.from("config_account")], MOONIT_PROGRAM)[0];
export const MOONIT_HELIO_FEE = new PublicKey("5K5RtTWzzLp4P8Npi84ocf7F1vBsAu29N1irG4iiUnzt");
export const MOONIT_DEX_FEE = new PublicKey("3udvfL24waJcLhskRAsStNMoNUvtyXdxrWQz4hgi953N");
export const moonitCurveAddress = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("token"), mint.toBuffer()], MOONIT_PROGRAM);
let sdk: Moonit | undefined;
/** SDK is used ONLY for local IDL decoding, pure math and instruction building.
 * Its connection is deliberately unusable: all network evidence uses our pinned
 * server RPC, never the SDK's API, provider connection or transaction submitter. */
export function moonitSdk() {
  return sdk ??= new Moonit({ rpcUrl: "https://moonit-offline.invalid", environment: Environment.MAINNET });
}
export function isMoonitTrade(data: Uint8Array, buy: boolean, input: bigint, minimum: bigint) {
  const b = Buffer.from(data);
  const tag = buy ? [102, 6, 61, 18, 1, 218, 235, 234] : [51, 230, 133, 164, 1, 127, 131, 173];
  return b.length === 33 && b.subarray(0, 8).equals(Buffer.from(tag)) &&
    b[24] === 0 && b.readBigUInt64LE(25) === 0n &&
    b.readBigUInt64LE(buy ? 16 : 8) === input && b.readBigUInt64LE(buy ? 8 : 16) >= minimum;
}
