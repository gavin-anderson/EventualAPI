# hl-api

API service for the Hyperliquid earnings app. Serves:

- **Anonymous reads** — the earnings calendar and asset art.
- **Authenticated, user-scoped** — sign-up, profiles, trades and takes,
  watchlist, feed and push, behind Privy access-token verification.

Requests are served from two sources, no others: **Supabase** for everything we
author, and **Hyperliquid's public `/info`** for everything priced or on-chain
(direct, no proxy). Trading is out of scope — the app signs and submits orders
itself, then reports them here for verification.

Scheduled jobs fill Supabase from the outside world: **Alpha Vantage** (earnings
dates, pre/post-market session, EPS) and **SEC EDGAR** (exact release times),
plus Polymarket for beat odds and Hyperliquid for positions and liquidations.
Benzinga is gone. See [docs/EARNINGS_DATA.md](docs/EARNINGS_DATA.md) and
[docs/JOBS.md](docs/JOBS.md).

## Stack

TypeScript · Node 24 · Express · `supabase-js` · `@privy-io/server-auth` ·
`jsonwebtoken` · `pino` · `prom-client` · `zod`.

## Endpoints

| Method | Path                            | Auth          | Purpose                                              |
| ------ | ------------------------------- | ------------- | ---------------------------------------------------- |
| GET    | `/healthz`                      | none          | Liveness.                                            |
| GET    | `/readyz`                       | none          | Readiness (pings Supabase; reports auth-bridge state).|
| GET    | `/metrics`                      | `METRICS_TOKEN` | Prometheus metrics. 404 when the token is unset.   |
| GET    | `/v1/earnings`                  | **anonymous** | Earnings calendar, shaped to the app's `MarketEvent`; metadata carries `iconUrl`/`cardUrl`. `?from= &to= &dex= &limit=`. |
| GET    | `/v1/earnings/:ticker`          | **anonymous** | One ticker: next event + past results + beat odds, plus name, description and art URLs. |
| POST   | `/v1/auth/signup`               | Privy bearer  | Sign-up and every-launch bootstrap. Idempotent.      |
| GET    | `/v1/profile`                   | Privy bearer  | The caller's own profile.                            |
| GET    | `/v1/profile/username/check`    | Privy bearer  | Availability hint. `?name=`                          |
| POST   | `/v1/profile/username`          | Privy bearer  | Atomic claim.                                        |
| PUT    | `/v1/profile/avatar`            | Privy bearer  | Upload a photo. Raw image bytes; re-encoded to 512px WebP. |
| DELETE | `/v1/profile/avatar`            | Privy bearer  | Drop the photo; the app's drawn default returns.     |
| POST   | `/v1/trades/open`               | Privy bearer  | Record a verified opening trade; opens a take window.|
| POST   | `/v1/trades/close`              | Privy bearer  | Record the close; opens a second take window.        |
| POST   | `/v1/takes`                     | Privy bearer  | Post a take about a trade. Optional.                 |
| GET    | `/v1/feed`                      | Privy bearer  | The position feed. `?coin= &user= &limit= &offset=`  |
| GET    | `/v1/feed/sentiment`            | Privy bearer  | Long/short split among published positions. `?coin=` |
| GET    | `/v1/watchlist`                 | Privy bearer  | Starred tickers.                                     |
| PUT    | `/v1/watchlist/:ticker`         | Privy bearer  | Star. Idempotent.                                    |
| DELETE | `/v1/watchlist/:ticker`         | Privy bearer  | Un-star. Idempotent.                                 |
| PUT    | `/v1/devices/:token`            | Privy bearer  | Register for push. Idempotent; `environment` required.|
| DELETE | `/v1/devices/:token`            | Privy bearer  | Unregister, e.g. on sign-out.                        |
| GET    | `/v1/notifications`             | Privy bearer  | The inbox, newest first, with an unread count.       |
| POST   | `/v1/notifications/read`        | Privy bearer  | Mark everything read.                                |
| GET    | `/v1/notifications/preferences` | Privy bearer  | Per-category prefs + quiet hours.                    |
| PUT    | `/v1/notifications/preferences` | Privy bearer  | Partial update.                                      |

**Scope:** called by our own mobile app and our own scheduled jobs. Not a public
API. Every endpoint has one of those two callers; anything without one was
removed — including the price stream, the standalone asset endpoints and the
portfolio passthroughs. Prices, `szDecimals` and `maxLeverage` the app reads from
Hyperliquid directly; the editorial half of the catalogue (name, description,
art) now rides along on the earnings responses instead of having endpoints of its
own — see [docs/ASSET_CATALOGUE.md](docs/ASSET_CATALOGUE.md).

Auth routes return `503 auth_not_configured` until the bridge is enabled.

## Quick start

```bash
cp .env.example .env     # fill in SUPABASE_* at minimum
npm install
npm run dev              # tsx watch, http://localhost:8080
```

Build & run as in production:

```bash
npm run build && npm start
```

Scheduled jobs run in a separate process (needs a build):

```bash
npm run scheduler                        # the worker: runs every job on its schedule
npm run job -- sync-earnings-calendar    # run one job once
npm run job:dev -- refresh-imminent      # same, via tsx without a build
```

