import express, { type Express } from "express";
import { requestLogger, metricsTimer } from "./middleware/requestContext.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { metricsRouter } from "./routes/metrics.js";
import { marketRouter } from "./routes/market.js";
import { assetsRouter } from "./routes/assets.js";
import { accountRouter } from "./routes/account.js";

/** Build the Express app. Pure wiring — no listening — so tests can import it. */
export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy (Caddy/Tailscale); trust it for client IP + proto.
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.use(express.json({ limit: "256kb" }));
  app.use(metricsTimer);
  app.use(requestLogger);

  // Ops endpoints (unversioned).
  app.use(healthRouter);
  app.use(metricsRouter);

  // Public + authenticated API, versioned under /v1.
  app.use("/v1/market", marketRouter);  // anonymous
  app.use("/v1/assets", assetsRouter); // anonymous
  app.use("/v1", accountRouter);       // authenticated (requireAuth per-route)

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
