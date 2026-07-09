# Access model & RLS

Two tiers, encoded in `supabase/migrations/20260621000000_init_profiles.sql`.

| Actor                | Profiles read | Profiles write          |
| -------------------- | ------------- | ----------------------- |
| `anon` (no token)    | ✅ all rows   | ❌                      |
| `authenticated`      | ✅ all rows   | ✅ own row only         |
| `service_role`       | ✅ (bypass)   | ✅ (bypass) — hl-api    |

"Own row" = `id = auth.jwt() ->> 'sub'`, where `sub` is the Privy DID set by the
minted Supabase session JWT.

## Why `auth.jwt() ->> 'sub'` and not `auth.uid()`

`auth.uid()` returns `sub` cast to **uuid**. Our `sub` is a Privy DID (text), so
`auth.uid()` would be null/error. All ownership checks compare the text `sub`
directly. Keep this in mind for every future user-scoped table.

## Service role

hl-api uses the **service role key** for the lazy profile upsert. That key
bypasses RLS, so it is server-only and must never reach the app. The app only
ever holds the **anon key** + a minted **session JWT**, both of which are subject
to RLS.

## Verifying RLS

After running the migration:

```sql
-- As anon: should return rows (public read).
set role anon;
select count(*) from public.profiles;

-- As anon: insert should be rejected by RLS.
insert into public.profiles (id) values ('did:privy:should_fail'); -- ERROR

reset role;
```

For a full check, mint a session JWT for a test DID and confirm it can write only
its own row.
