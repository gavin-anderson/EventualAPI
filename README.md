# hl-api

API service for the Hyperliquid portfolio/earnings app. Sibling to `hl-ingest`
(which owns market-data ingestion into ClickHouse). `hl-api` serves the app:

- **Anonymous, read-only** market data read from `hl-ingest`'s ClickHouse.
- **Authenticated** user-scoped resources via the **Privy → Supabase auth bridge**
  (scaffolded; dormant until Privy/Supabase secrets are set).

The app talks **directly to Supabase** (under RLS) for simple CRUD + Realtime, and
to `hl-api` for anything proprietary (ClickHouse market data, per-user Hyperliquid
later). Trading is out of scope. `hl-ingest` is **not modified** by this service —
its ClickHouse is a **read-only upstream**.

## Stack

TypeScript · Node ≥20 · Express · `@clickhouse/client` · `supabase-js` ·
`@privy-io/server-auth` · `pino` · `prom-client` · `zod`.

## Endpoints

| Method | Path                  | Auth          | Purpose                                                |
| ------ | --------------------- | ------------- | ------------------------------------------------------ |
| GET    | `/healthz`            | none          | Liveness.                                              |
| GET    | `/readyz`             | none          | Readiness (pings ClickHouse; reports auth-bridge state).|
| GET    | `/metrics`            | none          | Prometheus metrics (scraped by Alloy).                 |
| GET    | `/v1/market/sample`   | **anonymous** | Latest snapshot per coin from ClickHouse. `?coin= &dex= &limit=`. |
| POST   | `/v1/auth/session`    | Privy bearer  | Verify Privy token → mint a Supabase session JWT.      |
| GET    | `/v1/profile`         | Privy bearer  | Verified id + wallet; lazily upserts the profile.      |

Auth routes return `503 auth_not_configured` until the bridge is enabled.

## Quick start

```bash
cp .env.example .env     # fill in CH_URL (+ creds) at minimum
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
ClickHouse connection:

- `CH_URL` — `http://<hl-ingest tailnet IP>:8123` (HTTP interface; native `:9000`
  is loopback-only on the hl-ingest box). e.g. `http://100.x.y.z:8123`.
- `CH_DATABASE` (`hl`), `CH_USERNAME`, `CH_PASSWORD`, optional `CH_DEX`.

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
