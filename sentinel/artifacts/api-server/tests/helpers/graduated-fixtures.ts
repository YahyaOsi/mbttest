import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { canonicalPumpPoolPda, pumpPoolAuthorityPda, getPumpAmmProgram } from "@pump-fun/pump-sdk";
import { MintLayout } from "@solana/spl-token";
import { PUMP_AMM_PROGRAM } from "../../src/lib/sentinel/curve-policy";
import { tokenAddress, TOKEN_PROGRAM_ID } from "../../src/lib/sentinel/token-policy";
import { SOL } from "../../src/lib/sentinel/discovery-policy";
import { anchorTag } from "../../src/lib/sentinel/launchpad-policy";
import { JUPITER_PROGRAM } from "../../src/lib/sentinel/graduated-route-policy";
import { fixture, account, token, blank, encode, n } from "./launchpad-fixtures";

export function graduatedFixture() {
  const f = fixture("pump"), program = getPumpAmmProgram(f.connection);
  f.state.complete = true; f.state.realTokenReserves = n(0); f.state.realQuoteReserves = n(0); f.setState();
  const pool = canonicalPumpPoolPda(f.mint);
  const lpMint = PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), pool.toBuffer()], PUMP_AMM_PROGRAM)[0];
  const global = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMP_AMM_PROGRAM)[0];
  const baseVault = tokenAddress(pool, f.mint), quoteVault = tokenAddress(pool, new PublicKey(SOL));
  const state = { ...blank(program, "pool"), poolBump: PublicKey.findProgramAddressSync([
    Buffer.from("pool"), Buffer.alloc(2), pumpPoolAuthorityPda(f.mint).toBuffer(), f.mint.toBuffer(), new PublicKey(SOL).toBuffer(),
  ], PUMP_AMM_PROGRAM)[1], index: 0, creator: pumpPoolAuthorityPda(f.mint), baseMint: f.mint, quoteMint: new PublicKey(SOL),
    lpMint, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault, lpSupply: n(10000000000), coinCreator: f.state.creator };
  const setPool = () => f.accounts.set(pool.toBase58(), account(PUMP_AMM_PROGRAM, encode(program, "pool", state)));
  const setLp = (supply = 0n, authority = pool, frozen = false) => {
    const d = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: authority, supply, decimals: 9, isInitialized: true,
      freezeAuthorityOption: frozen ? 1 : 0, freezeAuthority: frozen ? f.user : PublicKey.default }, d);
    f.accounts.set(lpMint.toBase58(), account(TOKEN_PROGRAM_ID, d));
  };
  setPool(); setLp();
  f.accounts.set(baseVault.toBase58(), token(f.mint, pool, 800000000000000n));
  f.accounts.set(quoteVault.toBase58(), token(new PublicKey(SOL), pool, 100000000000n));
  f.accounts.get(quoteVault.toBase58())!.lamports = 100002039280;
  f.accounts.set(global.toBase58(), account(PUMP_AMM_PROGRAM, encode(program, "globalConfig", blank(program, "globalConfig"))));
  f.accounts.set(PUMP_AMM_PROGRAM.toBase58(), { ...account(new PublicKey("BPFLoader2111111111111111111111111111111111"), Buffer.alloc(0)), executable: true });
  f.accounts.set(f.user.toBase58(), account(SystemProgram.programId, Buffer.alloc(0), 1000000000));
  const quote = (amount = "1000000", output = "7000000000") => ({
    router: "metis", requestId: "fixture-request", inputMint: SOL, outputMint: f.mint.toBase58(), inAmount: amount,
    outAmount: output, priceImpactPct: 0, slippageBps: 100, quotedAt: Date.now(), routePoolIds: [pool.toBase58()],
    routePlan: [{ percent: 100, swapInfo: { ammKey: pool.toBase58(), inputMint: SOL, outputMint: f.mint.toBase58() } }],
  });
  const build = (q: ReturnType<typeof quote>, shared = false) => {
    const data = Buffer.alloc(shared ? 36 : 35), offset = shared ? 9 : 8;
    anchorTag(shared ? "shared_accounts_route" : "route").copy(data);
    data.writeUInt32LE(1, offset); data.set([72, 100, 0, 1], offset + 4);
    data.writeBigUInt64LE(BigInt(q.inAmount), offset + 8); data.writeBigUInt64LE(BigInt(q.outAmount), offset + 16);
    data.writeUInt16LE(q.slippageBps, offset + 24);
    const jupiter = new PublicKey(JUPITER_PROGRAM);
    const event = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], jupiter)[0];
    const authority = PublicKey.findProgramAddressSync([Buffer.from("authority"), Buffer.from([0])], jupiter)[0];
    const source = tokenAddress(f.user, new PublicKey(SOL)), destination = tokenAddress(f.user, f.mint);
    const fixed = shared
      ? [TOKEN_PROGRAM_ID, authority, f.user, source, tokenAddress(authority, new PublicKey(SOL)), tokenAddress(authority, f.mint),
        destination, new PublicKey(SOL), f.mint, jupiter, jupiter, event, jupiter]
      : [TOKEN_PROGRAM_ID, f.user, source, destination, jupiter, f.mint, jupiter, event, jupiter];
    // Fixed official Jupiter account order plus canonical PumpSwap remaining
    // accounts. The simulation must execute the expected CPI, not merely list it.
    const writable = [source, destination, pool, baseVault, quoteVault].map(k => k.toBase58());
    const keys = [...fixed, pool, baseVault, quoteVault, PUMP_AMM_PROGRAM].map(pubkey => ({
      pubkey, isSigner: pubkey.equals(f.user), isWritable: writable.includes(pubkey.toBase58()),
    }));
    return new VersionedTransaction(new TransactionMessage({ payerKey: f.user, recentBlockhash: SystemProgram.programId.toBase58(),
      instructions: [new TransactionInstruction({ programId: new PublicKey(JUPITER_PROGRAM), keys, data })],
    }).compileToV0Message());
  };
  return { ...f, ammProgram: program, migratedPool: pool, lpMint, global, migratedBase: baseVault, migratedQuote: quoteVault,
    migratedState: state, setPool, setLp, quote, build };
}
