import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { config } from "../config/env.js";
import { clickhouseQueryDuration } from "./metrics.js";
import { logger } from "./logger.js";

/**
 * Read-only client for hl-ingest's ClickHouse. We connect over the HTTP
 * interface (:8123) because the native :9000 protocol is loopback-only on the
 * hl-ingest box; HTTP is the port exposed on the tailnet.
 *
 * This service NEVER writes to ClickHouse — hl-ingest owns it. We only SELECT.
 */
export const clickhouse: ClickHouseClient = createClient({
  url: config.clickhouse.url,
  username: config.clickhouse.username,
  password: config.clickhouse.password,
  database: config.clickhouse.database,
  // Keep the upstream honest: cap how long a single read can run.
  request_timeout: 10_000,
  clickhouse_settings: {
    // Defensive read-only guard at the protocol level.
    readonly: "1",
  },
});

/**
 * Run a SELECT and return typed rows. Records query duration for metrics and
 * tags slow/erroring queries in the logs. `name` is a low-cardinality label
 * (NOT the SQL) so Prometheus stays bounded.
 */
export async function query<T>(
  name: string,
  sql: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const end = clickhouseQueryDuration.startTimer({ query: name });
  try {
    const result = await clickhouse.query({
      query: sql,
      query_params: params,
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as T[];
    end({ status: "ok" });
    return rows;
  } catch (err) {
    end({ status: "error" });
    logger.error({ err, query: name }, "clickhouse query failed");
    throw err;
  }
}

/** Lightweight liveness check for the readiness probe. */
export async function pingClickHouse(): Promise<boolean> {
  try {
    const res = await clickhouse.ping();
    return res.success;
  } catch {
    return false;
  }
}
