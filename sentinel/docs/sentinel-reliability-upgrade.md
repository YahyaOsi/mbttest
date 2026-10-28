# Sentinel reliability upgrade

## Implemented

### Critical execution reliability

- Allowlisted wallet/mint/account/supply/holder reads can fail over from an unavailable primary to configured secondaries. Mainnet identity and slot freshness are checked. No public, guessed or cross-network endpoint is substituted.
- Simulations, blockhash refresh, expiry fencing, signature reconciliation and ordinary broadcasts remain primary-only. Background requests stay off primary.
- Every balance attempt logs safe endpoint ID, method, duration and success/failure. Health exposes primary availability/verification, balance attempts/failures and read failovers. Counters reset on process restart; the trade journal does not.
- Optional Jito single-transaction bundles default OFF. Dynamic tips are bounded by both 0.25% principal and 100,000 lamports by default. Less than the 1,000-lamport minimum means no Jito attempt.
- Tip discovery failure before signing uses a normal transaction. An uncertain/failed bundle send falls back through primary with **the same signed bytes and signature**, including its capped atomic tip. No separate tip transaction, duplicate order or replacement blockhash is created. A fallback can therefore still pay the tip.
- First-minute snipes and observed live bursts can use a configurable 2× priority-price multiplier. The existing 0.001 SOL priority-fee ceiling and all-in execution overhead guard remain.
- Durable pending state stores tip, recipient, bundle ID, signed priority fee and simulation evidence. Finalization adds inclusion slot/block time, observed finalization time, slot delta, latency, actual network fee and output-vs-quote evidence.
- Candidate labels are reconciled against immutable watch deadlines and actual pending/position state. Stale “watching” labels no longer inflate the active-watch tab.

### Strategy, filters and equity risk

- Confidence combines liquidity, actual observed top-ten concentration, recent buy velocity, progress, live burst evidence and fresh AI score. It is a ranking, **not a probability**.
- No concentration override can pass 25% or a stricter saved ceiling. Creator, revoked authority, extension, canonical launchpad and permanent ordinary-LP requirements remain hard checks.
- Strong fresh activity can nominate a 10–60% curve for primary scoring. Only actual holder proof plus high confidence authorizes the wider window. A nomination is not a buy authorization.
- Live burst evidence now requires distinct buying-wallet hints as well as transaction/volume/ratio evidence. Recent velocity is cached. The free feed still observes only a limited set of trade subscriptions, so missing burst evidence is not proof of no activity.
- A server-side secure WebSocket adapter interface permits an explicitly configured future feed. No paid service, billing or credential has been enabled.
- New paid-AI default: 100 calls/day. Sweeps reserve the shared budget and prefer candidates with basic liquidity and buying. Crazy AI is advisory; deterministic checks continue if the budget is exhausted. Paid attempts already consumed are not reset by migration.
- Normal Crazy entries default to 8% equity; only high-confidence snipes can use up to 15%. Conservative fixed-dollar entries are unchanged. Small orders still must pass the minimum size, fee/rent, projected return, SOL reserve and reverse-route checks; sizing is never increased just to force a fill.
- Effective daily loss cap is the smaller of the dollar limit and 20% × smaller current/day-start equity. Strategy displays equity, estimated open risk and daily loss remaining. Open risk is a stop-distance estimate, not maximum possible loss.
- New positions retain 0.1% by default, configurable including zero. Existing raw retention snapshots are never reduced.

### Data, diagnostics and exits

- Broad discovery remains two minutes; qualified live Pump/copy signals can independently wake the execution path. This deliberately avoids increasing broad RPC load without measured capacity.
- Stale market data remains rejected. Confidence requires strong activity to be fresh within 15 seconds. No paid price source was silently connected.
- The append-only database journal persists per-scan summaries, market outcomes, primary checks, scoring/rejection reasons and order dispatch/finalization beyond the rolling 500-event activity buffer.
- Owner-only diagnostics: `GET /api/sentinel/diagnostics`; also shown on Strategy. Last-24-hour funnel counts and latest 50 journal entries do not reconstruct unavailable older logs.
- New adaptive exit snapshots: 20% original at +60%, 50% at +100%, 20% at +150%; trail the tradable remainder. At large high-water gains, trailing tightens from the configured value toward 10%/8%. Existing plans remain unchanged.
- Volatility uses sampled SOL-price log returns and can only tighten the configured hard stop. Liquidity red flags continue to bypass normal valuation completion and request protective sells. No successful or instant exit is guaranteed during provider/route outages.

## Accounting and metric limitations

- Finalized wallet movement—not a quote—determines native SOL accounting and realized P&L.
- Priority fee evidence is the finalized signed compute-unit price × requested unit limit, rounded up; total fee is from transaction metadata. Inclusion block time has chain timestamp precision, not millisecond accuracy.
- Buy token output uses finalized owner token balances. Sell output/slippage separates actual fee from wallet proceeds using the recorded **simulation rent estimate**; rent is explicitly labelled estimated, not falsely reported as fully audited actual rent.
- Sign-to-finalized is elapsed time to observation, including reconciliation scheduling delay. Jito acknowledgement is not inclusion.
- Journal writes are transactional with account saves. A missing/unavailable journal schema fails closed rather than allowing a trade whose pending ledger was not durably committed.
- Tests and compilation demonstrate behavior, not positive expectancy, a higher win rate, exhaustive discovery or profitable live execution.

## Verification and publishing

- 193 offline tests passed, including simulated execution/recovery, RPC role isolation, Jito immutable bytes, scoring, watch state, retention and adaptive tiers.
- Workspace type checking and production frontend build passed.
- Development remains read-only, with trading/paid-AI workers disabled. No funded order, production setting update or publish was performed.
- The new database table is additive. Review/apply the production schema change in the publishing flow before the new worker runs; never create it through startup DDL.
- Jito remains off until explicitly saved by the owner. Review risk settings while paused before a live restart. Existing exposure retains its prior snapshots.
