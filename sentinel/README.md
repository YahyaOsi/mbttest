# Sentinel — developer handoff

This is a TypeScript/Node Solana trading application with a React dashboard, an Express API and a continuously scheduled worker. It discovers tokens, records screening evidence, manages a persistent 15-minute watchlist, optionally uses advisory AI and verified leader-wallet signals, and manages native-SOL positions. It supports paper trading and explicitly authorized server-signed mainnet execution.

**No win rate, positive return, complete market coverage or instant exit is guaranteed. This is experimental, high-risk trading software, not a production-safety certification.**

## Handoff boundary and safety

The downloadable export includes current source, tests, source assets, generated API **source** clients, dependency manifests/lockfile, database schema/bootstrap logic, protocol adapters, configuration, scripts and documentation. SDK-provided IDLs/ABIs arrive through the pinned SDK dependencies during installation; no separate proprietary ABI file is required by repository source.

It excludes real `.env` files, credentials, wallet/keypair files, live PostgreSQL contents, encrypted RPC configuration, sessions, Git history, agent/private workspace metadata, unrelated uploads, dependencies, caches, build products and raw logs. `sample-logs.txt` contains selected, sanitized operational examples instead. The archive's `.replit` flags are set to read-only with mainnet disabled; the working deployment is not modified by exporting.

**This is not an operational database migration.** A fresh database does not know old pending signatures, open/error/retained positions, protected token balances, acquisition cost, watch deadlines, loss baseline or the 5× target baseline. Before replacing a running instance: owner-stop it, reconcile all transactions and exposure, securely arrange any necessary state migration separately, and ensure only one instance can sign for a wallet. Do not point a fresh empty ledger at the old funded wallet and assume it is safe.

## Runtime and dependencies

- Verified workspace runtime: **Node 24.22.1**, **pnpm 10.26.1**. `.replit` selects Node 24 and PostgreSQL 16. Use Node 24 and PostgreSQL 16 as the baseline; other versions have not been certified.
- TypeScript 5.9.x; React/Vite/Tailwind frontend; Express 5/Pino backend; PostgreSQL/Drizzle persistence; OpenAPI/Orval-generated clients and Zod validators.
- Solana web3.js **v1** (`^1.98.4`), SPL Token `0.4.14`, Pump SDK `4.3.1`, Meteora DBC SDK `2.0.0`, Moonit SDK `1.5.0`. Do not substitute web3.js v2+ without refactoring synchronous signing/transaction APIs.
- Python 3 is used only for the optional sanitized-export utility, not for trading.
- Every direct dependency is listed in the ZIP README appendix with its package/constraint. `pnpm-lock.yaml` is the authoritative complete transitive dependency graph, resolved versions and integrity hashes. `catalog:` resolves through `pnpm-workspace.yaml`, and `workspace:*` means one of the included local packages.

### Portability warning

The original `pnpm-workspace.yaml` intentionally overrides away many non-Linux-x64 native packages. Start on Linux x86-64. macOS, ARM or Windows may require reviewed adjustments to those overrides and regeneration of the lockfile; the provided lockfile has not been tested there. Do not simply remove all security overrides or the minimum package release-age defense.

## Installation and configuration

1. Extract the ZIP to a private directory. Install Node 24, pnpm 10.26.1 and PostgreSQL 16 using your host's supported package manager.
2. Run `pnpm install --frozen-lockfile` at repository root. Do not use npm/yarn; the preinstall guard requires pnpm.
3. Copy `.env.example` to `.env` locally. Supply a **new** database and **new** console password/session secret. Never commit the real file. The example lists every source-referenced configurable environment variable, including dynamically addressed RPC slots 1–6; Vite's two built-in environment properties are explained there.
4. The app does not import dotenv. In a POSIX shell, load the file explicitly:

   ```sh
   set -a
   . ./.env
   set +a
   ```

   Only source a configuration file you trust. On a hosted service, configure the environment with its secret manager instead.
5. Create the empty `sentinel` database and a restricted application role. The application needs schema creation/alteration rights during bootstrap (or have an operator provision the schema first). Run:

   ```sh
   pnpm --filter @workspace/db run push
   ```

   Drizzle covers the exported shared schema. Sentinel's JSON ledger, controls, sessions and screening journal also use explicit bootstrap SQL in the server source on first use. There is no exported production dump or complete versioned SQL migration history; inspect `CREATE TABLE`/`ALTER TABLE` statements before giving production DDL privileges. Never run `push-force` on a database containing positions without a backup and review.
6. Leave `SENTINEL_READ_ONLY=true` and `ENABLE_MAINNET_TRADING=false` initially. Blank signing key means no wallet is configured. The AI client currently validates its base URL/key **at import time**, even in read-only/deterministic workflows; the clearly marked offline placeholder permits construction, not actual requests. Use actual supported AI credentials only if testing AI. Database URL must also be set at import time.

### Verify without trading

```sh
pnpm run typecheck
pnpm --filter @workspace/scripts exec tsx --test --test-concurrency=8 ../artifacts/api-server/tests/*.test.ts
pnpm --filter @workspace/api-server run build
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/solana-sentinel run build
```

The source snapshot had 204 offline tests passing, a passing typecheck and frontend production build. These are fixture/simulation checks, not proof of profitable or funded execution. Fresh-machine dependency installation and cross-platform behavior have not been independently certified by this handoff.

### Start the API and dashboard

```sh
# Terminal 1, after loading .env
PORT=8080 pnpm --filter @workspace/api-server run dev

# Terminal 2, also load .env; browser assets only, no signing secrets are exposed
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/solana-sentinel run dev
```

The Vite server does **not** proxy `/api` itself. Replit's artifact router normally combines services. Outside Replit, provide a same-origin reverse proxy: `/api/*` to API port 8080, and `/` to Vite port 5173 during development or the built `artifacts/solana-sentinel/dist/public` directory in production. An HTTPS browser origin is required for secure owner cookies and write-origin checks. Opening raw HTTP localhost and finding login/write requests blocked is not sufficient evidence of a trading failure.

For production, build the API/frontend as above and run:

```sh
NODE_ENV=production PORT=8080 pnpm --filter @workspace/api-server run start
```

Serve the frontend build and proxy the API through TLS. Example Nginx shape (replace paths, hostname and TLS material securely; these are not supplied):

```nginx
server {
  listen 443 ssl;
  server_name sentinel.example.invalid;
  ssl_certificate /secure/path/fullchain.pem;
  ssl_certificate_key /secure/path/privkey.pem;
  root /absolute/path/sentinel/artifacts/solana-sentinel/dist/public;
  location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location / { try_files $uri $uri/ /index.html; }
}
```

The API trusts one proxy hop; do not expose it to arbitrary upstream proxy headers. Restrict the backend port with host/network controls. Use one continuously running worker instance per ledger/wallet; the code is not a distributed multi-instance trading coordinator.

### Paper mode versus read-only

- **Read-only** disables the automatic trading/AI worker. It is suitable for inspection; it does not simulate fills continuously.
- **Paper mode** uses simulated positions, but market discovery/quotes can still consume real RPC/API resources and configured AI may be billable. Configure real read-only data access, keep `ENABLE_MAINNET_TRADING=false`, set `SENTINEL_READ_ONLY=false`, select Paper in Strategy, review and explicitly Start.
- **Live mode** additionally requires a server-only dedicated burner keypair, confirmed signer address/setup, healthy dedicated RPC and quote routes, fee reserve, risk acknowledgements, always-on attestation and explicit `ENABLE_MAINNET_TRADING=true`. Never use a main-wallet seed phrase. No key, password or provider credit transfers with this archive.
- Stop and Emergency are owner controls. Scanner errors should not silently change owner run intent, but safety, loss limits, target reached and unresolved orders can stop new entries. A continuous worker does not mean entries must always be authorized.

## Strategy and execution

Settings persist in PostgreSQL. Defaults, migration logic and per-position snapshots differ; this source export cannot certify the exact settings currently saved in the old production database. `replit.md` is historical/project context, not a substitute for the current effective settings and exit snapshots.

### Explicit Pump hunt preset (opt-in, not enabled by exporting)

| Rule | Effective preset |
|---|---|
| Modes | Live/Crazy/all deterministic strategy nominations; owner save/start required |
| Liquidity | Preferred $600 real reserves; $400–$600 only with ≥3 buys, ≥1.3 buy/sell bias and ≥$200 five-minute volume; hard floor $400 |
| Normal activity | ≥1 actual observed buy; unknown data is not proof of inactivity or safety |
| Active Pump curve | Canonical verified curve, 0–95% with observed buy bias; no legacy LP-lock demand |
| Confidence | Finite score ≥40; this is not a win-probability percentage |
| Concentration | Observed top-10 ≤40%; score penalty above 30%; individual ceiling 40%; creator ≤10% |
| Authority / extensions | Initialized positive supply, revoked mint/freeze, supported benign Token-2022 only |
| Graduated / ordinary AMM | Existing canonical/permanent on-chain LP-protection verification required |
| Sizing | 6% current equity normal; at most 12% highest-confidence early snipes; no dollar cap, no auto-upsize to force fills |
| Snipe / data age | Snipe ≤10 minutes; market ≤60 seconds; stronger/high-sizing evidence must be fresher |
| Capacity / cooldown | 3 open positions; 30-second per-mint attempt pacing; serialized orders |
| Loss | Both saved dollar cap and 20% of smaller current/day-start equity; no daily trade-count cap |
| Slippage | 1,000 bps (10%); quote/impact/round-trip/simulation checks still apply |
| Priority | Bounded adaptive fee; 2× snipe multiplier; existing 0.001 SOL ceiling; optional capped Jito tip/bundle |
| Profit tier 1 | Sell 45% of original tokens at +60% net SOL gain |
| Profit tier 2 | Sell another 30% original at +100% net SOL gain |
| Remaining | 15% trailing stop after first tier; 0.1% protected holdback preset |
| Hard/time exits | 20% hard stop; 45-minute snipe / 60-minute other maximum hold; existing panic checks remain |