Other scripts: `npm run typecheck`, `npm run lint`, `npm test`.

### Catalogue maintenance

Two local CLIs, run by hand rather than on a timer — both need judgement, and a
job that guessed would fill the catalogue with wrong rows. Both read the mobile
repo, so they assume `../earningsMobile` is checked out alongside this one.

```bash
npm run intake status            # HL universe vs. our catalogue
npm run intake sync -- --dry-run # preview new listings and delistings
npm run intake sync              # insert new live markets, flag delisted ones
npm run intake seed              # backfill name/description from the app bundle

npm run art -- --dry-run         # preview the art conversion
npm run art                      # convert to WebP, upload, write icon_ref/card_ref
npm run art -- --force           # re-upload when only object metadata changed
```

`sync` never guesses: a market the app bundle doesn't know arrives unnamed with
`reports_earnings` null, and is printed as needing you. `art` is idempotent —
destination paths contain a hash of the content, so a second run computes the
same path and skips.

## Deployment

Hosted on **Heroku**, deployed by GitHub Actions
([.github/workflows/deploy.yml](.github/workflows/deploy.yml)):

- Every push and PR to `main` or `dev` runs `npm ci && npm run build`.
- A push to `main` that builds is force-pushed to the Heroku app's git remote,
  which builds and releases it. Repo secrets: `HEROKU_API_KEY`,
  `HEROKU_PROD_APP` (the app name).

The [Procfile](Procfile) declares two process types:

| Dyno     | Command             | Runs                                             |
| -------- | ------------------- | ------------------------------------------------ |
| `web`    | `npm start`         | The API (`dist/index.js`) on Heroku's `$PORT`.   |
| `worker` | `npm run scheduler` | `src/jobs/scheduler.ts`, which spawns each job.  |

Scale the worker to **exactly one** dyno (`heroku ps:scale web=1 worker=1`), on
Basic or above so it never sleeps — two schedulers would run every job twice and
send every liquidation push twice. Details in [docs/JOBS.md](docs/JOBS.md).

Environment variables are Heroku config vars (`heroku config:set KEY=value`),
with `NODE_ENV=production`; `.env` is for local use only. `PORT` is set by
Heroku.

## Configuration

See `.env.example` for every variable. All are optional at boot; each feature
stays dormant until its block is filled in.

| Variables | Enables |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Everything. The anonymous read tier needs only these. |
| `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY` | Authenticated routes (with Supabase). |
| `PRIVY_APP_SECRET` | Embedded-wallet resolution only. |
| `ALPHAVANTAGE_API_KEY` | The earnings calendar and history syncs. Free key: 25 requests/day, personal use. |
| `SEC_USER_AGENT` | EDGAR lookups. SEC asks for a descriptive value with a contact email. |
| `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` (+ `APNS_BUNDLE_ID`) | Push delivery. Without them notifications still land in the inbox. |
| `HL_DEX` | The HIP-3 dex the app trades (default `xyz`). |
| `TAKE_WINDOW_SECONDS`, `TAKE_MAX_LENGTH` | Take rules (defaults 600s, 500 chars). |

No JWT secret: the app never talks to Supabase directly, so no session is
minted — see [docs/AUTH_BRIDGE.md](docs/AUTH_BRIDGE.md).

## Supabase

Migrations live in `supabase/migrations/`, applied in filename order. Note
`supabase/` is gitignored, so those files are the only local record of a schema
that is managed through the dashboard/MCP.

**Read [docs/RLS.md](docs/RLS.md) before adding a table.** This project's default
privileges grant every new table in `public` full access to `anon`, so each one
needs an explicit `revoke` on top of RLS.

## Docs

- [docs/AUTH_BRIDGE.md](docs/AUTH_BRIDGE.md) — Privy → Supabase flow & identity model.
- [docs/RLS.md](docs/RLS.md) — access tiers & RLS policies.
- [docs/ASSET_CATALOGUE.md](docs/ASSET_CATALOGUE.md) — how a market gets a row, a name and art.
- [docs/JOBS.md](docs/JOBS.md) — scheduled jobs, cadences, the Heroku worker.
- [docs/EARNINGS_DATA.md](docs/EARNINGS_DATA.md) — where earnings data comes from and how reactions are filled.
- [docs/EARNINGS_SOURCE_OPTIONS.md](docs/EARNINGS_SOURCE_OPTIONS.md) — why Alpha Vantage + EDGAR replaced Benzinga.
- [docs/hl-api.postman_collection.json](docs/hl-api.postman_collection.json) — Postman collection.

## Not yet wired

- **Job liveness alerting** — the earnings jobs stopped for two months in 2026
  and nothing noticed. A failed run is logged by the scheduler but alerts no one.
- **A licence for the earnings data** — the Alpha Vantage key is a free,
  personal-use one; a commercial licence is needed before public launch.
- **The app** — the iOS integration with hl-api (including attaching a `cloid`
  to orders for trade verification) lives on the mobile repo's
  `prod-integration` branch and is not on `main` yet.
