# Auth bridge (Privy → Supabase)

Privy is the identity provider; Supabase RLS expects a Supabase-signed JWT. This
service bridges the two. **It is dormant until configured** — see "Enabling" below.

## Flow

```
App                              hl-api                      Supabase
 │  1. login (Privy SDK)
 │ ───────────────► Privy
 │  ◄─────────────── Privy access token
 │
 │  2. every request carries that token
 │     Authorization: Bearer <privy access token>
 │ ────────────────────────────►
 │                   verify offline (ES256, iss=privy.io,
 │                     aud=PRIVY_APP_ID)
 │                   resolve embedded wallet via getUser()
 │                                              ──────────────►
 │                                              service role,
 │                                              bypasses RLS
 │  ◄──────────────────────────  JSON
```

**The app never talks to Supabase directly.** Everything goes through hl-api,
which uses the service role. So there is no minted session JWT, no
`SUPABASE_JWT_SECRET`, and no need for the app to hold the anon key.

One consequence worth knowing: the RLS policies written for `anon` and
`authenticated` are therefore **inert** — no client ever connects as either
role. They are kept as defence in depth, not as the live access control, which
is simply "only the server has credentials."

## Identity model

- The stable user id is the **Privy DID** (e.g. `did:privy:abc123`).
- It is the `profiles` primary key AND the minted JWT `sub`.
- Because `sub` is **text, not a uuid**, RLS uses `auth.jwt() ->> 'sub'`,
  **never** `auth.uid()` (which expects a uuid and would be null/error here).
- Profiles are created **lazily** on the first authenticated call
  (`POST /v1/auth/signup`, or `GET /v1/profile`), with the service role. No Privy
  webhook needed.
- Ownership checks still use `auth.jwt() ->> 'sub'` in the RLS policies, even
  though nothing currently connects as `authenticated` — so the policies stay
  correct if that ever changes.

## Wallet resolution

The access token carries no wallet — `AuthTokenClaims` is only
`{ appId, issuer, issuedAt, expiration, sessionId, userId }`. The embedded
address comes from the Privy server SDK's `getUser()`, which needs the **app
secret**.

It reads the *embedded* wallet from `linkedAccounts` (`type: "wallet"` +
`walletClientType: "privy"` + `chainType: "ethereum"`), not `user.wallet` —
that field is the most recently linked wallet and can be an external one. The
embedded wallet is the account the app funds and signs with, so it is the only
address that joins our records to on-chain activity.

Failure is non-fatal: sign-up still succeeds and reports `walletStatus` as
`unresolved` (still provisioning) or `not_configured` (no app secret), with the
next call retrying.

## Enabling

| Credential | Needed for |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | all database access |
| `PRIVY_APP_ID` | token audience |
| `PRIVY_VERIFICATION_KEY` | offline token verification (ES256 **public key**, not the app id) |
| `PRIVY_APP_SECRET` | wallet resolution only |

`config.auth.configured` gates the authenticated routes; `privy.canResolveWallet`
is tracked separately, so sign-in can work before wallet resolution does.
Unconfigured, authenticated routes return `503 auth_not_configured` while the
anonymous reads (`/v1/earnings`) work normally.
