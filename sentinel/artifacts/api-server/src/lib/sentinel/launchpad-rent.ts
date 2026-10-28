import { PublicKey, type Connection } from "@solana/web3.js";
import { PUMP_SDK, userVolumeAccumulatorPda, getPumpAmmProgram, canonicalPumpPoolPda } from "@pump-fun/pump-sdk";
import { PUMP_PROGRAM, PUMP_AMM_PROGRAM, pumpCurveAddress } from "./curve-policy";
import { TradingError } from "./store";
import type { walletTokenChanges } from "./transaction-policy";

/** Pump v3 may initialize volume state or extend an old curve. Only the rent
 * shortfall of these two exact PDAs may be excluded from swap principal. */
export async function pumpRentDelta(connection: Connection, owner: PublicKey, mint: PublicKey,
  addresses: PublicKey[], before: Parameters<typeof walletTokenChanges>[4],
  after: Parameters<typeof walletTokenChanges>[5]) {
  let overhead = 0;
  for (const [key, volume] of [[userVolumeAccumulatorPda(owner), true], [pumpCurveAddress(mint), false]] as const) {
    const i = addresses.findIndex(a => a.equals(key));
    if (i < 0 || !after[i]) throw new TradingError("Pump simulation omitted required state accounts.");
    const post = after[i]!, pre = before[i], data = Buffer.from(post.data[0], "base64");
    if (post.owner !== PUMP_PROGRAM.toBase58() || (pre && !pre.owner.equals(PUMP_PROGRAM)) ||
        data.length > 4096) throw new TradingError("Pump rent account owner/layout is unsupported.");
    const raw = { owner: PUMP_PROGRAM, data, lamports: post.lamports, executable: false, rentEpoch: 0 };
    if (volume) {
      if (!PUMP_SDK.decodeUserVolumeAccumulator(raw).user.equals(owner)) throw new TradingError("Pump volume account authority mismatch.");
    } else PUMP_SDK.decodeBondingCurve(raw);
    if (!pre || pre.data.length !== data.length) {
      const rent = await connection.getMinimumBalanceForRentExemption(data.length);
      const shortfall = Math.max(0, rent - (pre?.lamports ?? 0));
      if (volume && post.lamports !== (pre?.lamports ?? 0) + shortfall) throw new TradingError("Unexpected volume-account funding.");
      overhead += shortfall;
    } else if (volume && pre.lamports !== post.lamports) throw new TradingError("Unexpected volume-account lamport movement.");
  }
  return overhead;
}

/** Only exact PumpSwap PDAs with locally decoded layouts can count as rent.
 * A Jupiter route cannot disguise arbitrary SOL transfers as account setup. */
export async function pumpSwapRentDelta(connection: Connection, owner: PublicKey, mint: PublicKey,
  addresses: PublicKey[], before: Parameters<typeof walletTokenChanges>[4],
  after: Parameters<typeof walletTokenChanges>[5]) {
  const volume = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), owner.toBuffer()], PUMP_AMM_PROGRAM)[0];
  const program = getPumpAmmProgram(connection);
  let overhead = 0;
  for (const [key, name] of [[volume, "userVolumeAccumulator"], [canonicalPumpPoolPda(mint), "pool"]] as const) {
    const i = addresses.findIndex(a => a.equals(key));
    // Volume tracking is optional for Jupiter's legacy PumpSwap ABI.
    if (i < 0 && name === "userVolumeAccumulator") continue;
    const post = after[i], pre = before[i];
    if (i < 0 || !post || post.owner !== PUMP_AMM_PROGRAM.toBase58() ||
        (pre && !pre.owner.equals(PUMP_AMM_PROGRAM))) throw new TradingError("PumpSwap rent state owner unavailable or changed.");
    const data = Buffer.from(post.data[0], "base64");
    if (data.length > 4096) throw new TradingError("Unsupported PumpSwap rent layout.");
    const decoded = program.coder.accounts.decode(name, data);
    if (name === "userVolumeAccumulator" && !decoded.user.equals(owner)) throw new TradingError("PumpSwap volume authority mismatch.");
    if (!pre || pre.data.length !== data.length) {
      const rent = await connection.getMinimumBalanceForRentExemption(data.length);
      const shortfall = Math.max(0, rent - (pre?.lamports ?? 0));
      if (post.lamports !== (pre?.lamports ?? 0) + shortfall) throw new TradingError("Unexpected PumpSwap state funding.");
      overhead += shortfall;
    } else if (pre.lamports !== post.lamports) throw new TradingError("Unexpected PumpSwap state lamport movement.");
  }
  return overhead;
}
