import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth, requireWallet } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { badRequest, HttpError } from "../lib/httpError.js";
import { normalizeTicker } from "../lib/watchlist.js";
import {
  postTake,
  editTake,
  liveTakes,
  type TakeRow,
  type TakeWriteOutcome,
} from "../lib/takes.js";
import { config } from "../config/env.js";

export const takesRouter = Router();

/**
 * Takes: one comment per open position, posted or edited any time while it is
 * open, removed when it closes or changes. Keyed by coin, because the user
 * holds at most one position per coin. Rules live in src/lib/takes.ts.
 */

export function takeView(t: TakeRow) {
  return {
    id: t.id,
    coin: t.coin,
    // The position as it was when the take was posted.
    side: t.side,
    size: t.size,
    entryPx: t.entry_px,
    leverage: t.leverage,
    text: t.text,
    postedAt: t.posted_at,
    editedAt: t.edited_at,
    maxLength: config.takes.maxLength,
  };
}

/** Trimmed text within the configured limit, or a 400. */
export function checkTakeText(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) throw badRequest("a take can't be empty");
  // Configurable, so enforced here rather than in the zod schema.
  if (text.length > config.takes.maxLength) {
    throw badRequest(`a take may be at most ${config.takes.maxLength} characters`);
  }
  return text;
}

/** Refusals are normal outcomes; each gets its own code for the app. */
export function throwTakeRefusal(result: Extract<TakeWriteOutcome, { ok: false }>): never {
  const status = result.code === "no_live_take" ? 404 : 409;
  throw new HttpError(status, result.code, result.message);
}

function coinParam(raw: string | undefined): string {
  const coin = normalizeTicker(raw ?? "");
  if (!coin) throw badRequest("invalid coin");
  return coin;
}

const textSchema = z.object({ text: z.string().max(2_000) });

/** GET /v1/takes/mine — AUTHENTICATED. The caller's live takes, one per coin at most. */
takesRouter.get(
  "/takes/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const takes = await liveTakes(req.identity!.privyDid);
    res.json({ takes: takes.map(takeView) });
  }),
);

/**
 * POST /v1/takes/:coin — AUTHENTICATED. Post the take on the caller's open
 * position in `coin`, checked live against Hyperliquid.
 *
 * 409 no_open_position · 409 already_posted (edit it instead) · 400 text.
 */
takesRouter.post(
  "/takes/:coin",
  requireAuth,
  requireWallet,
  rateLimit({ name: "take-post", max: 30, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const coin = coinParam(req.params["coin"]);
    const parsed = textSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    const identity = req.identity!;

    const result = await postTake(identity.privyDid, identity.wallet!, coin, checkTakeText(parsed.data.text));
    if (!result.ok) throwTakeRefusal(result);
    res.status(201).json({ take: takeView(result.take) });
  }),
);

/**
 * PATCH /v1/takes/:coin — AUTHENTICATED. Edit the caller's live take on `coin`.
 * Same take, new text, `editedAt` stamped.
 *
 * 404 no_live_take · 409 position_changed (the take was removed; post a new
 * one) · 400 text.
 */
takesRouter.patch(
  "/takes/:coin",
  requireAuth,
  requireWallet,
  rateLimit({ name: "take-post", max: 30, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const coin = coinParam(req.params["coin"]);
    const parsed = textSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    const identity = req.identity!;

    const result = await editTake(identity.privyDid, identity.wallet!, coin, checkTakeText(parsed.data.text));
    if (!result.ok) throwTakeRefusal(result);
    res.json({ take: takeView(result.take) });
  }),
);
