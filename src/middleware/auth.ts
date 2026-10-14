import type { Request, RequestHandler } from "express";
import { config } from "../config/env.js";
import { HttpError, serviceUnavailable, unauthorized } from "../lib/httpError.js";
import { verifyPrivyToken, type VerifiedPrivyIdentity } from "../lib/authBridge.js";
import { fetchEmbeddedWallet } from "../lib/privy.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth once a Privy token is verified. */
      identity?: VerifiedPrivyIdentity;
    }
  }
}

function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token] = h.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

/**
 * Require a valid Privy access token. Until the auth bridge is configured (Privy
 * + Supabase secrets present), this short-circuits with 503 auth_not_configured
 * so the rest of the service still runs the anonymous read tier.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!config.auth.configured) {
    throw serviceUnavailable(
      "auth_not_configured",
      "authentication is not yet enabled on this deployment",
    );
  }

  const token = bearerToken(req);
  if (!token) {
    throw unauthorized("missing bearer token");
  }

  req.identity = verifyPrivyToken(token);
  next();
};

/**
 * Require the caller's embedded wallet. Must run after `requireAuth`.
 *
 * Two failure modes, two status codes on purpose: 503 when this deployment
 * can't resolve wallets at all (missing PRIVY_APP_SECRET), 409 when the user
 * has none yet (transient while it provisions).
 */
export const requireWallet: RequestHandler = async (req, _res, next) => {
  const identity = req.identity;
  if (!identity) {
    next(unauthorized("missing identity"));
    return;
  }

  if (!config.privy.canResolveWallet) {
    next(
      serviceUnavailable(
        "wallet_resolution_not_configured",
        "this deployment cannot resolve embedded wallets (PRIVY_APP_SECRET missing)",
      ),
    );
    return;
  }

  try {
    identity.wallet ??= (await fetchEmbeddedWallet(identity.privyDid)) ?? undefined;
  } catch (err) {
    next(err);
    return;
  }

  if (!identity.wallet) {
    next(
      new HttpError(
        409,
        "wallet_not_ready",
        "no embedded wallet is linked to this account yet",
      ),
    );
    return;
  }
  next();
};
