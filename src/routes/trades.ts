import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth, requireWallet } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { badRequest, conflict, HttpError } from "../lib/httpError.js";
import { recordOpen, recordClose, findByCloid, type PositionRow } from "../lib/positions.js";
import { postTake, liveTake, type TakeRow } from "../lib/takes.js";
import { checkTakeText, throwTakeRefusal } from "./takes.js";
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

/** HL's client order id: 128 bits as 0x-prefixed hex, which is what the app makes. */
const cloid = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{32}$/, "cloid must be 0x followed by 32 hex characters");

const cloidSchema = z.object({ cloid });

/**
 * What the client needs back to drive the take composer. `live` is the user's
 * live take on the position, for an open. A close never takes one; its `take`
 * stays in the response so app builds that decode it keep working.
 */
function tradeView(p: PositionRow, kind: "open" | "close", live: TakeRow | null = null) {
  const take = kind === "open" ? (live?.text ?? null) : p.close_take;
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
      // The composer should appear only while this is true. Never for a close.
      canPost: kind === "open" && take === null,
      posted: take,
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

/**
 * Trade routes are limited harder than the rest: each one can make up to five
 * Hyperliquid /info calls from the dyno's one IP, and if HL 429s us, trade
 * verification and the position jobs stop working for everyone.
 */

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
  rateLimit({ name: "trade-open", max: 10, windowMs: 60_000 }),
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
      const live = await liveTake(identity.privyDid, position.coin);
      res
        .status(created ? 201 : 200)
        .json({ created, trade: tradeView(position, "open", live) });
    } catch (err) {
      asHttp(err);
    }
  }),
);

// ── POST /v1/trades/close ─────────────────────────────────────────────────────

/**
 * POST /v1/trades/close — AUTHENTICATED. Stamps the exit and realized PnL. A
 * close takes no take (see postTake).
 */
tradesRouter.post(
  "/trades/close",
  requireAuth,
  requireWallet,
  rateLimit({ name: "trade-close", max: 10, windowMs: 60_000 }),
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
  cloid,
  text: z.string().trim().min(1).max(2_000),
});

/**
 * POST /v1/takes — AUTHENTICATED. The original way to post: by the cloid of
 * the trade. Kept for app builds that still use it, and now just a door to
 * POST /v1/takes/:coin — the take goes on the open position the trade is part
 * of, under the same rules. A close's cloid is refused.
 */
tradesRouter.post(
  "/takes",
  requireAuth,
  requireWallet,
  rateLimit({ name: "take-post", max: 30, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const parsed = takeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const text = checkTakeText(parsed.data.text);
    const identity = req.identity!;

    const position = await findByCloid(identity.privyDid, parsed.data.cloid);
    if (!position) throw new HttpError(404, "unknown_trade", "no recorded trade with that order id");
    if (position.open_cloid !== parsed.data.cloid) {
      // 400 rather than 409: nothing about the state could change to allow it,
      // and the app shows a 400's message to the user as-is.
      throw new HttpError(
        400,
        "close_takes_removed",
        "takes are posted on open positions, not on closes",
      );
    }

    const result = await postTake(identity.privyDid, identity.wallet!, position.coin, text);
    if (!result.ok) throwTakeRefusal(result);
    res.status(201).json({ trade: tradeView(position, "open", result.take) });
  }),
);
