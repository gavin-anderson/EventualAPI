# Access model & RLS

## The trap, first

This project's **default privileges grant every new table in `public` the full
privilege set to `anon` and `authenticated`** — including TRUNCATE, which RLS
cannot restrict. So RLS is the only control, and it is opt-in per table.

Every new table needs three things, not one:

```sql
alter table public.x enable row level security;
-- ...policies for exactly the commands intended...
revoke all on public.x from anon, authenticated;
grant select (...) on public.x to anon, authenticated;
```

The `revoke` looks redundant and isn't. Without it the table arrives fully
granted. A fix for the project-wide defaults is written but not applied:
`supabase/migrations/99999999999999_fix_overbroad_table_privileges.NOT_APPLIED.sql`.

## Identity

The stable user id is the **Privy DID** (`did:privy:abc123`). It is the
`profiles` primary key and the `sub` of the minted Supabase JWT.

Ownership checks use `auth.jwt() ->> 'sub'`, **never `auth.uid()`** — that casts
`sub` to uuid, and ours is text, so it would be null. This applies to every
user-scoped table.

## Per-table access

### `profiles`

| Actor | Read | Write |
| --- | --- | --- |
| `anon`, `authenticated` | `id, username, image_ref, display_name, created_at` | — |
| `authenticated` | (as above) | `display_name`, `image_ref` on own row |
| `service_role` | all | all |

Column-scoped deliberately. A Hyperliquid address is enough to pull a user's
entire position history from the chain, so a public `wallet_address` would link
a username to a complete trading record they never chose to share. `region` and
`eligibility` are likewise private.

Writes are column-scoped because RLS is row-level and cannot answer a
column-level question: the old blanket UPDATE grant let a user PATCH their own
row and set *any* field, `wallet_address` and `username` included.

### `username_claims`

Public read, service-role write. Append-only namespace: rows are retired via
`released_at`, never deleted, so a released username can never be reassigned.
That matters because the username doubles as the referral code.

### `positions`

| Actor | Read | Write |
| --- | --- | --- |
| `anon`, `authenticated` | rows **with a take**, non-hidden, public columns only | — |
| `service_role` | all | all |

The policy *is* the privacy model:

```sql
using (hidden_at is null and (open_take is not null or close_take is not null))
```

A position nobody posted about was never published — posting a take is the act
of consenting to reveal side and size. `wallet_address` and the cloids are
excluded from the public grant.

### Reference tables

`assets`, `earnings_events`, `earnings_history`, `earnings_odds` — public read,
service-role write. `account_value_snapshots` — owner read only
(`user_id = auth.jwt() ->> 'sub'`), service-role write.

## Keys

- **service role key**: server-only, bypasses RLS. Never reaches the app.
- **anon key**: ships inside the app, so treat it as public. Everything it can
  reach is effectively public.
- **minted session JWT**: short-lived, `sub` = Privy DID, subject to RLS.

## Verifying

```sql
set role anon;
select count(*) from public.profiles;            -- allowed (public columns)
select wallet_address from public.profiles;      -- ERROR 42501
insert into public.profiles (id) values ('x');   -- rejected
reset role;
```

Column grants are not visible in `information_schema.table_privileges`; use
`information_schema.column_privileges`.