At about $18 equity the normal order is about $1.08. ATA rent, route fees and the slippage stress test can already breach a 20% stop budget and reject it. Do not mistake a nominally eligible token for an executable, economically viable entry.

Ordinary Crazy is a separate policy: normally $1,000 real liquidity, stricter 25% top-ten concentration, shorter snipe/freshness windows and different confidence/sizing defaults. Conservative mode retains dollar sizing, age, liquidity, volume and AI requirements. Read `store.ts`, `crazy-policy.ts`, `confidence.ts`, `pump-hunt-policy.ts` and effective settings rather than applying the hunt table to every mode.

Exits use original-token portions and per-position snapshots; changing settings does not rewrite old positions' protected raw balances or exit plans. Gains are evaluated in SOL, not just USD appreciation of SOL. Transfers out are reconciled from wallet balances without inventing sell fills. Retained tokens prevent full ATA closure, so rent may remain committed.

### Discovery, watchlist, AI and copy trading

- Background discovery is every two minutes; watchlist AI normally every five minutes, general AI sweep normally ten minutes. Configured schedule overrides/migrations exist.
- Fifteen-minute watch deadlines persist across refresh/restarts. Exhausted paid-AI budget invokes deterministic evaluation. Crazy AI is advisory and cannot grant safety permission. Budget limits are saved settings; do not assume an earlier requested 1,440 cap remains the current database value (rollout defaults/migrations include a 100-attempt cap).
- Live Pump events feed immediate nominations. Free trade subscriptions cover five rotating targets, not every mint/trade in the market. The source keeps newest/hot targets plus rotation. Recent activity fallback is secondary-only, globally four RPC calls/minute, detached from priority execution. Historical indexed discovery remains partial/recoverable.
- Copy trading uses manually entered public wallets and separately toggled handle/FOMO tracking. Wallet streams use dedicated secondary logs subscriptions, verify actual on-chain buys and de-duplicate signatures. Provider support, lag, chase limits and sold/demoted leaders can block copies. Transfers are not automatically buys.
- FOMO daily rankings come from independent `api.fomo-api.com`, not an official FOMO guarantee. X posts/social sentiment are **not connected**; usernames must resolve to independently verifiable wallets. No universal direct X-account monitoring feature is implemented.
- Durable candidate/order journals expose screening, eligibility, proof/quote/dispatch/finalization and rejection reasons. Journal events tag hunt versus standard policy. Finalized entries include output/fee/slot timing; realized P&L and hold time are also recorded. Historical data is not in this export.

### RPC and swap routing

Environment endpoints are numbered 1–6; numbered entries supersede `SOLANA_RPC_URL`, with duplicates removed. The third **distinct configured endpoint** is primary when available; fewer endpoints fall back to the pool's defined primary selection. Owner-encrypted Setup overrides can replace environment endpoints, but are not exported. Review `rpc-pool.ts` if slot topology changes.

Background discovery/feeds use non-primary endpoints. Allowlisted fresh wallet/safety reads can fail over to verified secondary endpoints when enabled. Ordinary signed transaction preparation, simulation, broadcasts and signature/blockhash reconciliation stay primary-bound. An explicitly enabled Jito bundle is submitted to Jito as a separate route. An unhealthy primary can therefore still prevent execution even when secondary scanning works.

Supported routes include Jupiter, direct allowlisted Raydium and native verified launchpad adapters. Metis/Ultra compatibility probes, exact-in/out amounts, mint/program/account ownership, spend allowance, price impact, slippage and simulation remain mandatory as appropriate. An absent signature is not a dropped transaction: release requires recorded block-height expiry or another explicit reconciled terminal result. Never manually erase an unresolved lock to force new orders.

## APIs and services

| Service | Usage / limitations |
|---|---|
| Solana JSON-RPC / WebSocket | User-supplied providers (e.g. Helius); reads, wallet subscriptions, program logs, simulation, signing dispatch/reconciliation. Public mainnet fallback exists but is not a production-throughput guarantee. |
| Jupiter `api.jup.ag` | Token discovery, pricing/activity and authenticated quote/swap APIs; `JUPITER_API_KEY` required for relevant calls. |
| DexScreener `api.dexscreener.com` | Indexed pairs, liquidity, prices and market fallback. Indexing lag/missing fields are possible. |
| Pump SDK / Pump.fun index | Native canonical Pump curve instructions/state and historical public coin discovery; PumpSwap/graduation proof separate. |
| Pump live feed `wss://pumpdev.io/ws` | Hardcoded free default with owner feed configuration support; independent service, five subscription slots, reconnect/rate/coverage limitations. |
| Raydium `transaction-v1.raydium.io`, `api-v3.raydium.io` | Direct swap routes, pool keys and validated graduation/LP evidence. |
| Meteora DBC SDK | Canonical DBC state/market and execution adapter; DBC alone is not proof of Bags branding or permanent safety. Removable/unverified liquidity is blocked. |
| Moonit SDK | Program/version-aware adapter; don't apply legacy Moonshot/Raydium labels to newer SDK migration enums. |
| Jito block engine | Optional bundle/tip path at hardcoded mainnet block-engine endpoint; caps/confirmation required, not guaranteed inclusion. |
| OpenAI-compatible provider | Eagerly constructed client; model `gpt-5-nano` in decision code; Replit proxy or separately configured compatible external provider/account. |
| Fomo Api | Optional independent daily leader rankings, followed by wallet verification; not an official social/firehose API. |
| PostgreSQL | Ledger, controls, sessions, candidate watch state and diagnostic journals; required even for normal app inspection. |
| Clerk | Installed legacy integration code; current single-owner password console is the operative auth path. Not a required paid signup dependency. |
| Replit | Existing workflow/artifact routing/tooling metadata is retained; external deployment needs equivalent routing and secret management. |
| Birdeye / Telegram / official X API | Not implemented/connected; no credentials for these are required by current source. |

Public addresses for programs, token mints, vaults and tip accounts are protocol identifiers, not private signing keys; they are intentionally retained.

## Known bugs, errors, limitations and unfinished work

This is an evidence-based handoff, not a claim that every possible bug has been discovered. `ERROR-MESSAGES.md` in the export lists source error literals by file/line, including guard conditions that are not themselves defects.

1. **Intermittent primary RPC failures are observed.** Recent sanitized `getBalance` failures and successful secondary recoveries are included. Providers can rate-limit, timeout or reject subscriptions. User-visible historical messages include `Wallet balance RPC unavailable. New entries paused.`, `Provider operation failed. Trading did not proceed; retry or review connections.`, and `RPC unavailable, unsupported, or timed out. No endpoint was changed and no trade was authorized.` Entry restrictions must not be cleared solely because a timer elapsed.
2. **Economic feasibility can yield zero orders despite many scans.** Exact current guard: `Estimated fees, account rent and slippage would already breach the stop loss at this small position size. Entry skipped.` Another is `Estimated round-trip trading cost exceeds ${maxRoundTripLossPct}% before network costs.` These are protective rejections, not proof the scanner froze.
3. **Unresolved signatures must be reconciled.** The user reported `Unresolved transaction signature`. The implementation records expiry and checks primary status/block height. Old orphaned/durable-nonce orders or unavailable primary evidence may need explicit recovery; unknown is not failure. A clean source install does not recover old pending database state automatically.
4. **Incomplete live activity/holder evidence remains possible.** The former fewer-than-two-trades rejection was fixed to accept one actual trade; free subscriptions still cannot cover all Pump mints. Missing data can retain a watch or reject it at expiry. Partial non-vault holder samples are not invented as top-ten ownership, but unproven safety still blocks.
5. **Token-2022 is extension-specific.** The program ID alone is no longer rejected; revoked authorities with supported safe extensions pass. Dangerous/unknown/malformed extensions still fail closed. Not every possible Token-2022 transfer feature is supported.
6. **Pool/launchpad coverage is limited.** Permanent LP verification is conservative; some legitimate lockers, old Pump migrations, Stonk/PONS branding or new SDK/protocol variants may lack a supported canonical adapter. A name or Pump suffix is not authoritative proof.
7. **AI is not a social-data integration or win-rate predictor.** No X post/community authenticity verification exists. Imported client initialization still requires AI env placeholders even when no AI is intended; readiness text can reflect configuration presence rather than a successful authenticated provider request.
8. **Paper/fixtures are not mainnet validation.** Offline tests use mocked RPC/API responses and temporary generated test identities. No funded acceptance test was performed for the latest hunt changes. Fees/rent estimates and paper fills are approximations.
9. **Legacy configuration text can disagree with new opt-in policy.** Historical docs/default migration notes and some ordinary-mode strategy notices describe older windows/tiers. The hunt preset, effective settings and saved per-position plan determine behavior. The stale 20%-entry confirmation was fixed to show normal/snipe sizing.
10. **Legacy/error position records are not automatically discarded.** These may require wallet reconciliation and operator review. Error status is not proof that a token vanished or that it remains sellable.
11. **Single-instance architecture and runtime bounds.** Serialized pending orders are not a distributed process lease. The system uses RPC budgets, bounded concurrency, caches/TTL, rotating subscriptions and partial historical indexing; it is not an unlimited archive crawler or guaranteed sub-100ms executor.
12. **External portability needs work/review.** Platform-specific pnpm overrides, external TLS/proxy setup, API credentials, provider capabilities and local database bootstrap are not auto-provisioned. The public RPC/default WebSocket/model names are hardcoded defaults. Production behavior depends on independently configured services.
13. **Non-fatal observed runtime warnings:** `bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)` and Node `[DEP0040] DeprecationWarning: The 'punycode' module is deprecated. Please use a userland alternative instead.` These are included as operational examples, not a reason to disable safety.
14. **Scanner rendering is paginated/memoized but data transfer can still grow.** The UI indexes rows in a worker and pages in groups of 50; large server-side candidate state/JSON/database reads remain a scaling consideration. No performance SLA is provided.
15. **No automated post-hours outcome is fabricated.** Hunt funnel tagging and realized-output metrics exist, but a later profitability/funnel report needs real runtime observations and a safely supplied ledger.

