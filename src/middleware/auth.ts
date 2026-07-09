import type { Request, RequestHandler } from "express";
import { config } from "../config/env.js";
import { serviceUnavailable, unauthorized } from "../lib/httpError.js";
import { verifyPrivyToken, type VerifiedPrivyIdentity } from "../lib/authBridge.js";

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
