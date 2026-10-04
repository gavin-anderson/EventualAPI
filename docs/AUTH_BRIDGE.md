# Auth bridge (Privy → Supabase)

Privy is the identity provider; Supabase RLS expects a Supabase-signed JWT. This
service bridges the two. **It is dormant until configured** — see "Enabling" below.

## Flow

```
App                         hl-api                         Supabase
 │  1. login (Privy SDK)                                      
 │ ───────────────► Privy                                     
 │  ◄─────────────── Privy access token                       
 │                                                            
 │  2. POST /v1/auth/session                                  
 │     Authorization: Bearer <privy access token>             
 │ ─────────────────────────────►                            
 │                     verify Privy token (offline, ES256,    
 │                     iss=privy.io, aud=PRIVY_APP_ID)        
 │                     mint Supabase JWT (HS256, sub=DID,     
 │                       role=authenticated)                  
 │  ◄───────────────────────────── { supabaseAccessToken }   
 │                                                            
 │  3. direct Supabase calls under RLS                        
 │     supabase.auth.setSession(supabaseAccessToken)          
 │ ──────────────────────────────────────────────────────►   
 │                                            RLS: id = jwt.sub
```

For BFF-proprietary calls (earnings data, per-user Hyperliquid reads),
the app keeps sending the **Privy** token to hl-api; for direct Supabase CRUD +
Realtime it uses the **minted Supabase** token.

## Identity model

- The stable user id is the **Privy DID** (e.g. `did:privy:abc123`).
- It is the `profiles` primary key AND the minted JWT `sub`.
- Because `sub` is **text, not a uuid**, RLS uses `auth.jwt() ->> 'sub'`,
  **never** `auth.uid()` (which expects a uuid and would be null/error here).
- Profiles are created **lazily** on the first authenticated call
  (`POST /v1/auth/signup`, or `GET /v1/profile`), with the service role. No Privy
  webhook needed.

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
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` | minting sessions |
| `PRIVY_APP_ID` | token audience |
| `PRIVY_VERIFICATION_KEY` | offline token verification (ES256 **public key**, not the app id) |
| `PRIVY_APP_SECRET` | wallet resolution only |

`config.auth.configured` gates the authenticated routes; `privy.canResolveWallet`
is tracked separately, so sign-in can work before wallet resolution does.
Unconfigured, authenticated routes return `503 auth_not_configured` while the
anonymous read tier (`/v1/earnings`, `/v1/assets`) works normally.
