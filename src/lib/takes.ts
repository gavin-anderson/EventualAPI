import { supabaseAdmin } from "./supabase.js";
import { fetchClearinghouseState, bareCoin, type ClearinghouseState } from "./hyperliquid.js";
import { config } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Takes: comments on OPEN positions.
 *
 * One live take per user per coin — Hyperliquid holds one position per wallet
 * and coin, so that is one per position. It can be posted or edited any time
 * while the position is open, and it is removed the moment the position closes
 * or changes. "Changes" means size or side; leverage and margin don't count.
 *
 * A take carries a snapshot of the position it was written about, read from
 * Hyperliquid when it was posted. The snapshot is both what the feed shows and
 * what a change is detected against. Removal is soft (`removed_at` plus a
 * reason): hidden everywhere, kept for moderation. The changed position can
 * then take a fresh one.
 *
 * Changes are noticed from three directions, fastest first:
 *   1. the app reports a trade (open or add, close) — removed immediately;
 *   2. liquidation detection — within about a minute;
 *   3. the position refresh (`reconcileWalletTakes`) — within a refresh
 *      (2 minutes for a wallet holding positions), and the only one that sees
 *      a change made outside the app.
 * Posting and editing also check Hyperliquid live, so a stale take can't be
 * edited in the gap. What none of these see is a change that is undone before
 * the next refresh — add then trim back to the same size — which leaves the
 * take as it was, on what is again the same position.
 */

const UNIQUE_VIOLATION = "23505";

export type RemovalReason = "closed" | "changed" | "liquidated";

const TAKE_COLUMNS =
  "id, user_id, wallet_address, coin, position_id, side, size, entry_px, leverage, " +
  "text, posted_at, edited_at, removed_at, removed_reason";

export interface TakeRow {
  id: string;
  user_id: string;
  wallet_address: string;
  coin: string;
  position_id: string | null;
  side: "long" | "short";
  size: number;
  entry_px: number;
  leverage: number | null;
  text: string;
  posted_at: string;
  edited_at: string | null;
  removed_at: string | null;
  removed_reason: RemovalReason | null;
}

/** A position as Hyperliquid reports it, reduced to what a take snapshots. */
export interface Held {
  side: "long" | "short";
  size: number;
  entryPx: number;
  leverage: number | null;
}

/** The wallet's position in `coin`, or null when it holds none. */
export function heldPosition(state: ClearinghouseState, coin: string): Held | null {
  for (const { position: p } of state.assetPositions) {
    const szi = Number(p.szi);
    if (bareCoin(p.coin) !== coin || !szi) continue;
    return {
      side: szi > 0 ? "long" : "short",
      size: Math.abs(szi),
      entryPx: Number(p.entryPx) || 0,
      leverage: p.leverage?.value ?? null,
    };
  }
  return null;
}

/** HL sizes are short decimals; compare with room for float noise only. */
function sameSize(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Why a take no longer stands, or null if it does: the position is gone, or
 * its size or side is not what the take was written about.
 */
export function changeReason(
  take: Pick<TakeRow, "side" | "size">,
  held: Pick<Held, "side" | "size"> | null,
): "closed" | "changed" | null {
  if (!held) return "closed";
  if (held.side !== take.side || !sameSize(held.size, Number(take.size))) return "changed";
  return null;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The user's live takes, one per coin at most. */
export async function liveTakes(userId: string): Promise<TakeRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("takes")
    .select(TAKE_COLUMNS)
    .eq("user_id", userId)
    .is("removed_at", null)
    .order("posted_at", { ascending: false });
  if (error) throw new Error(`takes read failed: ${error.message}`);
  return (data as unknown as TakeRow[]) ?? [];
}

export async function liveTake(userId: string, coin: string): Promise<TakeRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("takes")
    .select(TAKE_COLUMNS)
    .eq("user_id", userId)
    .eq("coin", coin)
    .is("removed_at", null)
    .maybeSingle();
  if (error) throw new Error(`take read failed: ${error.message}`);
  return (data as unknown as TakeRow | null) ?? null;
}

// ── Posting and editing ───────────────────────────────────────────────────────

export type TakeWriteOutcome =
  | { ok: true; take: TakeRow }
  | {
      ok: false;
      code: "no_open_position" | "already_posted" | "no_live_take" | "position_changed";
      message: string;
    };

/**
 * Post the take on the user's open position in `coin`.
 *
 * The position is read from Hyperliquid now, not from what the app recorded:
 * any open position can take a take, including one opened outside the app.
 * A live take that the position has since outgrown is removed first, so the
 * changed position gets its fresh one without waiting for the refresh job.
 */
