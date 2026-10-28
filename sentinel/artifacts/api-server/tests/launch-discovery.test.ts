import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { fixture } from "./helpers/launchpad-fixtures";
import { PUMP_PROGRAM, DBC_PROGRAM } from "../src/lib/sentinel/curve-policy";
import { anchorTag } from "../src/lib/sentinel/launchpad-policy";
import { verifyCreation } from "../src/lib/sentinel/launch-events";
import { LaunchDiscovery, emptyLaunchDiscovery, LAUNCH_RPC_CAP } from "../src/lib/sentinel/launch-discovery";
import { launchCandidate, dexCandidate, jupiterCandidate, SOL } from "../src/lib/sentinel/discovery-policy";
import { entryFilters, assess } from "../src/lib/sentinel/analysis";
import { initialState } from "../src/lib/sentinel/store";
import { assessmentQueue } from "../src/lib/sentinel/scan-policy";
import { openai } from "@workspace/integrations-openai-ai-server";

const at = Date.now();
function creation(f: ReturnType<typeof fixture>, kind: "pump" | "dbc", tag?: string): ParsedTransactionWithMeta {
  const program = kind === "pump" ? PUMP_PROGRAM : DBC_PROGRAM;
  const keys = kind === "pump" ? [f.mint, PublicKey.default, f.pool] :
    [f.state.poolState.config, PublicKey.default, f.user, f.mint, new PublicKey(SOL), f.pool];
  return {
    slot: 100, blockTime: Math.floor(at / 1000) - 600,
    transaction: { signatures: ["creation"], message: {
      accountKeys: keys.map(pubkey => ({ pubkey, signer: pubkey.equals(f.mint), writable: true })),
      instructions: [{ programId: program, accounts: keys, data: bs58.encode(anchorTag(tag ?? (kind === "pump" ? "create_v2" : "initialize_virtual_pool_with_spl_token"))) }],
    } },
    meta: { err: null, preBalances: keys.map(() => 0), postBalances: keys.map(() => 1000000), innerInstructions: [] },
  } as unknown as ParsedTransactionWithMeta;
}
function stream(f: ReturnType<typeof fixture>) {
  const callbacks = new Map<string, (e: any, context: { slot: number }) => void>();
  let subscription = 0, removed = 0;
  f.connection.onLogs = ((key: PublicKey, cb: (e: any, context: { slot: number }) => void) => {
    callbacks.set(key.toBase58(), cb); return ++subscription;
  }) as any;
  f.connection.removeOnLogsListener = async () => { removed++; };
  return { emit: (key: PublicKey, signature: string, logs = ["Program log: Instruction: CreateV2"]) =>
    callbacks.get(key.toBase58())?.({ signature, err: null, logs }, { slot: 100 }),
  removed: () => removed };
}

for (const kind of ["pump", "dbc"] as const) {
  test(`${kind}: creation requires exact program, instruction, new initialized mint and canonical pool`, async () => {
    const f = fixture(kind), program = kind === "pump" ? PUMP_PROGRAM : DBC_PROGRAM;
    const tx = creation(f, kind);
    const record = await verifyCreation(f.connection, tx, "creation", program, at);
    assert.equal(record?.mint, f.mint.toBase58());
    assert.equal(record?.pool, f.pool.toBase58());
    assert.ok(record?.createdAt);
    assert.equal(await verifyCreation(f.connection, creation(f, kind, "swap"), "swap", program, at), null);
    assert.equal(await verifyCreation(f.connection, tx, "fake", Keypair.generate().publicKey, at), null);
    tx.meta!.err = { InstructionError: [0, "InvalidArgument"] };
    assert.equal(await verifyCreation(f.connection, tx, "failed", program, at), null);
    tx.meta!.err = null;
    const mintIndex = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.equals(f.mint));
    tx.meta!.preBalances[mintIndex] = 1;
    assert.equal(await verifyCreation(f.connection, tx, "existing", program, at), null);
    tx.meta!.preBalances[mintIndex] = 0;
    const mintRaw = f.accounts.get(f.mint.toBase58())!;
    f.accounts.set(f.mint.toBase58(), { ...mintRaw, owner: PUMP_PROGRAM });
    assert.equal(await verifyCreation(f.connection, tx, "wrong-owner", program, at), null);
    f.accounts.set(f.mint.toBase58(), mintRaw);
    const poolRaw = f.accounts.get(f.pool.toBase58())!;
    f.accounts.set(f.pool.toBase58(), { ...poolRaw, data: Buffer.alloc(poolRaw.data.length) });
    assert.equal(await verifyCreation(f.connection, tx, "bad-pool", program, at), null);
    f.accounts.set(f.pool.toBase58(), poolRaw);
    tx.blockTime = null;
    assert.equal((await verifyCreation(f.connection, tx, "unknown-time", program, at))?.createdAt, null);
  });
}

