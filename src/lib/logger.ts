import pino from "pino";
import { config } from "../config/env.js";

/**
 * Structured JSON logging. In production we emit plain JSON lines (Grafana/Alloy
 * friendly). In development we pretty-print if pino-pretty is available, falling
 * back to JSON otherwise so dev never hard-depends on a transport.
 */
export const logger = pino({
  level: config.logLevel,
  base: { service: "hl-api" },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      'req.headers["x-proxy-key"]',
      "*.password",
      "*.serviceRoleKey",
      "*.jwtSecret",
    ],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
