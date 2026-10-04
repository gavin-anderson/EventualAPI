import client from "prom-client";

/**
 * Prometheus metrics. A single default registry is scraped at /metrics by Alloy
 * (mirroring the hl-ingest observability pattern). Default process/runtime
 * metrics plus an HTTP request histogram.
 */
export const registry = new client.Registry();
registry.setDefaultLabels({ service: "hl-api" });
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
