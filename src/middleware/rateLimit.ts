import type { Request, RequestHandler } from "express";
import { HttpError } from "../lib/httpError.js";

/**
 * Fixed-window rate limiting in process memory. Counters are per-process, so
 * behind N replicas the effective limit is N x the configured one — fine for
 * stopping a client hammering a loop, not for precise quotas.
 *
 * Keyed on the Privy DID where available, falling back to IP; IP alone would
 * punish everyone behind a carrier NAT.
 */

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
  /** Distinguishes buckets so two limiters don't share counters. */
  name: string;
}

const buckets = new Map<string, Window>();

function keyFor(name: string, req: Request): string {
  const who = req.identity?.privyDid ?? req.ip ?? "unknown";
  return `${name}:${who}`;
}

/** Drop expired windows so the map can't grow without bound. */
function sweep(now: number): void {
  if (buckets.size < 1000) return;
  for (const [k, w] of buckets) {
    if (w.resetAt <= now) buckets.delete(k);
  }
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    sweep(now);

    const key = keyFor(opts.name, req);
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      throw new HttpError(429, "rate_limited", `Too many requests. Retry in ${retryAfter}s.`);
    }
    next();
  };
}

/** Test seam. */
export function resetRateLimits(): void {
  buckets.clear();
}
