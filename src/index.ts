import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { clickhouse } from "./lib/clickhouse.js";

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      env: config.env,
      authBridge: config.auth.configured ? "configured" : "not_configured",
    },
    "hl-api listening",
  );
});

/** Graceful shutdown: stop accepting connections, then close upstreams. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  server.close(async (err) => {
    if (err) logger.error({ err }, "error during server close");
    try {
      await clickhouse.close();
    } catch (e) {
      logger.error({ err: e }, "error closing clickhouse client");
    }
    process.exit(err ? 1 : 0);
  });
  // Hard cap so a hung connection can't block shutdown forever.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});
