import type { RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import { httpRequestDuration } from "../lib/metrics.js";

/** Attach a request id + a child logger, and emit a structured access log. */
export const requestLogger: RequestHandler = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers["x-request-id"];
    const id = (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
    res.setHeader("x-request-id", id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  // Health/metrics polling would drown the logs; record but don't log them.
  autoLogging: {
    ignore: (req) =>
      req.url === "/healthz" || req.url === "/readyz" || req.url === "/metrics",
  },
});

/**
 * Record HTTP request duration into Prometheus, labelled by the matched route
 * (low cardinality) rather than the raw URL.
 */
export const metricsTimer: RequestHandler = (req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path
      ? `${req.baseUrl ?? ""}${req.route.path}`
      : req.path;
    end({
      method: req.method,
      route,
      status: String(res.statusCode),
    });
  });
  next();
};
