import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { unauthorized } from "./httpError.js";

/**
 * The auth bridge: Privy is the identity provider, but Supabase RLS expects a
 * Supabase-compatible JWT. So we (1) verify the Privy access token, then
 * (2) mint a short-lived Supabase session JWT the app uses for direct,
 * RLS-scoped Supabase access.
 *
 * Phase 0 note: this code path is dormant until both Privy and Supabase are
 * configured (see config.auth.configured). The route layer enforces that and
 * returns 503 auth_not_configured otherwise — this module assumes config exists.
 */

export interface VerifiedPrivyIdentity {
  /** Privy user DID, e.g. "did:privy:abc123". This is our stable user id. */
  privyDid: string;
  /** Linked wallet (== the user's Hyperliquid address), if present on the token. */
  wallet?: string;
}

/**
 * Verify a Privy access token OFFLINE using the app's public verification key.
 * Privy access tokens are ES256 JWTs issued by "privy.io" with the app id as the
 * audience. This avoids a network round-trip and needs no app secret.
 *
 * Wallet enrichment (resolving the linked Hyperliquid address) is done later via
 * the Privy server SDK's getUser(); the access token alone does not carry it.
 */
export function verifyPrivyToken(token: string): VerifiedPrivyIdentity {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.privy.verificationKey, {
      algorithms: ["ES256"],
      issuer: "privy.io",
      audience: config.privy.appId,
    }) as jwt.JwtPayload;
  } catch {
    throw unauthorized("invalid privy token");
  }

  const privyDid = payload.sub;
  if (!privyDid) {
    throw unauthorized("privy token missing subject");
  }

  return { privyDid };
}

/**
 * Mint a Supabase-compatible session JWT signed with the Supabase JWT secret.
 * RLS reads `auth.jwt() ->> 'sub'` (we use the Privy DID, a text value — NOT a
 * uuid, so policies must use the jwt sub directly, not auth.uid()).
 */
export function mintSupabaseSession(identity: VerifiedPrivyIdentity): {
  token: string;
  expiresIn: number;
} {
  const expiresIn = config.supabase.sessionTtlSeconds;
  const token = jwt.sign(
    {
      role: "authenticated",
      // Custom claims available to RLS via auth.jwt()->>'...'
      privy_did: identity.privyDid,
      ...(identity.wallet ? { wallet_address: identity.wallet } : {}),
    },
    config.supabase.jwtSecret,
    {
      algorithm: "HS256",
      subject: identity.privyDid,
      audience: "authenticated",
      expiresIn,
    },
  );
  return { token, expiresIn };
}