Known questions still requiring independent verification include older Pump.fun→Raydium migrations and Jupiter compatibility against recorded unsigned routes. Review the protocol coverage docs and tests before broadening allowlists. There is no proprietary externally hosted strategy service bundled into this export, nor a guarantee Stonk/PONS-specific verification is finished.

## Source map

- `artifacts/api-server/`: Express API, owner auth, RPC/market/protocol integrations, strategy/worker/order state machine, offline tests.
- `artifacts/solana-sentinel/`: React dashboard, scanner, watchlist, positions, strategy/connections and diagnostics UI.
- `artifacts/mockup-sandbox/`: Optional visual prototype sandbox; not the trading worker or production requirement.
- `lib/api-spec/`: OpenAPI contract and Orval config.
- `lib/api-client-react/`, `lib/api-zod/`: Generated TypeScript API client/hooks and validation source; retained intentionally.
- `lib/db/`: PostgreSQL/Drizzle connector and shared schema.
- `lib/integrations-openai-ai-server/`: OpenAI-compatible client and utility functions.
- `scripts/`: Existing workspace utilities and repeatable sanitized-export utility.
- `docs/`, API-server docs and `replit.md`: Protocol/risk/operational documentation; historical notes may describe superseded defaults.
- `.replit`, artifact manifests: Replit routing/workflows; not a substitute for an external HTTPS proxy.

The export builder appends the full direct-dependency inventory and a **one-line description for every included file** below. `EXPORT-MANIFEST.json` includes SHA-256 hashes for all other archive members, exclusions and validation scope. Rebuild a sanitized handoff with `python3 scripts/export-sentinel.py` (Python standard library only).


## Complete direct dependency inventory

Constraints are exactly as declared. See the lockfile for resolved transitive versions.

| Workspace manifest | Dependency type | Package | Constraint |
|---|---|---|---|
| `artifacts/api-server/package.json` | dependencies | `@clerk/express` | `^2.1.83` |
| `artifacts/api-server/package.json` | dependencies | `@clerk/shared` | `^4.41.1` |
| `artifacts/api-server/package.json` | dependencies | `@meteora-ag/dynamic-bonding-curve-sdk` | `2.0.0` |
| `artifacts/api-server/package.json` | dependencies | `@moonit/sdk` | `1.5.0` |
| `artifacts/api-server/package.json` | dependencies | `@pump-fun/pump-sdk` | `4.3.1` |
| `artifacts/api-server/package.json` | dependencies | `@solana/spl-token` | `0.4.14` |
| `artifacts/api-server/package.json` | dependencies | `@solana/web3.js` | `^1.98.4` |
| `artifacts/api-server/package.json` | dependencies | `@workspace/api-zod` | `workspace:*` |
| `artifacts/api-server/package.json` | dependencies | `@workspace/db` | `workspace:*` |
| `artifacts/api-server/package.json` | dependencies | `@workspace/integrations-openai-ai-server` | `workspace:*` |
| `artifacts/api-server/package.json` | dependencies | `bn.js` | `^5.2.5` |
| `artifacts/api-server/package.json` | dependencies | `bs58` | `^6.0.0` |
| `artifacts/api-server/package.json` | dependencies | `cookie-parser` | `^1.4.7` |
| `artifacts/api-server/package.json` | dependencies | `cors` | `^2.8.6` |
| `artifacts/api-server/package.json` | dependencies | `drizzle-orm` | `catalog:` |
| `artifacts/api-server/package.json` | dependencies | `express` | `^5.3.0` |
| `artifacts/api-server/package.json` | dependencies | `http-proxy-middleware` | `^4.2.1` |
| `artifacts/api-server/package.json` | dependencies | `pino` | `^9.14.0` |
| `artifacts/api-server/package.json` | dependencies | `pino-http` | `^10.5.0` |
| `artifacts/api-server/package.json` | dependencies | `ws` | `^8.22.0` |
| `artifacts/api-server/package.json` | devDependencies | `@types/bn.js` | `^5.2.0` |
| `artifacts/api-server/package.json` | devDependencies | `@types/cookie-parser` | `^1.4.10` |
| `artifacts/api-server/package.json` | devDependencies | `@types/cors` | `^2.8.19` |
| `artifacts/api-server/package.json` | devDependencies | `@types/express` | `^5.0.6` |
| `artifacts/api-server/package.json` | devDependencies | `@types/node` | `catalog:` |
| `artifacts/api-server/package.json` | devDependencies | `@types/ws` | `^8.18.2` |
| `artifacts/api-server/package.json` | devDependencies | `esbuild` | `0.28.2` |
| `artifacts/api-server/package.json` | devDependencies | `esbuild-plugin-pino` | `^2.3.3` |
| `artifacts/api-server/package.json` | devDependencies | `pino-pretty` | `^13.2.0` |
| `artifacts/api-server/package.json` | devDependencies | `thread-stream` | `3.1.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@hookform/resolvers` | `^3.10.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-accordion` | `^1.2.21` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-alert-dialog` | `^1.1.24` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-aspect-ratio` | `^1.1.16` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-avatar` | `^1.2.7` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-checkbox` | `^1.3.12` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-collapsible` | `^1.1.21` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-context-menu` | `^2.3.8` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-dialog` | `^1.2.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-dropdown-menu` | `^2.1.25` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-hover-card` | `^1.1.24` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-label` | `^2.1.16` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-menubar` | `^1.1.25` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-navigation-menu` | `^1.3.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-popover` | `^1.2.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-progress` | `^1.1.17` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-radio-group` | `^1.4.8` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-scroll-area` | `^1.3.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-select` | `^2.3.8` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-separator` | `^1.1.16` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-slider` | `^1.5.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-slot` | `^1.4.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-switch` | `^1.3.8` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-tabs` | `^1.1.22` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-toast` | `^1.2.24` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-toggle` | `^1.1.19` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-toggle-group` | `^1.1.20` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@radix-ui/react-tooltip` | `^1.3.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@replit/vite-plugin-cartographer` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@replit/vite-plugin-runtime-error-modal` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@tailwindcss/vite` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@types/node` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@types/react` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@types/react-dom` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `@vitejs/plugin-react` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `chokidar` | `^4.0.3` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `class-variance-authority` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `clsx` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `cmdk` | `^1.1.1` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `date-fns` | `^3.6.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `embla-carousel-react` | `^8.6.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `fast-glob` | `^3.3.3` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `framer-motion` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `input-otp` | `^1.5.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `lucide-react` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `next-themes` | `^0.4.6` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `react` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `react-day-picker` | `^9.14.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `react-dom` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `react-hook-form` | `^7.90.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `react-resizable-panels` | `^2.1.9` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `recharts` | `^2.15.4` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `sonner` | `^2.0.8` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `tailwind-merge` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `tailwindcss` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `tailwindcss-animate` | `^1.0.7` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `tw-animate-css` | `^1.4.0` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `vaul` | `^1.1.2` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `vite` | `catalog:` |
| `artifacts/mockup-sandbox/package.json` | devDependencies | `zod` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@clerk/react` | `^6.18.1` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@clerk/themes` | `^2.4.57` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@hookform/resolvers` | `^3.10.0` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-accordion` | `^1.2.4` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-alert-dialog` | `^1.1.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-aspect-ratio` | `^1.1.3` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-avatar` | `^1.1.4` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-checkbox` | `^1.1.5` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-collapsible` | `^1.1.4` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-context-menu` | `^2.2.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-dialog` | `^1.1.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-dropdown-menu` | `^2.1.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-hover-card` | `^1.1.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-label` | `^2.1.3` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-menubar` | `^1.1.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-navigation-menu` | `^1.2.6` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-popover` | `^1.1.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-progress` | `^1.1.3` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-radio-group` | `^1.2.4` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-scroll-area` | `^1.2.4` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-select` | `^2.1.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-separator` | `^1.1.3` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-slider` | `^1.2.4` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-slot` | `^1.2.0` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-switch` | `^1.1.4` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-tabs` | `^1.1.4` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-toast` | `^1.2.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-toggle` | `^1.1.3` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-toggle-group` | `^1.1.3` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@radix-ui/react-tooltip` | `^1.2.0` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@replit/vite-plugin-cartographer` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@replit/vite-plugin-dev-banner` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@replit/vite-plugin-runtime-error-modal` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@tailwindcss/typography` | `^0.5.15` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@tailwindcss/vite` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@tanstack/react-query` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@types/node` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@types/react` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@types/react-dom` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@vitejs/plugin-react` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `@workspace/api-client-react` | `workspace:*` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `class-variance-authority` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `clsx` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `cmdk` | `^1.1.1` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `date-fns` | `^3.6.0` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `embla-carousel-react` | `^8.6.0` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `framer-motion` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `input-otp` | `^1.4.2` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `lucide-react` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `next-themes` | `^0.4.6` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `react` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `react-day-picker` | `^9.11.1` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `react-dom` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `react-hook-form` | `^7.55.0` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `react-icons` | `^5.4.0` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `react-resizable-panels` | `^2.1.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `recharts` | `^2.15.2` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `sonner` | `^2.0.7` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `tailwind-merge` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `tailwindcss` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `tw-animate-css` | `^1.4.0` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `vaul` | `^1.1.2` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `vite` | `catalog:` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `wouter` | `^3.3.5` |
| `artifacts/solana-sentinel/package.json` | devDependencies | `zod` | `catalog:` |
| `lib/api-client-react/package.json` | dependencies | `@tanstack/react-query` | `catalog:` |
| `lib/api-client-react/package.json` | peerDependencies | `react` | `>=18` |
| `lib/api-spec/package.json` | devDependencies | `orval` | `^8.41.0` |
| `lib/api-zod/package.json` | dependencies | `zod` | `catalog:` |
| `lib/db/package.json` | dependencies | `drizzle-orm` | `catalog:` |
| `lib/db/package.json` | dependencies | `drizzle-zod` | `^0.8.3` |
| `lib/db/package.json` | dependencies | `pg` | `^8.23.1` |
| `lib/db/package.json` | dependencies | `zod` | `catalog:` |
| `lib/db/package.json` | devDependencies | `@types/node` | `catalog:` |
| `lib/db/package.json` | devDependencies | `@types/pg` | `^8.23.1` |
| `lib/db/package.json` | devDependencies | `drizzle-kit` | `^0.31.11` |
| `lib/integrations-openai-ai-server/package.json` | dependencies | `openai` | `^6.27.0` |
| `lib/integrations-openai-ai-server/package.json` | dependencies | `p-limit` | `^7.3.0` |
| `lib/integrations-openai-ai-server/package.json` | dependencies | `p-retry` | `^7.1.1` |
| `lib/integrations-openai-ai-server/package.json` | devDependencies | `@types/node` | `catalog:` |
| `package.json` | dependencies | `@replit/connectors-sdk` | `^0.4.3` |
| `package.json` | devDependencies | `prettier` | `^3.9.10` |
| `package.json` | devDependencies | `typescript` | `~5.9.3` |
| `scripts/package.json` | devDependencies | `@types/node` | `catalog:` |
| `scripts/package.json` | devDependencies | `tsx` | `catalog:` |

