import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler.js";
import { registry } from "../lib/metrics.js";

export const metricsRouter = Router();

/** Prometheus scrape endpoint (Alloy reads this, per the hl-ingest pattern). */
metricsRouter.get(
  "/metrics",
  asyncHandler(async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.send(await registry.metrics());
  }),
);
