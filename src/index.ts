import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { logger } from "./lib/logger.js";

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      env: config.env,
      authBridge: config.auth.configured ? "configured" : "not_configured",
      push: config.apns.configured ? "configured" : "not_configured",
    },
    "hl-api listening",
  );
});

/** Graceful shutdown: stop accepting connections, then exit. */
function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  server.close((err) => {
    if (err) logger.error({ err }, "error during server close");
    process.exit(err ? 1 : 0);
  });
  // Hard cap so a hung connection can't block shutdown forever.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});