## Every exported file

| File | Purpose |
|---|---|
| `.env.example` | Placeholder-only environment configuration with safety defaults and per-variable comments. |
| `.gitignore` | Version-control exclusions for dependencies, generated artifacts and private configuration. |
| `.npmrc` | pnpm package-manager configuration. |
| `.replit` | Original Replit workflow/routing configuration, exported with read-only/mainnet-off safety flags. |
| `.replitignore` | Deployment exclusions including generated archives and private configuration. |
| `ERROR-MESSAGES.md` | Source-literal error/guard message inventory with file/line references. |
| `EXPORT-MANIFEST.json` | Archive inventory, sanitized-copy notes and per-file SHA-256 hashes. |
| `README.md` | Complete handoff, installation, strategy, known issues, dependencies and file inventory. |
| `artifacts/api-server/.replit-artifact/artifact.toml` | Replit artifact service and preview/publish routing for api-server. |
| `artifacts/api-server/build.mjs` | MJS module/configuration for build in artifacts/api-server. |
| `artifacts/api-server/docs/early-launch-discovery.md` | Developer documentation for early launch discovery. |
| `artifacts/api-server/docs/moonit-adapter.md` | Developer documentation for moonit adapter. |
| `artifacts/api-server/docs/native-launchpads.md` | Developer documentation for native launchpads. |
| `artifacts/api-server/package.json` | Dependency manifest and run/build scripts for artifacts/api-server. |
| `artifacts/api-server/src/app.ts` | TS module/configuration for app in artifacts/api-server/src. |
| `artifacts/api-server/src/index.ts` | TS module/configuration for index in artifacts/api-server/src. |
| `artifacts/api-server/src/lib/.gitkeep` | Source module/configuration for .gitkeep in artifacts/api-server/src/lib. |
| `artifacts/api-server/src/lib/logger.ts` | TS module/configuration for logger in artifacts/api-server/src/lib. |
| `artifacts/api-server/src/lib/owner-auth.ts` | TS module/configuration for owner auth in artifacts/api-server/src/lib. |
| `artifacts/api-server/src/lib/owner-policy.ts` | TS module/configuration for owner policy in artifacts/api-server/src/lib. |
| `artifacts/api-server/src/lib/sentinel/ai-evidence.ts` | Trading-core module for ai evidence. |
| `artifacts/api-server/src/lib/sentinel/ai-sweeps.ts` | Trading-core module for ai sweeps. |
| `artifacts/api-server/src/lib/sentinel/analysis.ts` | Trading-core module for analysis. |
| `artifacts/api-server/src/lib/sentinel/chain-risk-policy.ts` | Trading-core module for chain risk policy. |
| `artifacts/api-server/src/lib/sentinel/chain.ts` | Trading-core module for chain. |
| `artifacts/api-server/src/lib/sentinel/confidence.ts` | Trading-core module for confidence. |
| `artifacts/api-server/src/lib/sentinel/copy-stream.ts` | Trading-core module for copy stream. |
| `artifacts/api-server/src/lib/sentinel/copy-targets.ts` | Trading-core module for copy targets. |
| `artifacts/api-server/src/lib/sentinel/cost-policy.ts` | Trading-core module for cost policy. |
| `artifacts/api-server/src/lib/sentinel/crazy-assessment.ts` | Trading-core module for crazy assessment. |
| `artifacts/api-server/src/lib/sentinel/crazy-policy.ts` | Trading-core module for crazy policy. |
| `artifacts/api-server/src/lib/sentinel/crazy-proof.ts` | Trading-core module for crazy proof. |
| `artifacts/api-server/src/lib/sentinel/crazy-safety.ts` | Trading-core module for crazy safety. |
| `artifacts/api-server/src/lib/sentinel/curve-policy.ts` | Trading-core module for curve policy. |
| `artifacts/api-server/src/lib/sentinel/dbc-entry-policy.ts` | Trading-core module for dbc entry policy. |
| `artifacts/api-server/src/lib/sentinel/discovery-policy.ts` | Trading-core module for discovery policy. |
| `artifacts/api-server/src/lib/sentinel/engine.ts` | Trading-core module for engine. |
| `artifacts/api-server/src/lib/sentinel/entry-policy.ts` | Trading-core module for entry policy. |
| `artifacts/api-server/src/lib/sentinel/execution.ts` | Trading-core module for execution. |
| `artifacts/api-server/src/lib/sentinel/exit-policy.ts` | Trading-core module for exit policy. |
| `artifacts/api-server/src/lib/sentinel/fomo.ts` | Trading-core module for fomo. |
| `artifacts/api-server/src/lib/sentinel/graduated-route-policy.ts` | Trading-core module for graduated route policy. |
| `artifacts/api-server/src/lib/sentinel/historical-pump.ts` | Trading-core module for historical pump. |
| `artifacts/api-server/src/lib/sentinel/http.ts` | Trading-core module for http. |
| `artifacts/api-server/src/lib/sentinel/jito.ts` | Trading-core module for jito. |
| `artifacts/api-server/src/lib/sentinel/launch-allocation.ts` | Trading-core module for launch allocation. |
| `artifacts/api-server/src/lib/sentinel/launch-discovery.ts` | Trading-core module for launch discovery. |
| `artifacts/api-server/src/lib/sentinel/launch-events.ts` | Trading-core module for launch events. |
| `artifacts/api-server/src/lib/sentinel/launchpad-entry.ts` | Trading-core module for launchpad entry. |
| `artifacts/api-server/src/lib/sentinel/launchpad-policy.ts` | Trading-core module for launchpad policy. |
| `artifacts/api-server/src/lib/sentinel/launchpad-rent.ts` | Trading-core module for launchpad rent. |
| `artifacts/api-server/src/lib/sentinel/launchpad-routes.ts` | Trading-core module for launchpad routes. |
| `artifacts/api-server/src/lib/sentinel/launchpad-state.ts` | Trading-core module for launchpad state. |
| `artifacts/api-server/src/lib/sentinel/locked-pool.ts` | Trading-core module for locked pool. |
| `artifacts/api-server/src/lib/sentinel/market.ts` | Trading-core module for market. |
| `artifacts/api-server/src/lib/sentinel/moonit-market.ts` | Trading-core module for moonit market. |
| `artifacts/api-server/src/lib/sentinel/moonit-observations.ts` | Trading-core module for moonit observations. |
| `artifacts/api-server/src/lib/sentinel/moonit-policy.ts` | Trading-core module for moonit policy. |
| `artifacts/api-server/src/lib/sentinel/moonit-routes.ts` | Trading-core module for moonit routes. |
| `artifacts/api-server/src/lib/sentinel/moonit-state.ts` | Trading-core module for moonit state. |
| `artifacts/api-server/src/lib/sentinel/native-accounting.ts` | Trading-core module for native accounting. |
| `artifacts/api-server/src/lib/sentinel/network-policy.ts` | Trading-core module for network policy. |
| `artifacts/api-server/src/lib/sentinel/pending-expiry.ts` | Trading-core module for pending expiry. |
| `artifacts/api-server/src/lib/sentinel/pipeline-state.ts` | Trading-core module for pipeline state. |
| `artifacts/api-server/src/lib/sentinel/priority-fees.ts` | Trading-core module for priority fees. |
| `artifacts/api-server/src/lib/sentinel/pump-activity-fallback.ts` | Trading-core module for pump activity fallback. |
| `artifacts/api-server/src/lib/sentinel/pump-graduated.ts` | Trading-core module for pump graduated. |
| `artifacts/api-server/src/lib/sentinel/pump-hunt-policy.ts` | Trading-core module for pump hunt policy. |
| `artifacts/api-server/src/lib/sentinel/pump-live-feed.ts` | Trading-core module for pump live feed. |
| `artifacts/api-server/src/lib/sentinel/pump-market.ts` | Trading-core module for pump market. |
| `artifacts/api-server/src/lib/sentinel/pump-observations.ts` | Trading-core module for pump observations. |
| `artifacts/api-server/src/lib/sentinel/pump-snapshot.ts` | Trading-core module for pump snapshot. |
| `artifacts/api-server/src/lib/sentinel/pump-sniping.ts` | Trading-core module for pump sniping. |
| `artifacts/api-server/src/lib/sentinel/readiness.ts` | Trading-core module for readiness. |
| `artifacts/api-server/src/lib/sentinel/retention-policy.ts` | Trading-core module for retention policy. |
| `artifacts/api-server/src/lib/sentinel/risk-stream.ts` | Trading-core module for risk stream. |
| `artifacts/api-server/src/lib/sentinel/route-policy.ts` | Trading-core module for route policy. |
| `artifacts/api-server/src/lib/sentinel/routes.ts` | Trading-core module for routes. |
| `artifacts/api-server/src/lib/sentinel/rpc-config.ts` | Trading-core module for rpc config. |
| `artifacts/api-server/src/lib/sentinel/rpc-context.ts` | Trading-core module for rpc context. |
| `artifacts/api-server/src/lib/sentinel/rpc-endpoint.ts` | Trading-core module for rpc endpoint. |
| `artifacts/api-server/src/lib/sentinel/rpc-pool.ts` | Trading-core module for rpc pool. |
| `artifacts/api-server/src/lib/sentinel/rpc-websocket.ts` | Trading-core module for rpc websocket. |
| `artifacts/api-server/src/lib/sentinel/runtime-goal.ts` | Trading-core module for runtime goal. |
| `artifacts/api-server/src/lib/sentinel/scan-policy.ts` | Trading-core module for scan policy. |
| `artifacts/api-server/src/lib/sentinel/scan-schedule.ts` | Trading-core module for scan schedule. |
| `artifacts/api-server/src/lib/sentinel/store.ts` | Trading-core module for store. |
| `artifacts/api-server/src/lib/sentinel/telemetry.ts` | Trading-core module for telemetry. |
| `artifacts/api-server/src/lib/sentinel/token-entry.ts` | Trading-core module for token entry. |
| `artifacts/api-server/src/lib/sentinel/token-policy.ts` | Trading-core module for token policy. |
| `artifacts/api-server/src/lib/sentinel/transaction-policy.ts` | Trading-core module for transaction policy. |
| `artifacts/api-server/src/lib/sentinel/types.ts` | Trading-core module for types. |
| `artifacts/api-server/src/lib/sentinel/volatility-risk.ts` | Trading-core module for volatility risk. |
| `artifacts/api-server/src/lib/sentinel/wallet-policy.ts` | Trading-core module for wallet policy. |
| `artifacts/api-server/src/lib/sentinel/wallet-reconciliation.ts` | Trading-core module for wallet reconciliation. |
| `artifacts/api-server/src/lib/sentinel/watch-budget.ts` | Trading-core module for watch budget. |
| `artifacts/api-server/src/lib/sentinel/watchlist.ts` | Trading-core module for watchlist. |
| `artifacts/api-server/src/lib/sentinel/worker-policy.ts` | Trading-core module for worker policy. |
| `artifacts/api-server/src/middlewares/.gitkeep` | Source module/configuration for .gitkeep in artifacts/api-server/src/middlewares. |
| `artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts` | TS module/configuration for clerkProxyMiddleware in artifacts/api-server/src/middlewares. |
| `artifacts/api-server/src/routes/health.ts` | Express API routes for health. |
| `artifacts/api-server/src/routes/index.ts` | Express API routes for index. |
| `artifacts/api-server/src/routes/rpc-connection.ts` | Express API routes for rpc connection. |
| `artifacts/api-server/src/routes/sentinel.ts` | Express API routes for sentinel. |
| `artifacts/api-server/tests/ai-evidence.test.ts` | Offline regression tests for ai evidence. |
| `artifacts/api-server/tests/continuous-worker.test.ts` | Offline regression tests for continuous worker. |
| `artifacts/api-server/tests/copy-stream.test.ts` | Offline regression tests for copy stream. |
| `artifacts/api-server/tests/copy-targets.test.ts` | Offline regression tests for copy targets. |
| `artifacts/api-server/tests/crazy-entry.test.ts` | Offline regression tests for crazy entry. |
| `artifacts/api-server/tests/crazy-fast-scan.test.ts` | Offline regression tests for crazy fast scan. |
| `artifacts/api-server/tests/crazy-liquidity-floor.test.ts` | Offline regression tests for crazy liquidity floor. |
| `artifacts/api-server/tests/crazy-policy.test.ts` | Offline regression tests for crazy policy. |
| `artifacts/api-server/tests/curve-policy.test.ts` | Offline regression tests for curve policy. |
| `artifacts/api-server/tests/dedicated-rpc.test.ts` | Offline regression tests for dedicated rpc. |
| `artifacts/api-server/tests/dual-speed-pool.test.ts` | Offline regression tests for dual speed pool. |
| `artifacts/api-server/tests/early-launch-market.test.ts` | Offline regression tests for early launch market. |
| `artifacts/api-server/tests/effective-rules.test.ts` | Offline regression tests for effective rules. |
| `artifacts/api-server/tests/entry-policy.test.ts` | Offline regression tests for entry policy. |
| `artifacts/api-server/tests/fomo-poll.test.ts` | Offline regression tests for fomo poll. |
| `artifacts/api-server/tests/graduated-discovery.test.ts` | Offline regression tests for graduated discovery. |
| `artifacts/api-server/tests/graduated-execution.test.ts` | Offline regression tests for graduated execution. |
| `artifacts/api-server/tests/graduated-pump.test.ts` | Offline regression tests for graduated pump. |
| `artifacts/api-server/tests/helpers/graduated-fixtures.ts` | TS module/configuration for graduated fixtures in artifacts/api-server/tests/helpers. |
| `artifacts/api-server/tests/helpers/launchpad-fixtures.ts` | TS module/configuration for launchpad fixtures in artifacts/api-server/tests/helpers. |
| `artifacts/api-server/tests/helpers/moonit-fixture.ts` | TS module/configuration for moonit fixture in artifacts/api-server/tests/helpers. |
| `artifacts/api-server/tests/historical-pump.test.ts` | Offline regression tests for historical pump. |
| `artifacts/api-server/tests/launch-discovery.test.ts` | Offline regression tests for launch discovery. |
| `artifacts/api-server/tests/launchpad-execution.test.ts` | Offline regression tests for launchpad execution. |
| `artifacts/api-server/tests/launchpad-only.test.ts` | Offline regression tests for launchpad only. |
| `artifacts/api-server/tests/launchpad-policy.test.ts` | Offline regression tests for launchpad policy. |
| `artifacts/api-server/tests/locked-pool.test.ts` | Offline regression tests for locked pool. |
| `artifacts/api-server/tests/market-discovery.test.ts` | Offline regression tests for market discovery. |
| `artifacts/api-server/tests/moonit-launchpad.test.ts` | Offline regression tests for moonit launchpad. |
| `artifacts/api-server/tests/multidex-exits.test.ts` | Offline regression tests for multidex exits. |
| `artifacts/api-server/tests/multidex-routing.test.ts` | Offline regression tests for multidex routing. |
| `artifacts/api-server/tests/multistage-monitor.test.ts` | Offline regression tests for multistage monitor. |
| `artifacts/api-server/tests/native-launchpads.test.ts` | Offline regression tests for native launchpads. |
| `artifacts/api-server/tests/network-policy.test.ts` | Offline regression tests for network policy. |
| `artifacts/api-server/tests/owner-auth.test.ts` | Offline regression tests for owner auth. |
| `artifacts/api-server/tests/pending-expiry.test.ts` | Offline regression tests for pending expiry. |
| `artifacts/api-server/tests/priority-fees.test.ts` | Offline regression tests for priority fees. |
| `artifacts/api-server/tests/pump-hunt.test.ts` | Offline regression tests for pump hunt. |
| `artifacts/api-server/tests/pump-live-feed.test.ts` | Offline regression tests for pump live feed. |
| `artifacts/api-server/tests/pump-stream-runtime.test.ts` | Offline regression tests for pump stream runtime. |
| `artifacts/api-server/tests/reliability-upgrade.test.ts` | Offline regression tests for reliability upgrade. |
| `artifacts/api-server/tests/retention-wallet.test.ts` | Offline regression tests for retention wallet. |
| `artifacts/api-server/tests/rpc-connection.test.ts` | Offline regression tests for rpc connection. |
| `artifacts/api-server/tests/rpc-fixture.ts` | TS module/configuration for rpc fixture in artifacts/api-server/tests. |
| `artifacts/api-server/tests/rpc-route.test.ts` | Offline regression tests for rpc route. |
| `artifacts/api-server/tests/rpc-websocket.test.ts` | Offline regression tests for rpc websocket. |
| `artifacts/api-server/tests/scan-entry.test.ts` | Offline regression tests for scan entry. |
| `artifacts/api-server/tests/scan-optimization.test.ts` | Offline regression tests for scan optimization. |
| `artifacts/api-server/tests/scan-policy.test.ts` | Offline regression tests for scan policy. |
| `artifacts/api-server/tests/sentinel-policy.test.ts` | Offline regression tests for sentinel policy. |
| `artifacts/api-server/tests/wallet-policy.test.ts` | Offline regression tests for wallet policy. |
| `artifacts/api-server/tests/watch-pipeline.test.ts` | Offline regression tests for watch pipeline. |
| `artifacts/api-server/tsconfig.json` | TypeScript compiler/project-reference configuration for artifacts/api-server. |
| `artifacts/mockup-sandbox/.replit-artifact/artifact.toml` | Replit artifact service and preview/publish routing for mockup-sandbox. |
| `artifacts/mockup-sandbox/components.json` | JSON module/configuration for components in artifacts/mockup-sandbox. |
| `artifacts/mockup-sandbox/index.html` | Frontend style/entry document: index. |
| `artifacts/mockup-sandbox/mockupPreviewPlugin.ts` | TS module/configuration for mockupPreviewPlugin in artifacts/mockup-sandbox. |
| `artifacts/mockup-sandbox/package.json` | Dependency manifest and run/build scripts for artifacts/mockup-sandbox. |
| `artifacts/mockup-sandbox/src/.generated/mockup-components.ts` | TS module/configuration for mockup components in artifacts/mockup-sandbox/src/.generated. |
| `artifacts/mockup-sandbox/src/App.tsx` | TSX module/configuration for App in artifacts/mockup-sandbox/src. |
| `artifacts/mockup-sandbox/src/components/ui/accordion.tsx` | Shared React UI primitive: accordion. |
| `artifacts/mockup-sandbox/src/components/ui/alert-dialog.tsx` | Shared React UI primitive: alert dialog. |
| `artifacts/mockup-sandbox/src/components/ui/alert.tsx` | Shared React UI primitive: alert. |
| `artifacts/mockup-sandbox/src/components/ui/aspect-ratio.tsx` | Shared React UI primitive: aspect ratio. |
| `artifacts/mockup-sandbox/src/components/ui/avatar.tsx` | Shared React UI primitive: avatar. |
| `artifacts/mockup-sandbox/src/components/ui/badge.tsx` | Shared React UI primitive: badge. |
| `artifacts/mockup-sandbox/src/components/ui/breadcrumb.tsx` | Shared React UI primitive: breadcrumb. |
| `artifacts/mockup-sandbox/src/components/ui/button-group.tsx` | Shared React UI primitive: button group. |
| `artifacts/mockup-sandbox/src/components/ui/button.tsx` | Shared React UI primitive: button. |
| `artifacts/mockup-sandbox/src/components/ui/calendar.tsx` | Shared React UI primitive: calendar. |
| `artifacts/mockup-sandbox/src/components/ui/card.tsx` | Shared React UI primitive: card. |
| `artifacts/mockup-sandbox/src/components/ui/carousel.tsx` | Shared React UI primitive: carousel. |
| `artifacts/mockup-sandbox/src/components/ui/chart.tsx` | Shared React UI primitive: chart. |
| `artifacts/mockup-sandbox/src/components/ui/checkbox.tsx` | Shared React UI primitive: checkbox. |
| `artifacts/mockup-sandbox/src/components/ui/collapsible.tsx` | Shared React UI primitive: collapsible. |
| `artifacts/mockup-sandbox/src/components/ui/command.tsx` | Shared React UI primitive: command. |
| `artifacts/mockup-sandbox/src/components/ui/context-menu.tsx` | Shared React UI primitive: context menu. |
| `artifacts/mockup-sandbox/src/components/ui/dialog.tsx` | Shared React UI primitive: dialog. |
| `artifacts/mockup-sandbox/src/components/ui/drawer.tsx` | Shared React UI primitive: drawer. |
| `artifacts/mockup-sandbox/src/components/ui/dropdown-menu.tsx` | Shared React UI primitive: dropdown menu. |
| `artifacts/mockup-sandbox/src/components/ui/empty.tsx` | Shared React UI primitive: empty. |
| `artifacts/mockup-sandbox/src/components/ui/field.tsx` | Shared React UI primitive: field. |
| `artifacts/mockup-sandbox/src/components/ui/form.tsx` | Shared React UI primitive: form. |
| `artifacts/mockup-sandbox/src/components/ui/hover-card.tsx` | Shared React UI primitive: hover card. |
| `artifacts/mockup-sandbox/src/components/ui/input-group.tsx` | Shared React UI primitive: input group. |
| `artifacts/mockup-sandbox/src/components/ui/input-otp.tsx` | Shared React UI primitive: input otp. |
| `artifacts/mockup-sandbox/src/components/ui/input.tsx` | Shared React UI primitive: input. |
| `artifacts/mockup-sandbox/src/components/ui/item.tsx` | Shared React UI primitive: item. |
| `artifacts/mockup-sandbox/src/components/ui/kbd.tsx` | Shared React UI primitive: kbd. |
| `artifacts/mockup-sandbox/src/components/ui/label.tsx` | Shared React UI primitive: label. |
| `artifacts/mockup-sandbox/src/components/ui/menubar.tsx` | Shared React UI primitive: menubar. |
| `artifacts/mockup-sandbox/src/components/ui/navigation-menu.tsx` | Shared React UI primitive: navigation menu. |
| `artifacts/mockup-sandbox/src/components/ui/pagination.tsx` | Shared React UI primitive: pagination. |
| `artifacts/mockup-sandbox/src/components/ui/popover.tsx` | Shared React UI primitive: popover. |
| `artifacts/mockup-sandbox/src/components/ui/progress.tsx` | Shared React UI primitive: progress. |
| `artifacts/mockup-sandbox/src/components/ui/radio-group.tsx` | Shared React UI primitive: radio group. |
| `artifacts/mockup-sandbox/src/components/ui/resizable.tsx` | Shared React UI primitive: resizable. |
| `artifacts/mockup-sandbox/src/components/ui/scroll-area.tsx` | Shared React UI primitive: scroll area. |
| `artifacts/mockup-sandbox/src/components/ui/select.tsx` | Shared React UI primitive: select. |
| `artifacts/mockup-sandbox/src/components/ui/separator.tsx` | Shared React UI primitive: separator. |
| `artifacts/mockup-sandbox/src/components/ui/sheet.tsx` | Shared React UI primitive: sheet. |
| `artifacts/mockup-sandbox/src/components/ui/sidebar.tsx` | Shared React UI primitive: sidebar. |
| `artifacts/mockup-sandbox/src/components/ui/skeleton.tsx` | Shared React UI primitive: skeleton. |
| `artifacts/mockup-sandbox/src/components/ui/slider.tsx` | Shared React UI primitive: slider. |
| `artifacts/mockup-sandbox/src/components/ui/sonner.tsx` | Shared React UI primitive: sonner. |
| `artifacts/mockup-sandbox/src/components/ui/spinner.tsx` | Shared React UI primitive: spinner. |
| `artifacts/mockup-sandbox/src/components/ui/switch.tsx` | Shared React UI primitive: switch. |
| `artifacts/mockup-sandbox/src/components/ui/table.tsx` | Shared React UI primitive: table. |
| `artifacts/mockup-sandbox/src/components/ui/tabs.tsx` | Shared React UI primitive: tabs. |
| `artifacts/mockup-sandbox/src/components/ui/textarea.tsx` | Shared React UI primitive: textarea. |
| `artifacts/mockup-sandbox/src/components/ui/toast.tsx` | Shared React UI primitive: toast. |
| `artifacts/mockup-sandbox/src/components/ui/toaster.tsx` | Shared React UI primitive: toaster. |
| `artifacts/mockup-sandbox/src/components/ui/toggle-group.tsx` | Shared React UI primitive: toggle group. |
| `artifacts/mockup-sandbox/src/components/ui/toggle.tsx` | Shared React UI primitive: toggle. |
| `artifacts/mockup-sandbox/src/components/ui/tooltip.tsx` | Shared React UI primitive: tooltip. |
| `artifacts/mockup-sandbox/src/hooks/use-mobile.tsx` | TSX module/configuration for use mobile in artifacts/mockup-sandbox/src/hooks. |
| `artifacts/mockup-sandbox/src/hooks/use-toast.ts` | TS module/configuration for use toast in artifacts/mockup-sandbox/src/hooks. |
| `artifacts/mockup-sandbox/src/index.css` | Frontend style/entry document: index. |
| `artifacts/mockup-sandbox/src/lib/utils.ts` | TS module/configuration for utils in artifacts/mockup-sandbox/src/lib. |
| `artifacts/mockup-sandbox/src/main.tsx` | TSX module/configuration for main in artifacts/mockup-sandbox/src. |
| `artifacts/mockup-sandbox/tsconfig.json` | TypeScript compiler/project-reference configuration for artifacts/mockup-sandbox. |
| `artifacts/mockup-sandbox/vite.config.ts` | Vite frontend/prototype server, build, aliases and host/port configuration for mockup-sandbox. |
| `artifacts/solana-sentinel/.replit-artifact/artifact.toml` | Replit artifact service and preview/publish routing for solana-sentinel. |
| `artifacts/solana-sentinel/components.json` | JSON module/configuration for components in artifacts/solana-sentinel. |
| `artifacts/solana-sentinel/index.html` | Frontend style/entry document: index. |
| `artifacts/solana-sentinel/package.json` | Dependency manifest and run/build scripts for artifacts/solana-sentinel. |
| `artifacts/solana-sentinel/public/favicon.svg` | Bundled source visual asset: favicon. |
| `artifacts/solana-sentinel/public/logo.svg` | Bundled source visual asset: logo. |
| `artifacts/solana-sentinel/public/robots.txt` | TXT module/configuration for robots in artifacts/solana-sentinel/public. |
| `artifacts/solana-sentinel/src/App.tsx` | TSX module/configuration for App in artifacts/solana-sentinel/src. |
| `artifacts/solana-sentinel/src/components/copy-targets.tsx` | React component for copy targets. |
| `artifacts/solana-sentinel/src/components/effective-trading-rules.tsx` | React component for effective trading rules. |
| `artifacts/solana-sentinel/src/components/error-boundary.tsx` | React component for error boundary. |
| `artifacts/solana-sentinel/src/components/execution-diagnostics.tsx` | React component for execution diagnostics. |
| `artifacts/solana-sentinel/src/components/high-risk-settings.tsx` | React component for high risk settings. |
| `artifacts/solana-sentinel/src/components/kit.tsx` | React component for kit. |
| `artifacts/solana-sentinel/src/components/pump-hunt-settings.tsx` | React component for pump hunt settings. |
| `artifacts/solana-sentinel/src/components/reliability-settings.tsx` | React component for reliability settings. |
| `artifacts/solana-sentinel/src/components/rpc-connection.tsx` | React component for rpc connection. |
| `artifacts/solana-sentinel/src/components/shell.tsx` | React component for shell. |
| `artifacts/solana-sentinel/src/components/ui/accordion.tsx` | Shared React UI primitive: accordion. |
| `artifacts/solana-sentinel/src/components/ui/alert-dialog.tsx` | Shared React UI primitive: alert dialog. |
| `artifacts/solana-sentinel/src/components/ui/alert.tsx` | Shared React UI primitive: alert. |
| `artifacts/solana-sentinel/src/components/ui/aspect-ratio.tsx` | Shared React UI primitive: aspect ratio. |
| `artifacts/solana-sentinel/src/components/ui/avatar.tsx` | Shared React UI primitive: avatar. |
| `artifacts/solana-sentinel/src/components/ui/badge.tsx` | Shared React UI primitive: badge. |
| `artifacts/solana-sentinel/src/components/ui/breadcrumb.tsx` | Shared React UI primitive: breadcrumb. |
| `artifacts/solana-sentinel/src/components/ui/button-group.tsx` | Shared React UI primitive: button group. |
| `artifacts/solana-sentinel/src/components/ui/button.tsx` | Shared React UI primitive: button. |
| `artifacts/solana-sentinel/src/components/ui/calendar.tsx` | Shared React UI primitive: calendar. |
| `artifacts/solana-sentinel/src/components/ui/card.tsx` | Shared React UI primitive: card. |
| `artifacts/solana-sentinel/src/components/ui/carousel.tsx` | Shared React UI primitive: carousel. |
| `artifacts/solana-sentinel/src/components/ui/chart.tsx` | Shared React UI primitive: chart. |
| `artifacts/solana-sentinel/src/components/ui/checkbox.tsx` | Shared React UI primitive: checkbox. |
| `artifacts/solana-sentinel/src/components/ui/collapsible.tsx` | Shared React UI primitive: collapsible. |
| `artifacts/solana-sentinel/src/components/ui/command.tsx` | Shared React UI primitive: command. |
| `artifacts/solana-sentinel/src/components/ui/context-menu.tsx` | Shared React UI primitive: context menu. |
| `artifacts/solana-sentinel/src/components/ui/dialog.tsx` | Shared React UI primitive: dialog. |
| `artifacts/solana-sentinel/src/components/ui/drawer.tsx` | Shared React UI primitive: drawer. |
| `artifacts/solana-sentinel/src/components/ui/dropdown-menu.tsx` | Shared React UI primitive: dropdown menu. |
| `artifacts/solana-sentinel/src/components/ui/empty.tsx` | Shared React UI primitive: empty. |
| `artifacts/solana-sentinel/src/components/ui/field.tsx` | Shared React UI primitive: field. |
| `artifacts/solana-sentinel/src/components/ui/form.tsx` | Shared React UI primitive: form. |
| `artifacts/solana-sentinel/src/components/ui/hover-card.tsx` | Shared React UI primitive: hover card. |
| `artifacts/solana-sentinel/src/components/ui/input-group.tsx` | Shared React UI primitive: input group. |
| `artifacts/solana-sentinel/src/components/ui/input-otp.tsx` | Shared React UI primitive: input otp. |
| `artifacts/solana-sentinel/src/components/ui/input.tsx` | Shared React UI primitive: input. |
| `artifacts/solana-sentinel/src/components/ui/item.tsx` | Shared React UI primitive: item. |
| `artifacts/solana-sentinel/src/components/ui/kbd.tsx` | Shared React UI primitive: kbd. |
| `artifacts/solana-sentinel/src/components/ui/label.tsx` | Shared React UI primitive: label. |
| `artifacts/solana-sentinel/src/components/ui/menubar.tsx` | Shared React UI primitive: menubar. |
| `artifacts/solana-sentinel/src/components/ui/navigation-menu.tsx` | Shared React UI primitive: navigation menu. |
| `artifacts/solana-sentinel/src/components/ui/pagination.tsx` | Shared React UI primitive: pagination. |
| `artifacts/solana-sentinel/src/components/ui/popover.tsx` | Shared React UI primitive: popover. |
| `artifacts/solana-sentinel/src/components/ui/progress.tsx` | Shared React UI primitive: progress. |
| `artifacts/solana-sentinel/src/components/ui/radio-group.tsx` | Shared React UI primitive: radio group. |
| `artifacts/solana-sentinel/src/components/ui/resizable.tsx` | Shared React UI primitive: resizable. |
| `artifacts/solana-sentinel/src/components/ui/scroll-area.tsx` | Shared React UI primitive: scroll area. |
| `artifacts/solana-sentinel/src/components/ui/select.tsx` | Shared React UI primitive: select. |
| `artifacts/solana-sentinel/src/components/ui/separator.tsx` | Shared React UI primitive: separator. |
| `artifacts/solana-sentinel/src/components/ui/sheet.tsx` | Shared React UI primitive: sheet. |
| `artifacts/solana-sentinel/src/components/ui/sidebar.tsx` | Shared React UI primitive: sidebar. |
| `artifacts/solana-sentinel/src/components/ui/skeleton.tsx` | Shared React UI primitive: skeleton. |
| `artifacts/solana-sentinel/src/components/ui/slider.tsx` | Shared React UI primitive: slider. |
| `artifacts/solana-sentinel/src/components/ui/sonner.tsx` | Shared React UI primitive: sonner. |
| `artifacts/solana-sentinel/src/components/ui/spinner.tsx` | Shared React UI primitive: spinner. |
| `artifacts/solana-sentinel/src/components/ui/switch.tsx` | Shared React UI primitive: switch. |
| `artifacts/solana-sentinel/src/components/ui/table.tsx` | Shared React UI primitive: table. |
| `artifacts/solana-sentinel/src/components/ui/tabs.tsx` | Shared React UI primitive: tabs. |
| `artifacts/solana-sentinel/src/components/ui/textarea.tsx` | Shared React UI primitive: textarea. |
| `artifacts/solana-sentinel/src/components/ui/toast.tsx` | Shared React UI primitive: toast. |
| `artifacts/solana-sentinel/src/components/ui/toaster.tsx` | Shared React UI primitive: toaster. |
| `artifacts/solana-sentinel/src/components/ui/toggle-group.tsx` | Shared React UI primitive: toggle group. |
| `artifacts/solana-sentinel/src/components/ui/toggle.tsx` | Shared React UI primitive: toggle. |
| `artifacts/solana-sentinel/src/components/ui/tooltip.tsx` | Shared React UI primitive: tooltip. |
| `artifacts/solana-sentinel/src/hooks/use-mobile.tsx` | TSX module/configuration for use mobile in artifacts/solana-sentinel/src/hooks. |
| `artifacts/solana-sentinel/src/hooks/use-scanner-page.ts` | TS module/configuration for use scanner page in artifacts/solana-sentinel/src/hooks. |
| `artifacts/solana-sentinel/src/hooks/use-sentinel.ts` | TS module/configuration for use sentinel in artifacts/solana-sentinel/src/hooks. |
| `artifacts/solana-sentinel/src/hooks/use-toast.ts` | TS module/configuration for use toast in artifacts/solana-sentinel/src/hooks. |
| `artifacts/solana-sentinel/src/index.css` | Frontend style/entry document: index. |
| `artifacts/solana-sentinel/src/lib/effective-rules.ts` | TS module/configuration for effective rules in artifacts/solana-sentinel/src/lib. |
| `artifacts/solana-sentinel/src/lib/format.ts` | TS module/configuration for format in artifacts/solana-sentinel/src/lib. |
| `artifacts/solana-sentinel/src/lib/owner-session.tsx` | TSX module/configuration for owner session in artifacts/solana-sentinel/src/lib. |
| `artifacts/solana-sentinel/src/lib/scanner-index.ts` | TS module/configuration for scanner index in artifacts/solana-sentinel/src/lib. |
| `artifacts/solana-sentinel/src/lib/scanner.worker.ts` | TS module/configuration for scanner.worker in artifacts/solana-sentinel/src/lib. |
| `artifacts/solana-sentinel/src/lib/utils.ts` | TS module/configuration for utils in artifacts/solana-sentinel/src/lib. |
| `artifacts/solana-sentinel/src/main.tsx` | TSX module/configuration for main in artifacts/solana-sentinel/src. |
| `artifacts/solana-sentinel/src/pages/activity.tsx` | React dashboard page for activity. |
| `artifacts/solana-sentinel/src/pages/connections.tsx` | React dashboard page for connections. |
| `artifacts/solana-sentinel/src/pages/dashboard.tsx` | React dashboard page for dashboard. |
| `artifacts/solana-sentinel/src/pages/landing.tsx` | React dashboard page for landing. |
| `artifacts/solana-sentinel/src/pages/lock.tsx` | React dashboard page for lock. |
| `artifacts/solana-sentinel/src/pages/not-found.tsx` | React dashboard page for not found. |
| `artifacts/solana-sentinel/src/pages/positions.tsx` | React dashboard page for positions. |
| `artifacts/solana-sentinel/src/pages/scanner.tsx` | React dashboard page for scanner. |
| `artifacts/solana-sentinel/src/pages/setup.tsx` | React dashboard page for setup. |
| `artifacts/solana-sentinel/src/pages/strategy.tsx` | React dashboard page for strategy. |
| `artifacts/solana-sentinel/tsconfig.json` | TypeScript compiler/project-reference configuration for artifacts/solana-sentinel. |
| `artifacts/solana-sentinel/vite.config.ts` | Vite frontend/prototype server, build, aliases and host/port configuration for solana-sentinel. |
| `docs/sentinel-protocol-coverage.md` | Developer documentation for sentinel protocol coverage. |
| `docs/sentinel-pump-hunt.md` | Developer documentation for sentinel pump hunt. |
| `docs/sentinel-reliability-upgrade.md` | Developer documentation for sentinel reliability upgrade. |
| `lib/api-client-react/package.json` | Dependency manifest and run/build scripts for lib/api-client-react. |
| `lib/api-client-react/src/custom-fetch.ts` | TS module/configuration for custom fetch in lib/api-client-react/src. |
| `lib/api-client-react/src/generated/api.schemas.ts` | Generated API source: api.schemas; regenerate from OpenAPI rather than edit. |
| `lib/api-client-react/src/generated/api.ts` | Generated API source: api; regenerate from OpenAPI rather than edit. |
| `lib/api-client-react/src/index.ts` | TS module/configuration for index in lib/api-client-react/src. |
| `lib/api-client-react/tsconfig.json` | TypeScript compiler/project-reference configuration for lib/api-client-react. |
| `lib/api-spec/openapi.yaml` | OpenAPI API/setting/position schemas used to generate clients and validators. |
| `lib/api-spec/orval.config.ts` | TS module/configuration for orval.config in lib/api-spec. |
| `lib/api-spec/package.json` | Dependency manifest and run/build scripts for lib/api-spec. |
| `lib/api-zod/package.json` | Dependency manifest and run/build scripts for lib/api-zod. |
| `lib/api-zod/src/generated/api.ts` | Generated API source: api; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/actionResult.ts` | Generated API source: actionResult; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/activity.ts` | Generated API source: activity; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/activityLevel.ts` | Generated API source: activityLevel; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/botCommand.ts` | Generated API source: botCommand; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/botCommandAction.ts` | Generated API source: botCommandAction; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/candidate.ts` | Generated API source: candidate; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/candidateLaunchpadVerification.ts` | Generated API source: candidateLaunchpadVerification; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/candidateLaunchpadVerificationPhase.ts` | Generated API source: candidateLaunchpadVerificationPhase; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/candidateLpVerification.ts` | Generated API source: candidateLpVerification; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/candidateMarketDataStatus.ts` | Generated API source: candidateMarketDataStatus; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/candidateMissingMarketDataItem.ts` | Generated API source: candidateMissingMarketDataItem; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/candidatePipelineStatus.ts` | Generated API source: candidatePipelineStatus; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/candidateStatus.ts` | Generated API source: candidateStatus; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/connectionStatus.ts` | Generated API source: connectionStatus; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/connectionStatusStatus.ts` | Generated API source: connectionStatusStatus; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/copyTarget.ts` | Generated API source: copyTarget; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/copyTargetPlatform.ts` | Generated API source: copyTargetPlatform; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/dashboard.ts` | Generated API source: dashboard; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/dashboardMode.ts` | Generated API source: dashboardMode; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/equityPoint.ts` | Generated API source: equityPoint; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/healthStatus.ts` | Generated API source: healthStatus; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/highRiskLeader.ts` | Generated API source: highRiskLeader; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/highRiskStatus.ts` | Generated API source: highRiskStatus; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/index.ts` | Generated API source: index; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/ownerSession.ts` | Generated API source: ownerSession; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/passwordInput.ts` | Generated API source: passwordInput; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/position.ts` | Generated API source: position; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/positionExitPlan.ts` | Generated API source: positionExitPlan; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/positionMode.ts` | Generated API source: positionMode; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/positionStatus.ts` | Generated API source: positionStatus; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/rpcConnectionStatus.ts` | Generated API source: rpcConnectionStatus; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/rpcConnectionStatusSource.ts` | Generated API source: rpcConnectionStatusSource; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/rpcEndpointHealth.ts` | Generated API source: rpcEndpointHealth; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/rpcEndpointInput.ts` | Generated API source: rpcEndpointInput; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/rpcProbeResult.ts` | Generated API source: rpcProbeResult; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/sentinelDiagnostics.ts` | Generated API source: sentinelDiagnostics; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/sentinelDiagnosticsFunnelItem.ts` | Generated API source: sentinelDiagnosticsFunnelItem; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/sentinelDiagnosticsPipeline.ts` | Generated API source: sentinelDiagnosticsPipeline; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/sentinelDiagnosticsRecentItem.ts` | Generated API source: sentinelDiagnosticsRecentItem; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/sentinelDiagnosticsRisk.ts` | Generated API source: sentinelDiagnosticsRisk; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/sentinelDiagnosticsRpc.ts` | Generated API source: sentinelDiagnosticsRpc; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/setupGuide.ts` | Generated API source: setupGuide; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/setupStep.ts` | Generated API source: setupStep; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/tradingSettings.ts` | Generated API source: tradingSettings; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/tradingSettingsCrazyStrategy.ts` | Generated API source: tradingSettingsCrazyStrategy; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/tradingSettingsExitStrategy.ts` | Generated API source: tradingSettingsExitStrategy; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/tradingSettingsMode.ts` | Generated API source: tradingSettingsMode; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/tradingSettingsRiskMode.ts` | Generated API source: tradingSettingsRiskMode; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/generated/types/walletConfirmation.ts` | Generated API source: walletConfirmation; regenerate from OpenAPI rather than edit. |
| `lib/api-zod/src/index.ts` | TS module/configuration for index in lib/api-zod/src. |
| `lib/api-zod/tsconfig.json` | TypeScript compiler/project-reference configuration for lib/api-zod. |
| `lib/db/drizzle.config.ts` | TS module/configuration for drizzle.config in lib/db. |
| `lib/db/package.json` | Dependency manifest and run/build scripts for lib/db. |
| `lib/db/src/index.ts` | TS module/configuration for index in lib/db/src. |
| `lib/db/src/schema/index.ts` | Drizzle database schema/export for index. |
| `lib/db/src/schema/login-limits.ts` | Drizzle database schema/export for login limits. |
| `lib/db/src/schema/owner-sessions.ts` | Drizzle database schema/export for owner sessions. |
| `lib/db/src/schema/sentinel-diagnostics.ts` | Drizzle database schema/export for sentinel diagnostics. |
| `lib/db/src/schema/trading-accounts.ts` | Drizzle database schema/export for trading accounts. |
| `lib/db/tsconfig.json` | TypeScript compiler/project-reference configuration for lib/db. |
| `lib/integrations-openai-ai-server/package.json` | Dependency manifest and run/build scripts for lib/integrations-openai-ai-server. |
| `lib/integrations-openai-ai-server/src/audio/client.ts` | TS module/configuration for client in lib/integrations-openai-ai-server/src/audio. |
| `lib/integrations-openai-ai-server/src/audio/index.ts` | TS module/configuration for index in lib/integrations-openai-ai-server/src/audio. |
| `lib/integrations-openai-ai-server/src/batch/index.ts` | TS module/configuration for index in lib/integrations-openai-ai-server/src/batch. |
| `lib/integrations-openai-ai-server/src/batch/utils.ts` | TS module/configuration for utils in lib/integrations-openai-ai-server/src/batch. |
| `lib/integrations-openai-ai-server/src/client.ts` | TS module/configuration for client in lib/integrations-openai-ai-server/src. |
| `lib/integrations-openai-ai-server/src/image/client.ts` | TS module/configuration for client in lib/integrations-openai-ai-server/src/image. |
| `lib/integrations-openai-ai-server/src/image/index.ts` | TS module/configuration for index in lib/integrations-openai-ai-server/src/image. |
| `lib/integrations-openai-ai-server/src/index.ts` | TS module/configuration for index in lib/integrations-openai-ai-server/src. |
| `lib/integrations-openai-ai-server/tsconfig.json` | TypeScript compiler/project-reference configuration for lib/integrations-openai-ai-server. |
| `package.json` | Dependency manifest and run/build scripts for .. |
| `pnpm-lock.yaml` | Complete resolved transitive dependency lockfile and integrity hashes. |
| `pnpm-workspace.yaml` | Workspace packages, dependency catalog and security/platform overrides. |
| `replit.md` | Project context and historical decisions; current explicit policy supersedes older notes. |
| `sample-logs.txt` | Selected real operational failures/warnings; no raw credential-bearing logs. |
| `scripts/export-sentinel.py` | Repeatable stdlib-only source ZIP builder and credential-pattern checks. |
| `scripts/package.json` | Dependency manifest and run/build scripts for scripts. |
| `scripts/post-merge.sh` | SH module/configuration for post merge in scripts. |
| `scripts/src/hello.ts` | TS module/configuration for hello in scripts/src. |
| `scripts/tsconfig.json` | TypeScript compiler/project-reference configuration for scripts. |
| `tsconfig.base.json` | TypeScript compiler/project-reference configuration for .. |
| `tsconfig.json` | TypeScript compiler/project-reference configuration for .. |
