# hl-api

API service for the Hyperliquid earnings app. Serves:

- **Anonymous reads** — the earnings calendar and asset art.
- **Authenticated, user-scoped** — sign-up, profiles, trades and takes,
  watchlist, feed and push, behind Privy access-token verification.

Two data sources, no others: **Supabase** for everything we author, and
**Hyperliquid's public `/info`** for everything priced or on-chain (direct, no
proxy). Trading is out of scope — the app signs and submits orders itself, then
reports them here for verification.

## Stack

TypeScript · Node >=20 · Express · `supabase-js` · `@privy-io/server-auth` ·
`jsonwebtoken` · `pino` · `prom-client` · `zod`.

## Endpoints

| Method | Path                            | Auth          | Purpose                                              |
| ------ | ------------------------------- | ------------- | ---------------------------------------------------- |
| GET    | `/healthz`                      | none          | Liveness.                                            |
| GET    | `/readyz`                       | none          | Readiness (pings Supabase; reports auth-bridge state).|
| GET    | `/metrics`                      | none          | Prometheus metrics.                                  |
| GET    | `/v1/earnings`                  | **anonymous** | Earnings calendar, shaped to the app's `MarketEvent`; metadata carries `iconUrl`/`cardUrl`. `?from= &to= &dex= &limit=`. |
| GET    | `/v1/earnings/:ticker`          | **anonymous** | One ticker: next event + past results + beat odds, plus name, description and art URLs. |
| POST   | `/v1/auth/signup`               | Privy bearer  | Sign-up and every-launch bootstrap. Idempotent.      |
| GET    | `/v1/profile`                   | Privy bearer  | The caller's own profile.                            |
| GET    | `/v1/profile/username/check`    | Privy bearer  | Availability hint. `?name=`                          |
| POST   | `/v1/profile/username`          | Privy bearer  | Atomic claim.                                        |
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
removed — including the price stream, the asset catalogue and the portfolio
passthroughs, all of which the app does against Hyperliquid directly.

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

## Configuration

See `.env.example`. The anonymous read tier needs only `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`.

The auth bridge needs Supabase **and** Privy (`PRIVY_APP_ID`,
`PRIVY_VERIFICATION_KEY`). `PRIVY_APP_SECRET` is separate and only enables
embedded-wallet resolution. No JWT secret: the app never talks to Supabase
directly, so no session is minted — see [docs/AUTH_BRIDGE.md](docs/AUTH_BRIDGE.md).

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

## Not yet wired

- **CI/CD & hosting** — no Dockerfile, no CI, no service unit. The job timers in
  `deploy/systemd/` cover the scheduled jobs only, not the API process.
- **Job liveness alerting** — the earnings jobs stopped for two months in 2026
  and nothing noticed.
- **The app** — the iOS client does not call hl-api yet, and must attach a
  `cloid` to its orders before the trade endpoints can verify anything.
