import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { badRequest } from "../lib/httpError.js";
import { readFeed, positionSentiment, type FeedItemRow } from "../lib/feed.js";
import { normalizeTicker } from "../lib/watchlist.js";
import { avatarUrl } from "../lib/avatar.js";

export const feedRouter = Router();

/**
 * Reading the position feed — the counterpart to POST /v1/takes.
 *
 * Rooms are keyed on ticker, not on an earnings event. Event ids are derived
 * from a mutable `earnings_at`, so a calendar date revision would change the key
 * and silently split a room in two. A ticker doesn't get revised.
 */

function view(r: FeedItemRow) {
  return {
    id: r.id,
    kind: r.kind,
    // A URL, not a storage path. Null means the author has no photo and the app
    // draws its own default from the username.
    author: { id: r.user_id, username: r.username, imageUrl: avatarUrl(r.image_ref) },
    coin: r.coin,
    side: r.side,
    size: r.size,
    notional: r.notional,
    leverage: r.leverage,
    price: r.price,
    take: r.take,
    tradedAt: r.traded_at,
    postedAt: r.posted_at,
    // Only ever set on a close — the "here's how that went" post.
    realizedPnl: r.realized_pnl,
  };
}

const feedSchema = z.object({
  coin: z.string().trim().min(1).max(15).optional(),
  user: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /v1/feed — AUTHENTICATED.
 *
 * `?coin=TSLA` for one ticker's room, `?user=<did>` for one author's history,
 * neither for everything. Newest trade first.
 *
 * Only positions carrying a take appear: posting is what publishes a position,
 * and that is enforced in the view, not here.
 */
feedRouter.get(
  "/feed",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = feedSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { limit, offset, user } = parsed.data;

    let coin: string | undefined;
    if (parsed.data.coin) {
      const normalized = normalizeTicker(parsed.data.coin);
      if (!normalized) throw badRequest("invalid coin");
      coin = normalized;
    }

    const { items, total } = await readFeed({
      ...(coin ? { coin } : {}),
      ...(user ? { userId: user } : {}),
      limit,
      offset,
    });

    res.json({
      count: items.length,
      total,
      limit,
      offset,
      items: items.map(view),
    });
  }),
);

const sentimentSchema = z.object({
  coin: z.string().trim().min(1).max(15),
});

/**
 * GET /v1/feed/sentiment?coin= — AUTHENTICATED. Long/short split for a room.
 *
 * Counts every position opened through the app on this coin (open or closed),
 * take or no take. Positions opened outside the app aren't on file, so this is
 * the app's traders, not every holder on Hyperliquid.
 */
feedRouter.get(
  "/feed/sentiment",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = sentimentSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const coin = normalizeTicker(parsed.data.coin);
    if (!coin) throw badRequest("invalid coin");

    const { long, short } = await positionSentiment(coin);
    const total = long + short;
    res.json({
      coin,
      long,
      short,
      total,
      longPct: total > 0 ? Number((long / total).toFixed(4)) : null,
      basis: "app_positions",
    });
  }),
);
