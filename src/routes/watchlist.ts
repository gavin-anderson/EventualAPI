import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { badRequest } from "../lib/httpError.js";
import {
  listWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  normalizeTicker,
} from "../lib/watchlist.js";

export const watchlistRouter = Router();

/**
 * Watchlist — the ★ toggle. Shaped to the app's `WatchlistService`: a flat list
 * plus add/remove by ticker, as idempotent PUT/DELETE on the sub-resource.
 */

// Generous: this exists to stop a stuck loop, not to ration taps.
const limit = rateLimit({ name: "watchlist", max: 120, windowMs: 60_000 });

/** GET /v1/watchlist — AUTHENTICATED. The caller's starred tickers. */
watchlistRouter.get(
  "/watchlist",
  requireAuth,
  asyncHandler(async (req, res) => {
    const tickers = await listWatchlist(req.identity!.privyDid);
    res.json({ count: tickers.length, tickers });
  }),
);

/**
 * PUT /v1/watchlist/:ticker — AUTHENTICATED. 200 either way; `added` says
 * whether anything changed.
 *
 * Not validated against `assets`: our catalogue is sparser than the live HL
 * universe, so refusing a real market would be worse than allowing a dead one.
 */
watchlistRouter.put(
  "/watchlist/:ticker",
  requireAuth,
  limit,
  asyncHandler(async (req, res) => {
    const ticker = normalizeTicker(req.params["ticker"] ?? "");
    if (!ticker) throw badRequest("invalid ticker");
    const added = await addToWatchlist(req.identity!.privyDid, ticker);
    res.json({ ticker, watchlisted: true, added });
  }),
);

/** DELETE /v1/watchlist/:ticker — AUTHENTICATED. Un-star. Idempotent. */
watchlistRouter.delete(
  "/watchlist/:ticker",
  requireAuth,
  limit,
  asyncHandler(async (req, res) => {
    const ticker = normalizeTicker(req.params["ticker"] ?? "");
    if (!ticker) throw badRequest("invalid ticker");
    const removed = await removeFromWatchlist(req.identity!.privyDid, ticker);
    res.json({ ticker, watchlisted: false, removed });
  }),
);
