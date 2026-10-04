import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth, requireWallet } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { badRequest, conflict, HttpError } from "../lib/httpError.js";
import { recordOpen, recordClose, postTake, type PositionRow } from "../lib/positions.js";
import { TradeVerificationError } from "../lib/tradeVerification.js";
import { config } from "../config/env.js";

export const tradesRouter = Router();

/**
 * Trade notifications, not the trade path: the app submits to Hyperliquid
 * itself, then reports the order id so we can verify it. Side, size and price
 * come from HL's fills, never the request body. All idempotent on the cloid.
 *
 * PREREQUISITE: the app must attach a `cloid`. `HLClient.orderAction` supports
 * it (the `c` field) but `placeOrder` passes nil, so nothing here works yet.
 */

const cloidSchema = z.object({
  /** The order id the app attached. Format unconstrained — HL echoes it back. */
  cloid: z.string().trim().min(8).max(80),
});

/** What the client needs back to drive the take composer. */
function tradeView(p: PositionRow, kind: "open" | "close") {
  const until = kind === "open" ? p.open_take_until : p.close_take_until;
  const take = kind === "open" ? p.open_take : p.close_take;
  return {
    positionId: p.id,
    coin: p.coin,
    side: p.side,
    size: p.size,
    notional: p.notional,
    leverage: p.leverage,
    entryPx: p.entry_px,
    openedAt: p.opened_at,
    ...(kind === "close"
      ? { closedAt: p.closed_at, exitPx: p.exit_px, realizedPnl: p.realized_pnl }
      : {}),
    take: {
      kind,
      // The composer should appear only while this is true.
      canPost: take === null && !!until && Date.parse(until) > Date.now(),
      posted: take,
      windowClosesAt: until,
      maxLength: config.takes.maxLength,
    },
  };
}

/** 409: well-formed request that doesn't match the exchange. */
function asHttp(err: unknown): never {
  if (err instanceof TradeVerificationError) {
    throw new HttpError(409, err.code, err.message);
  }
  throw err;
}

// ── POST /v1/trades/open ──────────────────────────────────────────────────────

/**
 * POST /v1/trades/open — AUTHENTICATED. Call after submitting an order.
 *
 * 409 `fill_not_found` is also the right answer for an IOC that never filled —
 * the client should treat it as "no position, no composer", not retry forever.
 */
tradesRouter.post(
  "/trades/open",
  requireAuth,
  requireWallet,
  rateLimit({ name: "trade-open", max: 60, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const parsed = cloidSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const identity = req.identity!;

    try {
      const { position, created } = await recordOpen(
        identity.privyDid,
        identity.wallet!,
        parsed.data.cloid,
      );
      res.status(created ? 201 : 200).json({ created, trade: tradeView(position, "open") });
    } catch (err) {
      asHttp(err);
    }
  }),
);

// ── POST /v1/trades/close ─────────────────────────────────────────────────────

/**
 * POST /v1/trades/close — AUTHENTICATED. Stamps the exit and realized PnL, and
 * opens a second take window: the "here's how that went" post.
 */
tradesRouter.post(
  "/trades/close",
  requireAuth,
  requireWallet,
  rateLimit({ name: "trade-close", max: 60, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const parsed = cloidSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const identity = req.identity!;

    try {
      const result = await recordClose(
        identity.privyDid,
        identity.wallet!,
        parsed.data.cloid,
      );
      if (!result.ok) throw conflict(result.code, result.message);
      res
        .status(result.created ? 201 : 200)
        .json({ created: result.created, trade: tradeView(result.position, "close") });
    } catch (err) {
      asHttp(err);
    }
  }),
);

// ── POST /v1/takes ────────────────────────────────────────────────────────────

const takeSchema = z.object({
  cloid: z.string().trim().min(8).max(80),
  text: z.string().trim().min(1).max(2_000),
});

/**
 * POST /v1/takes — AUTHENTICATED. Separate because posting is optional.
 *
 * Posting is the consent moment for publishing a position: a row is only
 * publicly readable once it carries a take, enforced in RLS.
 */
tradesRouter.post(
  "/takes",
  requireAuth,
  rateLimit({ name: "take-post", max: 30, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const parsed = takeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    // Configurable, so enforced here rather than in the zod schema.
    const text = parsed.data.text;
    if (text.length > config.takes.maxLength) {
      throw badRequest(`a take may be at most ${config.takes.maxLength} characters`);
    }

    const result = await postTake(req.identity!.privyDid, parsed.data.cloid, text);
    if (!result.ok) {
      if (result.code === "unknown_trade") throw new HttpError(404, result.code, result.message);
      if (result.code === "not_yours") throw new HttpError(403, result.code, result.message);
      throw conflict(result.code, result.message);
    }
    res.status(201).json({ trade: tradeView(result.position, result.kind) });
  }),
);
