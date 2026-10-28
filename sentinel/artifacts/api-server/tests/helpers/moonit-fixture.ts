import { Connection, Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { MintLayout } from "@solana/spl-token";
import bs58 from "bs58";
import { MOONIT_PROGRAM, MOONIT_CONFIG, MOONIT_HELIO_FEE, MOONIT_DEX_FEE, moonitCurveAddress, moonitSdk } from "../../src/lib/sentinel/moonit-policy";
import { tokenAddress, TOKEN_PROGRAM_ID } from "../../src/lib/sentinel/token-policy";
import { account, token, n } from "./launchpad-fixtures";

/** Raw buffers encode the published layouts independently of the SDK encoder. */
export function moonitFixture() {
  const mint = Keypair.generate().publicKey, creator = Keypair.generate().publicKey, backend = Keypair.generate().publicKey;
  const [pool, bump] = moonitCurveAddress(mint), vault = tokenAddress(pool, mint), total = 1000000000000000000n;
  const sold = 200000000000000000n, remaining = total - sold;
  const curve = Buffer.alloc(84);
  Buffer.from([8, 91, 83, 28, 132, 216, 248, 22]).copy(curve);
  curve.writeBigUInt64LE(total, 8); curve.writeBigUInt64LE(remaining, 16); mint.toBuffer().copy(curve, 24);
  curve[56] = 9; curve[58] = 1; curve.writeBigUInt64LE(345000000000n, 59);
  curve.writeBigUInt64LE(3000000000n, 68); curve[80] = bump;
  const config = Buffer.alloc(227);
  Buffer.from([189, 255, 97, 70, 186, 189, 24, 102]).copy(config);
  [Keypair.generate().publicKey, backend, Keypair.generate().publicKey, MOONIT_HELIO_FEE, MOONIT_DEX_FEE]
    .forEach((key, i) => key.toBuffer().copy(config, 8 + i * 32));
  config.writeUInt16LE(100, 168); config[170] = 50; config.writeBigUInt64LE(3000000000n, 171);
  config[188] = 6; config[189] = 9; config.writeBigUInt64LE(total, 198); config.writeBigUInt64LE(345000000000n, 211);
  const mintData = Buffer.alloc(82);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: total, decimals: 9,
    isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  const lamports = Number(32190000000000000000000000000n / (1073000000000000000n - sold) - 30000000000n) + 1000000;
  const accounts = new Map([
    [mint.toBase58(), account(TOKEN_PROGRAM_ID, mintData)],
    [pool.toBase58(), account(MOONIT_PROGRAM, curve, lamports)],
    [vault.toBase58(), token(mint, pool, remaining)],
    [MOONIT_CONFIG.toBase58(), account(MOONIT_PROGRAM, config)],
    [MOONIT_PROGRAM.toBase58(), { ...account(new PublicKey("BPFLoader2111111111111111111111111111111111"), Buffer.alloc(1)), executable: true }],
  ]);
  const connection = new Connection("https://fixture.invalid");
  connection.getAccountInfo = async key => accounts.get(key.toBase58()) ?? null;
  connection.getMultipleAccountsInfo = async keys => keys.map(key => accounts.get(key.toBase58()) ?? null);
  connection.getMinimumBalanceForRentExemption = async () => 1000000;
  connection.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1234 });
  connection.getGenesisHash = async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  connection.sendRawTransaction = async () => { throw new Error("Funded transactions forbidden in fixture"); };
  const params = { name: "Independent Moonit Fixture", symbol: "FIX", uri: "", decimals: 9, collateralCurrency: 0,
    amount: n(total), curveType: 1, migrationTarget: 0, priceIncrease: 0, collateralCollected: n(0) };
  const data = moonitSdk().provider.program.coder.instruction.encode("tokenMint", { mintParams: params });
  const keys = [creator, backend, pool, mint];
  const creation: ParsedTransactionWithMeta = {
    slot: 100, blockTime: Math.floor(Date.now() / 1000) - 60,
    transaction: { message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i !== 2, writable: true })),
      instructions: [{ programId: MOONIT_PROGRAM, accounts: keys, data: bs58.encode(data) }] } },
    meta: { err: null, preBalances: keys.map(() => 0), postBalances: keys.map(() => 1000000), innerInstructions: [] },
  } as unknown as ParsedTransactionWithMeta;
  return { mint, creator, backend, pool, vault, accounts, connection, creation, config, curve, mintData, total, remaining };
}
