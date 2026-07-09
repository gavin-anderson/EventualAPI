import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler.js";
import { pingClickHouse } from "../lib/clickhouse.js";
import { config } from "../config/env.js";

export const healthRouter = Router();

/** Liveness: the process is up and serving. No dependency checks. */
healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * Readiness: can we actually serve traffic? Checks the upstream ClickHouse the
 * public read tier depends on. Reports (but does not fail on) the auth bridge
 * configuration state, since the service is intentionally usable anonymously.
 */
healthRouter.get(
  "/readyz",
  asyncHandler(async (_req, res) => {
    const clickhouse = await pingClickHouse();
    const ready = clickhouse;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "degraded",
      checks: {
        clickhouse: clickhouse ? "ok" : "unreachable",
        authBridge: config.auth.configured ? "configured" : "not_configured",
      },
    });
  }),
);
