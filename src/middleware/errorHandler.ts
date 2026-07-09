import type { ErrorRequestHandler, RequestHandler } from "express";
import { HttpError } from "../lib/httpError.js";

/** Wrap async route handlers so thrown/rejected errors reach the error handler. */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** 404 for unmatched routes. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "not_found", message: "route not found" });
};

/** Central error renderer: stable JSON, leak-safe for 5xx. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const log = req.log ?? console;

  if (err instanceof HttpError) {
    if (err.status >= 500) log.error({ err }, "request failed");
    res.status(err.status).json({
      error: err.code,
      message: err.expose ? err.message : "internal error",
    });
    return;
  }

  log.error({ err }, "unhandled error");
  res.status(500).json({ error: "internal_error", message: "internal error" });
};