test("Pump log hints never enter bounded archive reconstruction, even after reconnect or event floods", async () => {
  const f = fixture("pump"), events = stream(f);
  f.connection.getSignaturesForAddress = async () => [];
  let available = false, decoded = 0;
  f.connection.getParsedTransaction = async signature => {
    decoded++;
    return available && signature === "real" ? creation(f, "pump") : null;
  };
  let persisted = emptyLaunchDiscovery(), state = emptyLaunchDiscovery(), saves = 0;
  const save = async () => { persisted = structuredClone(state); saves++; };
  const feed = new LaunchDiscovery(f.connection);
  await feed.poll(state, save, at);
  events.emit(PUMP_PROGRAM, "real");
  events.emit(PUMP_PROGRAM, "real");
  events.emit(PUMP_PROGRAM, "fake", ["Program log: Instruction: Swap"]);
  await feed.poll(state, save, at + 60000);
  assert.equal(decoded, 0);
  assert.equal(state.records.length, 0);
  assert.equal(persisted.sources[PUMP_PROGRAM.toBase58()], undefined);
  assert.match(state.status, /Pump.fun archive sampling disabled/);
  await feed.stop();
  assert.equal(events.removed(), 2, "both approved program subscriptions are removed");
  available = true;
  state = structuredClone(persisted);
  const restarted = new LaunchDiscovery(f.connection);
  await restarted.poll(state, save, at + 120000);
  assert.equal(state.records.length, 0);
  assert.equal(state.sources[PUMP_PROGRAM.toBase58()], undefined);
  assert.ok(saves > 1);
  const before = decoded;
  await restarted.poll(state, save, at + 120001);
  assert.equal(decoded, before, "durable minute throttle cannot reset on reconnect");
  for (let i = 0; i < 1000; i++) events.emit(PUMP_PROGRAM, `spam-${i}`);
  await restarted.poll(state, save, at + 180000);
  assert.equal(state.sources[PUMP_PROGRAM.toBase58()], undefined);
  assert.equal(decoded, 0);
  const count = Number(state.status.match(/; (\d+)\//)?.[1]);
  assert.ok(count <= LAUNCH_RPC_CAP);
  await restarted.stop();
});

test("legacy Pump archive cursors stay dormant across crashes and RPC recovery", async () => {
  const f = fixture("pump"); stream(f);
  const key = PUMP_PROGRAM.toBase58();
  let state = emptyLaunchDiscovery(), persisted = structuredClone(state), fail = false;
  state.sources[key] = { head: "old-head", pending: [] };
  const requests: any[] = [];
  f.connection.getSignaturesForAddress = async (program, options) => {
    if (!program.equals(PUMP_PROGRAM)) return [];
    requests.push(options);
    if (fail) throw new Error("offline");
    if (options?.before === "p11") return [];
    return Array.from({ length: 12 }, (_, i) => ({ signature: `p${i}`, err: null, slot: 100, memo: null, blockTime: null }));
  };
  f.connection.getParsedTransaction = async () => creation(f, "pump", "swap");
  const save = async () => { persisted = structuredClone(state); };
  let feed = new LaunchDiscovery(f.connection);
  await feed.poll(state, save, at);
  assert.equal(state.sources[key].head, "old-head");
  assert.equal(state.sources[key].before, undefined);
  assert.equal(state.sources[key].pending.length, 0);
  await feed.stop();
  state = structuredClone(persisted);
  feed = new LaunchDiscovery(f.connection);
  await feed.poll(state, save, at + 60000);
  assert.equal(state.sources[key].head, "old-head");
  assert.equal(state.sources[key].pending.length, 0);
  fail = true;
  await feed.poll(state, save, at + 180000);
  assert.equal(state.sources[key].head, "old-head");
  assert.equal(state.sources[key].before, undefined);
  fail = false;
  await feed.poll(state, save, at + 240000);
  assert.equal(state.sources[key].head, "old-head");
  assert.equal(state.sources[key].before, undefined);
  assert.deepEqual(requests, [], "no Pump signature archive request may run, even when healthy");
  await feed.stop();
});

test("non-executable program identity cannot produce a discovery record", async () => {
  const f = fixture("pump"); stream(f);
  const raw = f.accounts.get(PUMP_PROGRAM.toBase58())!;
  f.accounts.set(PUMP_PROGRAM.toBase58(), { ...raw, executable: false });
  let decoded = 0;
  f.connection.getSignaturesForAddress = async () => [{ signature: "forged", err: null, slot: 1, memo: null }];
  f.connection.getParsedTransaction = async () => { decoded++; return creation(f, "pump"); };
  const state = emptyLaunchDiscovery(), feed = new LaunchDiscovery(f.connection);
  await feed.poll(state, async () => undefined, at);
  assert.equal(state.records.length, 0);
  assert.match(state.status, /verification unavailable/);
  await feed.stop();
});

test("DBC creation log hints use verified shared-program identity without asserting Bags branding", async () => {
  const f = fixture("dbc"), events = stream(f), feed = new LaunchDiscovery(f.connection);
  const state = emptyLaunchDiscovery();
  f.connection.getSignaturesForAddress = async () => [];
  f.connection.getParsedTransaction = async () => creation(f, "dbc");
  await feed.poll(state, async () => undefined, at);
  events.emit(DBC_PROGRAM, "dbc-launch", ["Program log: Instruction: InitializeVirtualPoolWithSplToken"]);
  await feed.poll(state, async () => undefined, at + 60000);
  assert.equal(state.records.length, 0, "DBC is not subscribed to or scanned");
  // A reconnect renews both subscriptions; no extra transaction is fabricated.
  await feed.poll(state, async () => undefined, at + 360000);
  assert.equal(events.removed(), 2);
  assert.equal(state.records.length, 0);
  await feed.stop();
});

test("missing Pump accounts cannot reactivate the retired Pump archive scanner", async () => {
  const f = fixture("pump"); stream(f);
  const feed = new LaunchDiscovery(f.connection), key = PUMP_PROGRAM.toBase58(), state = emptyLaunchDiscovery();
  f.connection.getSignaturesForAddress = async p => p.equals(PUMP_PROGRAM)
    ? [{ signature: "pending-account", err: null, slot: 1, memo: null }] : [];
  f.connection.getParsedTransaction = async () => creation(f, "pump");
  const raw = f.accounts.get(f.mint.toBase58())!;
  f.accounts.delete(f.mint.toBase58());
  let persisted = structuredClone(state);
  const save = async () => { persisted = structuredClone(state); };
  await feed.poll(state, save, at);
  assert.equal(state.records.length, 0);
  assert.equal(persisted.sources[key], undefined);
  f.accounts.set(f.mint.toBase58(), raw);
  await feed.poll(state, save, at + 60000);
  assert.equal(state.records.length, 0);
  assert.equal(state.sources[key], undefined);
  await feed.stop();
});

test("unindexed launch remains visible but cannot spend AI or pass entry/assessment gates, even at zero age floor", async () => {
  const f = fixture("pump");
  const record = (await verifyCreation(f.connection, creation(f, "pump"), "creation", PUMP_PROGRAM, at))!;
  const c = launchCandidate(record), s = initialState();
  assert.equal(c.marketDataStatus, "awaiting_market_data");
  assert.equal(c.launchpad, "Pump.fun");
  assert.ok(c.missingMarketData!.includes("price"));
  s.candidates = [c];
  s.settings.minAgeMinutes = s.settings.curveMinAgeMinutes = 0;
  s.settings.minLiquidityUsd = s.settings.curveMinLiquidityUsd = s.settings.minVolumeUsd = 0;
  assert.deepEqual(assessmentQueue(s), []);
  assert.ok(entryFilters(c, s).some(r => /Missing market evidence/.test(r)));
  let paid = 0;
  const create = openai.chat.completions.create;
  (openai.chat.completions as any).create = async () => { paid++; throw new Error("AI must not be called"); };
  try {
    const result = await assess(c, s, async () => undefined);
    assert.equal(result.candidate.status, "rejected");
    assert.equal(paid, 0);
    assert.equal(s.aiCalls, 0);
  } finally { openai.chat.completions.create = create; }
  const noTime = launchCandidate({ ...record, createdAt: null });
  assert.ok(entryFilters(noTime, s).some(r => /creation time is unknown/.test(r)));
  assert.ok(noTime.missingMarketData!.includes("age"));
});

test("indexed zeroes are distinct from missing age/activity/change evidence", () => {
  const mint = Keypair.generate().publicKey.toBase58(), s = initialState();
  const row = { chainId: "solana", baseToken: { address: mint }, priceUsd: 1,
    liquidity: { usd: 50000 }, volume: { h24: 200000 }, pairCreatedAt: Date.now() - 86400000,
    txns: { m5: { buys: 20, sells: 0 } }, priceChange: { m5: 0 } };
  const complete = dexCandidate(row)!;
  assert.equal(complete.marketDataStatus, "market_data_available");
  assert.equal(entryFilters(complete, s).length, 0);
  for (const partial of [
    { ...row, pairCreatedAt: null }, { ...row, txns: { m5: { buys: 20 } } }, { ...row, priceChange: {} },
  ]) {
    const c = dexCandidate(partial)!;
    assert.equal(c.marketDataStatus, "awaiting_market_data");
    assert.ok(entryFilters(c, s).some(r => /Missing market evidence/.test(r)));
  }
  const j = jupiterCandidate({ id: mint, usdPrice: 1, updatedAt: new Date().toISOString(),
    liquidity: 50000, stats24h: { buyVolume: 200000, sellVolume: 0 }, stats5m: { numBuys: 20, priceChange: 0 } })!;
  assert.ok(j.missingMarketData!.includes("activity"));
  assert.ok(j.missingMarketData!.includes("age"));
  assert.ok(entryFilters({ ...complete, updatedAt: "unknown" }, s).length);
  assert.ok(entryFilters({ ...complete, priceUsd: NaN }, s).length);
});
