# Native launchpad execution

## Official sources and implementation choice

Research checked 2026-10-26:

- Pump's official [program documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md),
  [v3 trade ABI](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/TRADE_V3.md),
  and [IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json).
  Pinned official `@pump-fun/pump-sdk` **4.3.1**.
- Meteora's official [DBC program/source](https://github.com/MeteoraAg/dynamic-bonding-curve),
  [SDK](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk) and vendored IDL.
  Pinned official `@meteora-ag/dynamic-bonding-curve-sdk` **2.0.0**.
- Bags' official [program identities](https://docs.bags.fm/principles/program-ids),
  [trade API](https://docs.bags.fm/how-to-guides/trade-tokens),
  and [v2 quote API](https://docs.bags.fm/api-reference/get-trade-v2-quote).
  Bags launch curves use Meteora DBC; fee-share programs are not required to swap.
  Bags' trade API is not an independent curve-price oracle: it routes over
  providers (v2 races Jupiter/Titan) and adds its own fees. The fallback therefore
  reads DBC accounts and uses Meteora's local quote/builder, with no Bags API key,
  external transaction blobs, fee-sharing instructions, tips or referral account.

## Mainnet identities and mutability

The following **read-only** mainnet RPC observations were made during development.
They are historical evidence, not pinned upgrade-authority guarantees:

| Program | Mainnet address | Observed deployment slot | Observed upgrade authority |
|---|---|---|---|
| Pump | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | 458921440 | `7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8` |
| Meteora DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | 457502600 | `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd` |
| Pump Fees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | 456132171 | `7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8` |

All three were **upgradeable**, not immutable. Each native quote verifies the
mainnet genesis hash, executable program account, supported loader, derived
ProgramData address, ProgramData owner/tag and authority-option encoding.
A null authority is reported as immutable; an unsupported loader/link fails
closed. This does **not** attest program binary source equivalence, prevent a
future upgrade, or make a token safe. Simulation and economic/account checks
remain mandatory. There is no claim that these programs are universally safe.

## Supported state and quotes

Both directions use independently read on-chain state rather than trusting
Jupiter, Raydium, Bags or a token's launchpad label:

- Pump: verify the `["bonding-curve", mint]` PDA, program owner, Anchor
  discriminator, real SOL backing, actual token ATA/mint/authority, fee-config
  and global-account owners. Decode versioned fields through the pinned SDK.
  The initial prefix is discriminator, five little-endian u64 reserves/supply,
  `complete` at byte 48, creator at 49, mayhem/cashback flags at 81/82 and quote
  mint at 83. Later versioned fields include accrued fees.
  Use the current fee tiers and local exact-input v3 buy/sell math; independently
  bound output by constant-product and real reserve limits. No synthetic
  migration / reserve exhaustion is authorized.
- DBC: read the canonical base-mint pool and verify standard pool/config owners,
  discriminators via the pinned IDL, base mint, derived pool address, both derived
  vault addresses, shared authority, mint programs, real balances and reserves.
  SDK 2.x returns a `poolState` wrapper; configs contain up to 20 liquidity/price
  ranges, fee scheduler, dynamic fee state, activation point/type and migration
  threshold. Use the real chain slot/time, not wall-clock guesses, for local
  exact-input range/fee math. Never assume a first-swap discount.
- Both: independently compare output against read spot price and real reserves;
  impact conservatively includes fees. Positive u64 input/output, integer
  minimum output, configured slippage/impact and fresh quotes are mandatory.
  A buy must also pass the engine's reverse-sell quote, 5% round-trip cost,
  estimated stop-loss and reserve checks.

Only SOL-paired, active, nonempty standard curves are supported. Pump
mayhem/cashback, non-SOL quotes, DBC transfer-hook variants, unsafe mint
authorities/extensions, completed/migrating curves and unknown state fail closed.
SPL and metadata-only Token-2022 base mints retain the existing mint policy.
Native curve entry requires the launchpad strategy toggle; disabling entries
never prevents a supported emergency sell.

## Transactions and settlement

- Pump: only `buy_exact_quote_in_v3` and `sell_v3`. Decode the actual instruction
  discriminator and little-endian input/minimum, and require partial-fill false
  (which otherwise can bypass Pump's minimum). Exact-out buys are not accepted.
- DBC: only the original exact-input `swap` with decoded input/minimum.
  SDK wrapping/unwrapping is atomic and uses the sole wallet signer.
- Compile one unsigned v0 transaction locally, with no lookup tables, one
  signer/payer and a packet-size cap. Bind the **entire message**, including
  account metas and setup/cleanup, to a process-local quote authorization.
  Caller-supplied/copied transaction blobs cannot acquire that authorization.
- Existing program, token authority/delegate, wallet token-account and simulation
  checks apply. Batched account reads are chunked at five for this RPC plan.
  Native SOL deltas, exact input, minimum output and no persistent WSOL delta
  must match. Fees and verified account rent remain under the existing 0.005 SOL
  overhead cap and protected fee reserve.
- Pump may initialize a user-volume PDA or extend its curve account. Only the
  verified rent shortfall of these exact program-owned PDAs is excluded from
  swap principal. It remains included in actual cost basis.
- Pre-sign failures may try the next supported venue, including a new reverse
  check. **After signing there is no route switch or order retry.** Persist the
  deterministic signature/intent before submitting. Unknown response, missing
  status or restart keeps the pending signature blocking new orders.
  Finalized chain metadata, not quote estimates, determines fills/cost basis.

## Risk-stream coverage

Supported live positions can subscribe to verified Pump curve/base-ATA mappings
or DBC pool/base/WSOL-vault mappings. Pump holds native SOL in the curve account,
so its stream measures account holdings including rent/accrued fees, **not**
virtual reserves or exact withdrawable liquidity. DBC maps its two token vaults.
Entry liquidity uses the actual real SOL reserve rather than virtual reserves.
Only verified DBC base vaults are excluded from holder concentration, not every
account someone assigns to its shared authority.

Confirmed transactions can produce fixed-price holdings snapshots. Block-drop
claims require ordered, continuous observed changes; missing balances produce
no snapshot. Recognized migration logs discard old mappings and reset samples.
Post-migration pools need fresh verification. Missing mappings/events, decoding
failures, bounded queues, 60-decode/minute budgets, RPC outages and confirmation
delay are explicitly incomplete coverage. Large signer outflow is not verified
developer identity. This is not a universal single-block rug detector.

## Verification and operating boundary

Run:

```sh
pnpm run typecheck
pnpm --filter @workspace/scripts exec tsx --test ../artifacts/api-server/tests/*.test.ts
```

Tests use actual pinned SDK layouts/unsigned builders with in-memory accounts,
and a fully mocked RPC/DB for simulated failures, buys, sells, submission
ambiguity, save failure, finalized errors and restart reconciliation.
Ephemeral fixture keys sign mock transactions only; no test reaches a network
or uses the configured burner. Mainnet program reads above were read-only.

**No real transaction or burner-funded fill was submitted for this work.**
A separately confirmed capped mainnet test is still required for funded
execution evidence. Development has `SENTINEL_READ_ONLY=true`: no background
trading/AI worker and no mainnet signatures. This does not change production
approval flags. Do not disable that protection or submit a live test without
separate user confirmation.
