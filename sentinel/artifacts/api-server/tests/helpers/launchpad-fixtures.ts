import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { AccountLayout, MintLayout } from "@solana/spl-token";
import { getPumpProgram, getPumpFeeProgram, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, PUMP_FEE_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { createDbcProgram, deriveDbcPoolAddress, deriveDbcTokenVaultAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PUMP_PROGRAM, DBC_PROGRAM, DBC_POOL_AUTHORITY, pumpCurveAddress } from "../../src/lib/sentinel/curve-policy";
import { TOKEN_PROGRAM_ID, tokenAddress } from "../../src/lib/sentinel/token-policy";
import { SOL } from "../../src/lib/sentinel/discovery-policy";

export const n = (value: string | number | bigint) => new BN(String(value));
export const account = (owner: PublicKey, data: Buffer, lamports = 2_039_280): AccountInfo<Buffer> =>
  ({ owner, data, lamports, executable: false, rentEpoch: 0 });
export function token(mint: PublicKey, owner: PublicKey, amount: bigint, delegate = PublicKey.default) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount, delegateOption: delegate.equals(PublicKey.default) ? 0 : 1, delegate,
    state: 1, isNativeOption: mint.toBase58() === SOL ? 1 : 0, isNative: 2039280n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return account(TOKEN_PROGRAM_ID, data);
}
function zeros(idl: any, type: any): any {
  if (type === "pubkey") return PublicKey.default;
  if (type === "bool") return false;
  if (typeof type === "string") return /^(u|i)(64|128|256)$/.test(type) ? n(0) : 0;
  if (type.array) return Array.from({ length: type.array[1] }, () => zeros(idl, type.array[0]));
  if (type.vec) return [];
  if (type.option) return null;
  if (type.defined) {
    const def = idl.types.find((t: any) => t.name === type.defined.name).type;
    if (def.kind !== "struct") throw new Error("Fixture needs a struct");
    return Object.fromEntries(def.fields.map((f: any) => [f.name, zeros(idl, f.type)]));
  }
  throw new Error(`Unknown fixture IDL type ${JSON.stringify(type)}`);
}
export const blank = (program: any, name: string) => zeros(program.idl, { defined: { name } });
export function encode(program: any, name: string, value: any) {
  // Anchor's public encode uses a 1KB buffer; DBC config is larger. Use its
  // exact vendored layout with a sufficiently sized test-only buffer.
  const layout = program.coder.accounts.accountLayouts.get(name).layout;
  const buffer = Buffer.alloc(16000);
  const length = layout.encode(value, buffer);
  return Buffer.concat([Buffer.from(program.idl.accounts.find((a: any) => a.name === name).discriminator), buffer.subarray(0, length)]);
}
export function fixture(kind: "pump" | "dbc") {
  const connection = new Connection("https://fixture.invalid");
  const mint = Keypair.generate().publicKey, keypair = Keypair.generate(), user = keypair.publicKey;
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const program = kind === "pump" ? getPumpProgram(connection) : createDbcProgram(connection);
  const pumpFees = getPumpFeeProgram(connection);
  const configKey = Keypair.generate().publicKey;
  const pool = kind === "pump" ? pumpCurveAddress(mint) : deriveDbcPoolAddress(new PublicKey(SOL), mint, configKey);
  const baseVault = kind === "pump" ? tokenAddress(pool, mint) : deriveDbcTokenVaultAddress(pool, mint);
  const quoteVault = deriveDbcTokenVaultAddress(pool, new PublicKey(SOL));
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000_000_000_000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  accounts.set(mint.toBase58(), account(TOKEN_PROGRAM_ID, mintData));
  accounts.set(baseVault.toBase58(), token(mint, kind === "pump" ? pool : DBC_POOL_AUTHORITY, 800_000_000_000_000n));
  accounts.set(quoteVault.toBase58(), token(new PublicKey(SOL), DBC_POOL_AUTHORITY, 20_000_000_000n));
  let state: any, config: any;
  const setState = () => accounts.set(pool.toBase58(), account(kind === "pump" ? PUMP_PROGRAM : DBC_PROGRAM,
    encode(program, kind === "pump" ? "bondingCurve" : "virtualPool", state), 20_010_000_000));
  const setConfig = () => accounts.set(kind === "pump" ? GLOBAL_PDA.toBase58() : configKey.toBase58(),
    account(kind === "pump" ? PUMP_PROGRAM : DBC_PROGRAM, encode(program, kind === "pump" ? "global" : "poolConfig", config)));
  if (kind === "pump") {
    state = { ...blank(program, "bondingCurve"), virtualTokenReserves: n("1000000000000000"), virtualQuoteReserves: n("50000000000"),
      realTokenReserves: n("700000000000000"), realQuoteReserves: n("20000000000"), tokenTotalSupply: n("1000000000000000"),
      creator: Keypair.generate().publicKey };
    config = { ...blank(program, "global"), initialized: true, feeBasisPoints: n(100), buybackFeeRecipients: Array(8).fill(user) };
    const fees = { ...blank(pumpFees, "feeConfig"), feeTiers: [{ marketCapLamportsThreshold: n(0),
      fees: { lpFeeBps: n(0), protocolFeeBps: n(100), creatorFeeBps: n(0) } }] };
    const raw = encode(pumpFees, "feeConfig", fees);
    accounts.set(PUMP_FEE_CONFIG_PDA.toBase58(), account(PUMP_FEE_PROGRAM_ID, Buffer.concat([raw, Buffer.alloc(4097 - raw.length)])));
  } else {
    config = blank(program, "poolConfig");
    config.partnerPermanentLockedLiquidityPercentage = 100;
    Object.assign(config, { quoteMint: new PublicKey(SOL), tokenDecimal: 6, migrationQuoteThreshold: n("100000000000"),
      sqrtStartPrice: n(1n << 63n), migrationSqrtPrice: n(1n << 65n) });
    config.curve[0] = { sqrtPrice: n(1n << 65n), liquidity: n("100000000000000000000000000000") };
    state = blank(program, "virtualPool");
    Object.assign(state.poolState, { config: configKey, baseMint: mint, baseVault, quoteVault,
      baseReserve: n("700000000000000"), quoteReserve: n("20000000000"), sqrtPrice: n(1n << 64n) });
  }
  setState(); setConfig();
  for (const key of [PUMP_PROGRAM, DBC_PROGRAM, PUMP_FEE_PROGRAM_ID]) {
    const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    const dataKey = PublicKey.findProgramAddressSync([key.toBuffer()], loader)[0];
    const p = Buffer.alloc(36); p.writeUInt32LE(2); dataKey.toBuffer().copy(p, 4);
    accounts.set(key.toBase58(), { ...account(loader, p), executable: true });
    const d = Buffer.alloc(45); d.writeUInt32LE(3); d[12] = 1;
    accounts.set(dataKey.toBase58(), account(loader, d));
  }
  connection.getAccountInfo = async (key: PublicKey) => accounts.get(key.toBase58()) ?? null;
  connection.getMultipleAccountsInfo = async (keys: PublicKey[]) => {
    if (keys.length > 5) throw new Error("RPC account cap exceeded");
    return Promise.all(keys.map(k => connection.getAccountInfo(k)));
  };
  connection.getProgramAccounts = (async (_key: PublicKey, options: any) => {
    const tag = options?.filters?.find((f: any) => f.memcmp?.offset === 0)?.memcmp?.bytes;
    // SDK asks separately for standard and transfer-hook discriminators.
    const bs58 = (await import("bs58")).default;
    const expected = bs58.encode(Buffer.from(program.idl.accounts!.find(a => a.name === "virtualPool")!.discriminator));
    return tag === expected ? [{ pubkey: pool, account: accounts.get(pool.toBase58())! }] : [];
  }) as any;
  connection.getSlot = async () => 1000;
  connection.getGenesisHash = async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  connection.getBlockTime = async () => 1_800_000_000;
  connection.getLatestBlockhash = async () => ({ blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 2000 });
  return { connection, accounts, program, mint, user, keypair, pool, baseVault, quoteVault, state, config, setState, setConfig };
}
