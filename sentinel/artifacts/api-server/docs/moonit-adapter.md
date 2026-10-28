# Verified secondary launchpad scope

Checked 2026-10-27 against the official [Moonit Bot SDK docs](https://docs.moon.it/docs/bot-sdk), [SDK repository](https://github.com/gomoonit/moonit-sdk), and published `@moonit/sdk` 1.5.0.

## Approval boundary

Only standard constant-product V1 active curves on `MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG` are supported. The official V4 IDL supplies the curve/config/event layouts; the SDK supplies local math and instruction builders. Flat, anti-snipe/backend-signed buys, linear, V2, altered supplies/decimals/thresholds, and migrated curves fail closed.

Independent evidence includes canonical curve/config/token-vault PDAs; program/ProgramData loader linkage; revoked mint/freeze authorities; exact initialized SPL supply and vault balances; no vault delegate/close authority/freeze; actual SOL collateral after rent; official fee destinations and supported fee schedule; and the confirmed creation transaction's creator/backend signers. The backend must match current global configuration. Creator may not equal migration/backend/config authorities. The official IDL's migration requires both protocol authorities; no creator-withdraw route is approved. This relies on the official deployed protocol, not a claim that its operators or upgrade authority cannot act maliciously.

Creator portfolio≤10% and the conservative top-ten non-curve wallet bound<25% remain required. Only the verified canonical token vault is excluded; all unobserved supply counts against the bound. Existing progress, reserve, spending, loss and pending-order limits remain.

The SDK provider is offline by design. No SDK API call, provider RPC, key, submission or broadcast is used. All reads go through the existing pinned RPC. Local quote/build validation independently checks exact input, minimum output, fixed-side/slippage bytes, canonical account metas and unsigned message authorization; the existing signer additionally simulates native-SOL/token deltas and preserves permanent1% retention.

## Discovery and recovery

Ten-nomination work target: eight Pump.fun/two Moonit when both have sufficient verified nominations. Missing capacity spills to the other approved source. Work is interleaved; only attempted work advances durable source turns/cursors. Creator/source records survive restart and older held positions retain their origin proof. The 120-record store reserves secondary capacity to prevent a Pump flood from evicting all Moonit records.

The shared recovery cap is24 RPC calls/minute, with at most five secondary reads and unused capacity returned to Pump. Cached source controls are connection/generation-bound; final quote/signing proof stays fresh. Confirmed program logs supply observed activity, not invented24h totals or creation ages. Unsupported/missing evidence remains pending/rejected. Status reports actual attempted source counts, not just planned ratios. Coverage is bounded, not exhaustive.

## Disabled names

Research found a [StonkFun report](https://www.theblock.co/news/defi/2026-09-06-stonk-surges-250-to-140-million-market-cap-as-stock-paired-solana-launchpad-stonkfun-pulls-volume-to-raydium-and-jupiter-413621) describing shared Raydium LaunchLab infrastructure, while [Stonk Pad](https://stonkpad.xyz/docs) describes an EVM-style Uniswap platform. Neither independently establishes the requested Solana brand's exclusive program and creator control restrictions.

[PONS launchpad](https://www.ponsfamily.com/launchpad/create) describes ETH/Robinhood-chain launching; [Pons Finance](https://www.pons.finance/) likewise names Robinhood. No independently verified official Solana PONS program/control adapter was found. These names remain disabled, not mapped to a generic pool or DBC.

## Verification

Independent raw curve/config/mint/vault buffers cover decoding, authority/control rejection and native exact-input unsigned builds. Fixture simulations never submit a transaction. Recovery/retention/allocation tests cover limits, source fairness and restart. A separate read-only public mainnet diagnostic verified the live program and supported global controls; the configured workspace RPC was unavailable during its diagnostic. The active RPC was not changed. Real funded execution is not claimed or tested.
