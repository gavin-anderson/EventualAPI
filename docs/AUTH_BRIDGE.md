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

For BFF-proprietary calls (ClickHouse market data, per-user Hyperliquid later),
the app keeps sending the **Privy** token to hl-api; for direct Supabase CRUD +
Realtime it uses the **minted Supabase** token.

## Identity model

- The stable user id is the **Privy DID** (e.g. `did:privy:abc123`).
- It is the `profiles` primary key AND the minted JWT `sub`.
- Because `sub` is **text, not a uuid**, RLS uses `auth.jwt() ->> 'sub'`,
  **never** `auth.uid()` (which expects a uuid and would be null/error here).
- Profiles are created **lazily** on the first authenticated call (`GET /v1/profile`),
  upserted server-side with the service role. No Privy webhook needed.

## Wallet enrichment (later)

The Privy access token does not carry the linked wallet. Resolving the user's
Hyperliquid address uses the Privy server SDK's `getUser()` (needs the Privy app
secret). Until then, `wallet` is `null` and `profiles.wallet_address` stays empty.

## Enabling

The bridge turns on only when **both** halves are configured (`config.auth.configured`):

- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`
- Privy: `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY`

Until then, `/v1/profile` and `/v1/auth/session` return `503 auth_not_configured`,
while the anonymous read tier (`/v1/market/sample`) works normally.
