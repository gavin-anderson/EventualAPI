# Access model

## How access actually works

**Only the service role ever connects.** The app talks to hl-api; hl-api talks to
Supabase with the service role, which bypasses RLS. No client holds the anon key,
and no session JWT is minted.

So the real access control is *"only the server has credentials"*, and every
check that matters lives in the API layer — ticker normalisation, username rules,
take windows, trade verification. None of those are expressible as row
policies anyway.

The RLS policies below are therefore **inert today**: nothing connects as `anon`
or `authenticated`. They are kept as defence in depth, and because they would
become load-bearing the moment any client read Supabase directly.

## The trap

Default privileges on this project grant **every new table in `public` the full
privilege set to `anon` and `authenticated`** — including TRUNCATE, which RLS
cannot restrict.

Latent rather than live, since neither role is reachable. But it means RLS is the
only barrier, and it is opt-in per table. So every new table gets three things:

```sql
alter table public.x enable row level security;
-- ...policies for exactly the commands intended...
revoke all on public.x from anon, authenticated;
grant select (...) on public.x to anon, authenticated;   -- only if public
```

The `revoke` looks redundant and isn't — without it the table arrives fully
granted. A project-wide fix is written but unapplied:
`supabase/migrations/99999999999999_fix_overbroad_table_privileges.NOT_APPLIED.sql`.
It became safe to apply once the app stopped using the anon key, since nothing
could break.

## Identity

The stable user id is the **Privy DID** (`did:privy:abc123`), which is the
`profiles` primary key.

Policies use `auth.jwt() ->> 'sub'`, **never `auth.uid()`** — that casts `sub` to
uuid and ours is text, so it would be null. Kept correct even though unused.

## Per-table

| Table | Public read | Owner read | Writes |
| --- | --- | --- | --- |
| `profiles` | `id, username, image_ref, display_name, created_at` | — | service role |
| `username_claims` | all | — | service role |
| `positions` | rows **with a take**, non-hidden, public columns | — | service role |
| `watchlist` | — | own rows | service role |
| `feed_items` (view) | — | — | read-only, service role |
| `tracked_wallets` | — | — | internal, service role only |
| `wallet_open_positions` | — | — | internal, service role only |
| `device_tokens` | — | — | internal, service role only |
| `notification_preferences` | — | — | internal, service role only |
| `notifications` | — | — | internal, service role only |
| `liquidation_events` | — | — | internal, service role only |
| `assets`, `earnings_*` | all | — | service role |
| `account_value_snapshots` | — | own rows | service role |

Three of those encode a product rule rather than a convention:

**`profiles`** is column-scoped. A Hyperliquid address is enough to pull a
user's entire position history from the chain, so a public `wallet_address` would
link a username to a complete trading record they never chose to share.
`region` and `eligibility` are private for the same reason.

**`positions`** is only readable once it carries a take:

```sql
using (hidden_at is null and (open_take is not null or close_take is not null))
```

A position nobody posted about was never published. Posting a take *is* the act
of consenting to reveal side and size.

**`watchlist`** is owner-only. Weaker signal than a position, but still interest
the user never published — same rule.

`feed_items` is a view over `positions` joined to `profiles`, flattening each
position's open and close takes into separate posts. Declared
`security_invoker = true`, so the underlying policies still apply if a client
ever reads it directly — and revoked from `anon`/`authenticated` regardless,
since a view hands over exactly the columns it selects.

`username_claims` is public-read because resolving `/r/<username>` is a public
operation. It is append-only: rows retire via `released_at` and are never
deleted, so a released username can never be reassigned.

`tracked_wallets` and `wallet_open_positions` are never served to a client at
all — no grants, no policies beyond RLS being on. They mirror live Hyperliquid
state for liquidation tracking, including positions the user never published.

## Keys

- **service role key** — server-only, bypasses RLS. The only key in use.
- **anon key** — not used by anything. Does not ship in the app.
- No session JWTs. See [AUTH_BRIDGE.md](AUTH_BRIDGE.md).

## Verifying

Column grants are invisible in `information_schema.table_privileges` — use
`column_privileges`:

```sql
select table_name, grantee, string_agg(privilege_type, ', ')
  from information_schema.table_privileges
 where table_schema = 'public' and grantee in ('anon','authenticated')
 group by table_name, grantee;
```

Expect SELECT only, and nothing at all on `watchlist` beyond the owner policy.
Any INSERT, DELETE or TRUNCATE there is the trap above resurfacing on a table
whose migration forgot its `revoke`.
