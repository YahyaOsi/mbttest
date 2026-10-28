# Early launch discovery

Sentinel nominates new mints from confirmed Pump.fun and Meteora DBC creation
instructions, independently of Jupiter and DEX Screener listing. Bags uses
Meteora DBC; a DBC creation does **not** establish Bags branding. The scanner
labels this distinction rather than trusting a ticker suffix or calling all
DBC launches Bags.

## Verification and limits

- Exact mainnet program IDs and loader/ProgramData linkage must verify.
- Instruction discriminators and account positions come from the pinned Pump
  4.3.1 and Meteora DBC 2.0.0 SDK IDLs. Supported creation variants are Pump
  `create` / `create_v2` and DBC SPL / Token-2022 standard pool initialization.
  Transfer-hook pool variants and unknown ABI variants are not admitted.
- The transaction must succeed, create a previously unfunded mint, and have a
  matching canonical program-owned, decodable pool. The actual mint account
  must be an initialized SPL or Token-2022 mint. This is identity verification,
  **not** authority/extension/holder clearance.
- Two confirmed log subscriptions supply bounded hints (48 per program).
  They are renewed every five minutes in addition to web3's own reconnects.
  RPC history reconciliation runs independently of websocket delivery.
- At most 24 HTTP RPC requests per minute, with a ten-second work deadline
  (an already-started RPC can take its normal twelve-second timeout).
  All program/ProgramData reads count. No full-program account enumeration,
  unbounded transaction decode, paid AI or transaction submission occurs here.
- History pages contain at most 12 signatures. Each program gets at most four
  decoded transactions per pass. Log hints and pending history share the
  allocation. The latest page is the explicit bootstrap sample, **not** a claim
  to full historical coverage.
- Subsequent recovery pages use `before` and the last completed `until` head.
  The old head is retained until the page queue and recovery boundary finish.
  Pending signatures, hints and verified records are saved atomically in the
  owner's existing PostgreSQL ledger. An unavailable transaction/account or
  failed RPC retains its signature for retry. Restart cannot reset the persisted
  minute throttle. Saturation/backlog is reported as incomplete coverage.
- Store at most 120 records for 24 hours. Retention is based on observation
  time, **never** used as token age. Unknown/future chain block times stay unknown.

The existing worker refreshes launch discovery while running, after exit
monitoring and separately from the market/AI scan interval. Manual scans also
recover the feed. Paused consoles do not claim continuous discovery. Read-only
verification mode still disables the background trading/AI worker.

## Fail-closed market evidence

Unindexed launches remain visible with `marketDataStatus=awaiting_market_data`
and an explicit `missingMarketData` list. Numeric zeroes maintain compatibility
with the existing candidate contract but are not presented as real prices,
liquidity or activity. Creation block time can establish age; local observation
time cannot. A verified launch with real indexed market evidence can leave the
waiting state. Missing provider activity, price change or age is distinct from
an observed zero and blocks entry even if a configurable threshold is zero.

Waiting candidates never enter the automatic paid-assessment queue. Manual
assessment and the final buy path independently recheck market evidence.
All existing liquidity, age, holder concentration, mint/freeze authority,
Token-2022 extension, AI interval/cap, executable buy/sell route, sizing,
reserve and loss gates remain applicable. No prices, volume or buys are
fabricated from a creation event.

## Sources

- Pump official IDLs: https://github.com/pump-fun/pump-public-docs/tree/main/idl
- Meteora DBC SDK: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk
- Bags official program identities: https://docs.bags.fm/principles/program-ids
- Bags official launch-feed schema (requires its own API key; not used by this
  RPC-based implementation): https://docs.bags.fm/api-reference/get-token-launch-feed

Tests use mocked logs, transactions, account layouts, persisted restarts and
provider failures. No funded wallet, paid model call or broadcast is required.
