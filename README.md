# hl-api

API service for the Hyperliquid portfolio/earnings app. Sibling to `hl-ingest`
(which owns market-data ingestion into ClickHouse — now being retired). `hl-api`
serves the app:

- **Anonymous, read-only** earnings calendar and asset catalogue from Supabase.
- **Authenticated** user-scoped resources via the **Privy → Supabase auth bridge**
  (scaffolded; dormant until Privy/Supabase secrets are set).

The app talks **directly to Supabase** (under RLS) for simple CRUD + Realtime, and
to `hl-api` for anything proprietary (earnings data, per-user Hyperliquid reads).
Trading is out of scope — the app signs and submits orders itself.

Market prices come from Hyperliquid's public `/info` directly (no proxy). The
ClickHouse-backed market routes were removed; the only remaining ClickHouse
consumers are `ws/priceHub` and the earnings-history reaction calculation, both
pending a re-point.

## Stack

TypeScript · Node ≥20 · Express · `@clickhouse/client` · `supabase-js` ·
`@privy-io/server-auth` · `pino` · `prom-client` · `zod`.

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

See `.env.example`. The only thing needed for the anonymous read tier is the
Supabase connection (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

`CH_*` is still read by the two remaining ClickHouse consumers (`ws/priceHub`,
`sync-earnings-history`) and goes away once those are re-pointed.

The auth bridge turns on only when **both** Supabase (`SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`) and Privy (`PRIVY_APP_ID`,
`PRIVY_VERIFICATION_KEY`) are configured.

## Supabase

Migrations live in `supabase/migrations/`. Apply `20260621000000_init_profiles.sql`
to a fresh project (SQL editor, or `supabase db push` with the CLI). The access
model (public read, user-scoped write, service-role bypass) is documented in
[docs/RLS.md](docs/RLS.md).

## Docs

- [docs/AUTH_BRIDGE.md](docs/AUTH_BRIDGE.md) — Privy → Supabase flow & identity model.
- [docs/RLS.md](docs/RLS.md) — access tiers & RLS policies.

## Not yet wired (later phases / passes)

- **CI/CD & hosting** — deliberately deferred. Will mirror the `hl-ingest` pattern
  (GitHub Actions → tailnet → ship → restart) or a managed Node host + Tailscale.
- **Privy** — verification + wallet enrichment (`getUser`) once the Privy app exists.
- **Observability wiring** — Alloy scrape config for this service's `/metrics`.
- No Redis/queue/object-storage/per-user Hyperliquid/chat — out of Phase 0 scope.
