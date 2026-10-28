# Sentinel Pump hunt

## Activation and production boundary

Implemented and verified in the workspace; this is not evidence of production activation or a funded fill.

1. Publish the updated app.
2. While paused, open Strategy and choose **Apply Pump hunt preset**.
3. Review the live-risk acknowledgements, effective rules and settings, then save.
4. Use **Start** on Dashboard. The authenticated control clears the owner halt latch, requests a fresh wallet balance, and retains blocks for unavailable pricing/setup/balance, pending reconciliation or daily loss protection. A failed read is not a healthy balance.

No code migration silently starts live trading. Emergency handling, single-pending-signature protection, primary-only transaction expiry/reconciliation and the existing 5× goal remain. Old errored position records are not deleted or treated as verified wallet exposure.

## New-entry preset

| Rule | Value |
|---|---|
| Preferred real liquidity | $600 |
| Conditional lower floor | $400 only with ≥3 buys, ≥1.3:1 buy/sell and ≥$200 five-minute volume |
| Hard floor | $400; stricter saved preferred floors remain strict |
| Recent activity | At least one observed buy; missing data is not proof of zero activity |
| Active native Pump curve | 0–95% with observed buy bias |
| Confidence | Finite score ≥40 after safety proof; evidence ranking, not win probability |
| Holder limits | Observed top-ten ≤40%; score penalty above 30%; individual holder ceiling 40% |
| Creator | ≤10%, still verified on-chain |
| Mint | Initialized positive supply, revoked mint/freeze, benign supported extensions only |
| Graduated/ordinary pools | Existing canonical/permanent LP proof; unknown lockers still blocked |
| Market freshness | ≤60 seconds |
| Snipe age | ≤10 minutes; 12% sizing additionally requires stronger fresh early evidence |
| Sizing | 6% normal, ≤12% highest-confidence early snipes; no result multiplier |
| Positions / cooldown | Three; 30 seconds |
| Daily loss | Smaller of saved dollar cap and 20% of smaller current/day-start equity |
| Slippage / priority | 10%; bounded dynamic priority, existing 0.001 SOL ceiling |
| AI | Advisory only; deterministic requests work at exhausted budget |

Soft liquidity is not permission to bypass mint, creator, holder, quote, simulation, fee, balance or pending checks. Missing holder data may nominate proof, never authorize a fill. No auto-upsize to overcome fees. At approximately $18 equity the normal budget is approximately $1.08; rent/slippage/network overhead can still make it ineligible for execution.

## Activity coverage

Every received creation remains queued for authority checks, subject to secondary provider throughput and a ten-minute expiry. The five free trade subscriptions retain the newest mint and velocity leaders while rotating other slots. This is partial coverage, not a complete transaction stream.

Existing fresh indexed activity remains usable independently of missing price-change fields. One observed native trade now supplies actual activity. Missing trade evidence can trigger a detached, serialized secondary-only fallback: up to five recent signatures, a global maximum of four RPC calls/minute including transaction fetches, confirmed authentic Pump-program log decoding, five-minute timestamps and existing signature deduplication. Background failure does not change primary wallet health. No archive creation verification or invented trades.

## New-position exits and reporting

- Sell 45% of original tokens at +60% net SOL gain.
- Sell another 30% original at +100%.
- Trail 15% from the first profit tier; retain the configurable 0.1% protected reserve.
- Hard stop 20%; maximum 45 minutes for snipes, 60 minutes otherwise.
- Existing liquidity-drop, creator/curve panic and excessive-sell exits remain independently active. Quotes, congestion and provider outages can prevent/delay exits.
- Legacy position snapshots and protected raw balances remain unchanged.

Screening records include observed buys/sells/volume, market age, curve progress, confidence, missing evidence and exact outcomes. The diagnostics funnel splits candidate outcomes and tags the policy, so new hunt activity is distinguishable from earlier rejects. Finalized order records include realized SOL/USD P&L, elapsed hold time, actual output versus quote, fees and confirmation timing. No records are fabricated before trades exist.

## Verification

- 204 offline tests passed, including eleven hunt-policy/eligibility/rotation/exit/journal tests.
- Workspace typecheck and frontend production build passed.
- Fixture-only browser checked preset, exact settings payload, save/reload and mobile layout, with all API requests intercepted. No Start request occurred.
- Corrected the browser-discovered legacy 20% sizing statement in the live confirmation; final type/build checks passed.
- Development remains read-only. No production setting changes, publishing, funded submissions or live-profit tests were performed.
