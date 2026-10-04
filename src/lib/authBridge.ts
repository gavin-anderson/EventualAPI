import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { unauthorized } from "./httpError.js";

/**
 * Privy token verification. No session minting: the app talks only to hl-api,
 * which reaches Supabase with the service role. See docs/AUTH_BRIDGE.md.
 *
 * Assumes config is present — `requireAuth` returns 503 when it isn't.
 */

export interface VerifiedPrivyIdentity {
  /** Privy user DID, e.g. "did:privy:abc123". This is our stable user id. */
  privyDid: string;
  /** Linked wallet (== the user's Hyperliquid address), if present on the token. */
  wallet?: string;
}

/**
 * Verify a Privy access token offline. It carries no wallet, so the address
 * comes from `fetchEmbeddedWallet`.
 */
export function verifyPrivyToken(token: string): VerifiedPrivyIdentity {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, pemFor(config.privy.verificationKey), {
      algorithms: ["ES256"],
      issuer: "privy.io",
      audience: config.privy.appId,
    }) as jwt.JwtPayload;
  } catch {
    throw unauthorized("invalid privy token");
  }

  const privyDid = payload.sub;
  if (!privyDid) throw unauthorized("privy token missing subject");
  return { privyDid };
}

/** Accept the key with or without PEM armour — a dashboard copy-paste loses it. */
function pemFor(key: string): string {
  const trimmed = key.trim();
  // Already armoured: just un-escape "\n" sequences, which is how a multi-line
  // key survives being put in a single-line env var.
  if (trimmed.includes("-----BEGIN")) return trimmed.replace(/\\n/g, "\n");

  // Bare base64 SPKI body: re-wrap it at 64 columns and add the armour.
  const body = trimmed.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? trimmed;
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}
