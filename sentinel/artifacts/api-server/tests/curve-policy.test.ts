import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import {
  classifyVault, curveNominee, curveStatus, decodePumpCurve, nonVaultTopPct, preMigration, pumpCurveAddress,
  DBC_POOL_AUTHORITY, DAMM_V2_POOL_AUTHORITY, PUMP_AMM_PROGRAM, PUMP_PROGRAM, PUMP_INITIAL_REAL_TOKENS,
} from "../src/lib/sentinel/curve-policy";
import { entryFilters } from "../src/lib/sentinel/analysis";
import { initialState } from "../src/lib/sentinel/store";
import type { Candidate } from "../src/lib/sentinel/types";

const disc = createHash("sha256").update("account:BondingCurve").digest().subarray(0, 8);
function curveAccount({ realTokens = PUMP_INITIAL_REAL_TOKENS / 2n, realSol = 40_000_000_000n, complete = 0, owner = PUMP_PROGRAM, discriminator = disc, lamports }: {
  realTokens?: bigint; realSol?: bigint; complete?: number; owner?: PublicKey; discriminator?: Buffer; lamports?: number } = {}): AccountInfo<Buffer> {
  const data = Buffer.alloc(166);
  discriminator.copy(data, 0);
  data.writeBigUInt64LE(realTokens, 24); data.writeBigUInt64LE(realSol, 32); data[48] = complete;
  return { data, owner, lamports: lamports ?? Number(realSol) + 2_000_000, executable: false, rentEpoch: 0 };
}
const system = (owner = SystemProgram.programId): AccountInfo<Buffer> => ({ data: Buffer.alloc(0), owner, lamports: 1, executable: false, rentEpoch: 0 });

test("Pump.fun curve decoding requires program owner, discriminator, sane flag and backing lamports", () => {
  const c = decodePumpCurve(curveAccount())!;
  assert.equal(c.complete, false); assert.equal(c.realSolLamports, 40_000_000_000n); assert.equal(c.progressPct, 50);
  assert.equal(decodePumpCurve(curveAccount({ complete: 1 }))!.complete, true);
  assert.equal(decodePumpCurve(curveAccount({ owner: Keypair.generate().publicKey })), null);
  assert.equal(decodePumpCurve(curveAccount({ discriminator: Buffer.alloc(8) })), null);
  assert.equal(decodePumpCurve(curveAccount({ complete: 7 })), null);
  assert.equal(decodePumpCurve(curveAccount({ lamports: 1 })), null, "reserves not backed by lamports");
  assert.equal(decodePumpCurve(null), null);
});

test("only program-controlled vault authorities are classified; spoofed and ordinary owners are holders", () => {
  const mint = Keypair.generate().publicKey;
  const curve = pumpCurveAddress(mint);
  assert.equal(classifyVault(mint, curve, curveAccount()), "Pump.fun bonding curve");
  // Another mint's curve PDA, or a fake account at the PDA, is not this token's curve.
  assert.equal(classifyVault(Keypair.generate().publicKey, curve, curveAccount()), null);
  assert.equal(classifyVault(mint, curve, curveAccount({ owner: SystemProgram.programId })), null);
  assert.equal(classifyVault(mint, Keypair.generate().publicKey, system(PUMP_AMM_PROGRAM)), "PumpSwap pool");
  assert.equal(classifyVault(mint, DBC_POOL_AUTHORITY, system()), "Meteora DBC curve");
  assert.equal(classifyVault(mint, DAMM_V2_POOL_AUTHORITY, system()), "Meteora DAMM v2 pool");
  assert.equal(classifyVault(mint, Keypair.generate().publicKey, system()), null);
  assert.equal(classifyVault(mint, Keypair.generate().publicKey, null), null);
});

test("concentration excludes verified vaults, still counts creators, and fails closed on an all-vault sample", () => {
  const supply = 1_000_000n;
  assert.equal(nonVaultTopPct(supply, [{ amount: 800_000n, vault: "Pump.fun bonding curve" }, { amount: 120_000n, vault: null }], true), 12);
  assert.equal(nonVaultTopPct(supply, [{ amount: 900_000n, vault: "Meteora DBC curve" }], true), 0);
  assert.throws(() => nonVaultTopPct(supply, [{ amount: 900_000n, vault: "Pump.fun bonding curve" }], false));
});

test("curve status: pump state wins; emptied DBC vault means complete; completed curves are not pre-migration", () => {
  const supply = 1_000_000n;
  const pump = curveStatus(supply, [], decodePumpCurve(curveAccount()));
  assert.deepEqual(pump, { kind: "Pump.fun bonding curve", complete: false, liquiditySol: 40, progressPct: 50 });
  assert.equal(preMigration(pump), true);
  assert.equal(preMigration(curveStatus(supply, [], decodePumpCurve(curveAccount({ complete: 1 })))), false);
  assert.equal(preMigration(curveStatus(supply, [{ amount: 600_000n, vault: "Meteora DBC curve" }], null)), true);
  assert.equal(preMigration(curveStatus(supply, [{ amount: 5n, vault: "Meteora DBC curve" }], null)), false);
  assert.equal(curveStatus(supply, [{ amount: 600_000n, vault: "Meteora DAMM v2 pool" }], null), null);
});

test("curve floors only apply when nominated/verified and enabled; all other gates still apply", () => {
  const s = initialState();
  const c = {
    mint: "x", symbol: "T", priceUsd: 1, liquidityUsd: 12000, volume24hUsd: 150000, ageMinutes: 15, buys5m: 20, sells5m: 10,
    change5mPct: 5, updatedAt: new Date().toISOString(), launchpad: "pump.fun", venue: null, organicScore: 50, flaggedSuspicious: false,
  } as unknown as Candidate;
  assert.equal(curveNominee(c, s.settings), true);
  assert.deepEqual(entryFilters(c, s), []);
  assert.deepEqual(entryFilters(c, s, false), ["Pool is too young or creation time is unknown"]);
  assert.deepEqual(entryFilters({ ...c, liquidityUsd: 4000 }, s, true), ["Launchpad curve liquidity below limit"]);
  assert.ok(entryFilters({ ...c, buys5m: 2 }, s, true).includes("Insufficient recent buy activity"));
  assert.ok(entryFilters({ ...c, flaggedSuspicious: true }, s, true).length > 0);
  s.settings.launchpadCurvesEnabled = false;
  assert.equal(curveNominee(c, s.settings), false);
  assert.equal(entryFilters(c, s).length, 1);
  assert.equal(curveNominee({ ...c, launchpad: "unknown" }, { ...s.settings, launchpadCurvesEnabled: true }), false);
});
