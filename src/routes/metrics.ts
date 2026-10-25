import { Router, type RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { asyncHandler } from "../middleware/errorHandler.js";
import { notFound, unauthorized } from "../lib/httpError.js";
import { registry } from "../lib/metrics.js";
import { config } from "../config/env.js";

/** Hash both sides so the comparison is constant-time whatever the lengths. */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Prometheus scrape endpoint, behind a bearer secret. With no secret configured
 * it answers 404, so a deploy that forgets to set one doesn't publish internals.
 */
export function createMetricsRouter(token: string): Router {
  const router = Router();

  const requireToken: RequestHandler = (req, _res, next) => {
    if (!token) return next(notFound("route not found"));
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!presented || !sameSecret(presented, token)) {
      return next(unauthorized("metrics token required"));
    }
    next();
  };

  router.get(
    "/metrics",
    requireToken,
    asyncHandler(async (_req, res) => {
      res.set("Content-Type", registry.contentType);
      res.send(await registry.metrics());
    }),
  );
  return router;
}

export const metricsRouter = createMetricsRouter(config.metrics.token);
