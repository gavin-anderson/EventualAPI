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

| Method | Path                       | Auth          | Purpose                                                |
| ------ | -------------------------- | ------------- | ------------------------------------------------------ |
| GET    | `/healthz`                 | none          | Liveness.                                              |
| GET    | `/readyz`                  | none          | Readiness (pings Supabase; reports auth-bridge state). |
| GET    | `/metrics`                 | none          | Prometheus metrics (scraped by Alloy).                 |
| GET    | `/v1/earnings`             | **anonymous** | Upcoming earnings calendar, shaped to the app's `MarketEvent`. `?from= &to= &dex= &limit=`. |
| GET    | `/v1/assets`               | **anonymous** | Paginated asset catalogue. `?dex= &kind= &limit= &offset=`. |
| GET    | `/v1/assets/:ticker`       | **anonymous** | Asset detail: metadata + next earnings + odds + history. |
| WS     | `/v1/ws/prices`            | **anonymous** | Price stream; subscribe by ticker.                     |
| POST   | `/v1/auth/session`         | Privy bearer  | Verify Privy token → mint a Supabase session JWT.      |
| GET    | `/v1/profile`              | Privy bearer  | Verified id + wallet; lazily upserts the profile.      |
| GET    | `/v1/portfolio`            | Privy bearer  | Live HL account value + open positions.                |
| GET    | `/v1/positions/closed`     | Privy bearer  | Closed positions from HL fills. `?days=`               |

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

The auth bridge needs Supabase (plus `SUPABASE_JWT_SECRET`) **and** Privy
(`PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY`). `PRIVY_APP_SECRET` is separate and
only enables embedded-wallet resolution — see [docs/AUTH_BRIDGE.md](docs/AUTH_BRIDGE.md).

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
