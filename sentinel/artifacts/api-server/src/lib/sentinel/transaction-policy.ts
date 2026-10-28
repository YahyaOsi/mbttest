import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { unpackAccount } from "@solana/spl-token";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, tokenAddress } from "./token-policy";
import { SOL } from "./discovery-policy";
import { TradingError } from "./store";

type SimAccount = { owner: string; lamports: number; data: [string, string]; executable: boolean; rentEpoch?: number } | null;
export function walletTokenChanges(
  owner: PublicKey, tradedMint: string, allowedMints: Set<string>,
  addresses: PublicKey[], before: (AccountInfo<Buffer> | null)[], after: (SimAccount | undefined)[],
) {
  let rentDelta = 0;
  const tokenPrograms = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
  for (let i = 1; i < addresses.length; i++) {
    const pre = before[i], sim = after[i];
    const post: AccountInfo<Buffer> | null = sim ? { owner: new PublicKey(sim.owner), lamports: sim.lamports,
      data: Buffer.from(sim.data[0], "base64"), executable: sim.executable, rentEpoch: sim.rentEpoch ?? 0 } : null;
    const decode = (a: AccountInfo<Buffer> | null) => a && tokenPrograms.includes(a.owner.toBase58()) && a.data.length >= 165
      ? unpackAccount(addresses[i], a, a.owner) : null;
    const a = decode(pre), b = decode(post);
    if (!a?.owner.equals(owner) && !b?.owner.equals(owner)) continue;
    for (const [account, raw] of [[a, pre], [b, post]] as const) if (account && raw) {
      if (!account.owner.equals(owner) || !allowedMints.has(account.mint.toBase58()) ||
          !tokenAddress(owner, account.mint, raw.owner).equals(addresses[i]) ||
          account.delegate || (account.closeAuthority && !account.closeAuthority.equals(owner))) {
        throw new TradingError("Swap touches an unauthorized wallet token account, owner or delegate.");
      }
    }
    if ((a && !b && post) || (b && !a && pre) || (a && b && (!a.mint.equals(b.mint) || !pre!.owner.equals(post!.owner)))) {
      throw new TradingError("Unexpected token account ownership/program change.");
    }
    const mint = (b ?? a)!.mint.toBase58();
    if (mint !== tradedMint && (b?.amount ?? 0n) !== (a?.amount ?? 0n)) {
      throw new TradingError(mint === SOL ? "Swap must not consume or leave existing WSOL." : "Swap must not spend or retain intermediate wallet tokens.");
    }
    rentDelta += (post?.lamports ?? 0) - (pre?.lamports ?? 0);
  }
  return rentDelta;
}
