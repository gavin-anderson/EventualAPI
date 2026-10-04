# hl-api

API service for the Hyperliquid earnings app. Serves:

- **Anonymous reads** — earnings calendar, asset catalogue, price WebSocket.
- **Authenticated, user-scoped** — sign-up, profiles, trades and takes, via the
  Privy → Supabase auth bridge.

Two data sources, no others: **Supabase** for everything we author, and
**Hyperliquid's public `/info`** for everything priced or on-chain (direct, no
proxy). Trading is out of scope — the app signs and submits orders itself, then
reports them here for verification.

## Stack

TypeScript · Node >=20 · Express · `supabase-js` · `@privy-io/server-auth` ·
`ws` · `pino` · `prom-client` · `zod`.

## Endpoints

| Method | Path                            | Auth          | Purpose                                              |
| ------ | ------------------------------- | ------------- | ---------------------------------------------------- |
| GET    | `/healthz`                      | none          | Liveness.                                            |
| GET    | `/readyz`                       | none          | Readiness (pings Supabase; reports auth-bridge state).|
| GET    | `/metrics`                      | none          | Prometheus metrics.                                  |
| GET    | `/v1/earnings`                  | **anonymous** | Earnings calendar, shaped to the app's `MarketEvent`. `?from= &to= &dex= &limit=`. |
| GET    | `/v1/earnings/:ticker`          | **anonymous** | One ticker: next event + past results + beat odds.   |
| POST   | `/v1/auth/signup`               | Privy bearer  | Sign-up and every-launch bootstrap. Idempotent.      |
| GET    | `/v1/profile`                   | Privy bearer  | The caller's own profile.                            |
| GET    | `/v1/profile/username/check`    | Privy bearer  | Availability hint. `?name=`                          |
| POST   | `/v1/profile/username`          | Privy bearer  | Atomic claim.                                        |
| POST   | `/v1/trades/open`               | Privy bearer  | Record a verified opening trade; opens a take window.|
| POST   | `/v1/trades/close`              | Privy bearer  | Record the close; opens a second take window.        |
| POST   | `/v1/takes`                     | Privy bearer  | Post a take about a trade. Optional.                 |
| GET    | `/v1/watchlist`                 | Privy bearer  | Starred tickers.                                     |
| PUT    | `/v1/watchlist/:ticker`         | Privy bearer  | Star. Idempotent.                                    |
| DELETE | `/v1/watchlist/:ticker`         | Privy bearer  | Un-star. Idempotent.                                 |

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

## Not yet wired

- **CI/CD & hosting** — no Dockerfile, no CI, no service unit. The job timers in
  `deploy/systemd/` cover the scheduled jobs only, not the API process.
- **Job liveness alerting** — the earnings jobs stopped for two months in 2026
  and nothing noticed.
- **The app** — the iOS client does not call hl-api yet, and must attach a
  `cloid` to its orders before the trade endpoints can verify anything.