export async function postTake(
  userId: string,
  wallet: string,
  coin: string,
  text: string,
): Promise<TakeWriteOutcome> {
  const held = heldPosition(await fetchClearinghouseState(wallet, config.hyperliquid.dex), coin);
  if (!held) {
    return { ok: false, code: "no_open_position", message: `no open ${coin} position on this account` };
  }

  const existing = await liveTake(userId, coin);
  if (existing) {
    const reason = changeReason(existing, held);
    if (!reason) {
      return {
        ok: false,
        code: "already_posted",
        message: "this position already has your take; edit it instead",
      };
    }
    await removeTake(existing.id, reason);
  }

  const db = supabaseAdmin();
  // Link the app's record of the trade when there is one, for its open time.
  const { data: row } = await db
    .from("positions")
    .select("id")
    .eq("user_id", userId)
    .eq("coin", coin)
    .eq("side", held.side)
    .is("closed_at", null)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await db
    .from("takes")
    .insert({
      user_id: userId,
      wallet_address: wallet,
      coin,
      position_id: (row as { id: string } | null)?.id ?? null,
      side: held.side,
      size: held.size,
      entry_px: held.entryPx,
      leverage: held.leverage,
      text,
    })
    .select(TAKE_COLUMNS)
    .single();

  if (error) {
    // Two posts at once: the partial unique index lets exactly one through.
    if (error.code === UNIQUE_VIOLATION) {
      return {
        ok: false,
        code: "already_posted",
        message: "this position already has your take; edit it instead",
      };
    }
    throw new Error(`take post failed: ${error.message}`);
  }
  return { ok: true, take: data as unknown as TakeRow };
}

/**
 * Replace the text of the user's live take on `coin`. Not a second take: same
 * row, `edited_at` stamped. Checked against Hyperliquid first, so a take whose
 * position has changed is removed rather than edited.
 */
export async function editTake(
  userId: string,
  wallet: string,
  coin: string,
  text: string,
): Promise<TakeWriteOutcome> {
  const existing = await liveTake(userId, coin);
  if (!existing) {
    return { ok: false, code: "no_live_take", message: `you have no take on an open ${coin} position` };
  }

  const held = heldPosition(await fetchClearinghouseState(wallet, config.hyperliquid.dex), coin);
  const reason = changeReason(existing, held);
  if (reason) {
    await removeTake(existing.id, reason);
    return {
      ok: false,
      code: "position_changed",
      message:
        reason === "closed"
          ? "that position has closed, so its take was removed"
          : "that position has changed since you posted, so its take was removed; post a new one",
    };
  }

  const { data, error } = await supabaseAdmin()
    .from("takes")
    .update({ text, edited_at: new Date().toISOString() })
    .eq("id", existing.id)
    // Re-checked in WHERE so an edit can't revive a take removed meanwhile.
    .is("removed_at", null)
    .select(TAKE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`take edit failed: ${error.message}`);
  if (!data) {
    return { ok: false, code: "no_live_take", message: `you have no take on an open ${coin} position` };
  }
  return { ok: true, take: data as unknown as TakeRow };
}

// ── Removal ───────────────────────────────────────────────────────────────────

async function removeTake(id: string, reason: RemovalReason): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("takes")
    .update({ removed_at: new Date().toISOString(), removed_reason: reason })
    .eq("id", id)
    .is("removed_at", null);
  if (error) throw new Error(`take removal failed: ${error.message}`);
}

/**
 * Remove the user's live take on `coin`, if any, because the position closed
 * or changed at `at`. A take posted after `at` is about the position as it is
 * now and is left alone, which is what makes a re-scan of an old event safe.
 * Returns how many were removed (0 or 1).
 */
export async function removeLiveTake(
  userId: string,
  coin: string,
  reason: RemovalReason,
  at: Date,
): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from("takes")
    .update({ removed_at: new Date().toISOString(), removed_reason: reason })
    .eq("user_id", userId)
    .eq("coin", coin)
    .is("removed_at", null)
    .lte("posted_at", at.toISOString())
    .select("id");
  if (error) throw new Error(`take removal failed: ${error.message}`);
  const removed = ((data as unknown[]) ?? []).length;
  if (removed > 0) logger.info({ coin, reason }, "take removed");
  return removed;
}

/**
 * Compare a wallet's live takes with what Hyperliquid just reported for it, and
 * remove any whose position has closed or changed. Called by the position
 * refresh with the rows it mirrored, so it costs no extra HL call.
 */
export async function reconcileWalletTakes(
  wallet: string,
  held: Array<{ coin: string; side: "long" | "short"; size: number }>,
): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from("takes")
    .select("id, coin, side, size")
    .eq("wallet_address", wallet)
    .is("removed_at", null);
  if (error) throw new Error(`takes read failed: ${error.message}`);

  let removed = 0;
  for (const take of (data as Array<Pick<TakeRow, "id" | "coin" | "side" | "size">>) ?? []) {
    const reason = changeReason(take, held.find((h) => h.coin === take.coin) ?? null);
    if (!reason) continue;
    await removeTake(take.id, reason);
    removed += 1;
    logger.info({ coin: take.coin, reason }, "take removed by refresh");
  }
  return removed;
}
