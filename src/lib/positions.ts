import { supabaseAdmin } from "./supabase.js";
import { fetchClearinghouseState } from "./hyperliquid.js";
import { verifyTrade, type VerifiedTrade } from "./tradeVerification.js";
import { config } from "../config/env.js";
import { logger } from "./logger.js";

const UNIQUE_VIOLATION = "23505";

/** Everything hl-api reads back; the public grant is narrower. */
const POSITION_COLUMNS = `
  id, user_id, coin, side,
  entry_px, size, notional, fee_paid, opened_at, open_cloid,
  leverage, liquidation_px, margin_used,
  closed_at, exit_px, realized_pnl, close_fee_paid, close_cloid,
  open_take, open_take_at, open_take_until,
  close_take, close_take_at, close_take_until,
  hidden_at, created_at`;

export interface PositionRow {
  id: string;
  user_id: string;
  coin: string;
  side: "long" | "short";
  entry_px: number;
  size: number;
  notional: number;
  fee_paid: number | null;
  opened_at: string;
  open_cloid: string;
  leverage: number | null;
  liquidation_px: number | null;
  margin_used: number | null;
  closed_at: string | null;
  exit_px: number | null;
  realized_pnl: number | null;
  close_fee_paid: number | null;
  close_cloid: string | null;
  open_take: string | null;
  open_take_at: string | null;
  open_take_until: string | null;
  close_take: string | null;
  close_take_at: string | null;
  close_take_until: string | null;
  hidden_at: string | null;
  created_at: string;
}

export interface RecordResult {
  position: PositionRow;
  /** False when this call was a replay of one already recorded. */
  created: boolean;
}

function windowEnd(from: Date): string {
  return new Date(from.getTime() + config.takes.windowSeconds * 1000).toISOString();
}

/**
 * Leverage, liquidation price and margin from Hyperliquid at trade time.
 *
 * Best-effort: an outage must not stop us recording a trade that demonstrably
 * happened, so all three are nullable. `liquidationPx` is HL's own number —
 * maintenance margin is tiered per market, so a 1/leverage estimate is wrong
 * exactly near the edge, which is the only place it is read.
 */
async function openContext(wallet: string, coin: string) {
  try {
    const state = await fetchClearinghouseState(wallet, config.hyperliquid.dex);
    const held = state.assetPositions.find(
      (ap) => ap.position.coin === coin || ap.position.coin.endsWith(`:${coin}`),
    );
    if (!held) return {};
    const p = held.position;
    return {
      leverage: p.leverage?.value ?? null,
      liquidation_px: p.liquidationPx ? Number(p.liquidationPx) : null,
      margin_used: p.marginUsed ? Number(p.marginUsed) : null,
    };
  } catch (err) {
    logger.warn({ err, wallet, coin }, "could not read open context; recording trade without it");
    return {};
  }
}

/**
 * Record a newly opened position, verified against Hyperliquid. Idempotent on
 * `open_cloid`, so retries and relaunches can't duplicate it.
 */
export async function recordOpen(
  userId: string,
  wallet: string,
  cloid: string,
): Promise<RecordResult> {
  const trade: VerifiedTrade = await verifyTrade(wallet, cloid, "open");
  const db = supabaseAdmin();

  const existing = await findByCloid(userId, cloid);
  if (existing) return { position: existing, created: false };

  const context = await openContext(wallet, trade.coin);

  const { data, error } = await db
    .from("positions")
    .insert({
      user_id: userId,
      wallet_address: wallet,
      coin: trade.coin,
      side: trade.side,
      entry_px: trade.price,
      size: trade.size,
      notional: trade.notional,
      fee_paid: trade.feePaid,
      opened_at: trade.tradedAt.toISOString(),
      open_cloid: cloid,
      // Window starts at the FILL, not this request, or a slow hook extends it.
      open_take_until: windowEnd(trade.tradedAt),
      ...context,
    })
    .select(POSITION_COLUMNS)
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const raced = await findByCloid(userId, cloid);
      if (raced) return { position: raced, created: false };
    }
    throw new Error(`position insert failed: ${error.message}`);
  }
  return { position: data as PositionRow, created: true };
}

export type CloseOutcome =
  | { ok: true; position: PositionRow; created: boolean }
  | { ok: false; code: "no_open_position"; message: string };

/**
 * Record a close, verified against Hyperliquid. Idempotent on `close_cloid`.
 *
 * Refuses when no open position is on file rather than inventing one — it may
 * predate this system or have been opened outside the app, and a half-known row
 * would put a close with no entry into the feed.
 */
export async function recordClose(
  userId: string,
  wallet: string,
  cloid: string,
): Promise<CloseOutcome> {
  const trade = await verifyTrade(wallet, cloid, "close");
  const db = supabaseAdmin();

  const alreadyRecorded = await findByCloid(userId, cloid);
  if (alreadyRecorded) return { ok: true, position: alreadyRecorded, created: false };

  const { data: open, error: findError } = await db
    .from("positions")
    .select(POSITION_COLUMNS)
    .eq("user_id", userId)
    .eq("coin", trade.coin)
    .is("closed_at", null)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findError) throw new Error(`position lookup failed: ${findError.message}`);

  if (!open) {
    return {
      ok: false,
      code: "no_open_position",
      message: `no open ${trade.coin} position on file for this account`,
    };
  }

  const { data, error } = await db
    .from("positions")
    .update({
      closed_at: trade.tradedAt.toISOString(),
      exit_px: trade.price,
      realized_pnl: trade.realizedPnl,
      close_fee_paid: trade.feePaid,
      close_cloid: cloid,
      close_take_until: windowEnd(trade.tradedAt),
    })
    .eq("id", (open as PositionRow).id)
    .select(POSITION_COLUMNS)
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const raced = await findByCloid(userId, cloid);
      if (raced) return { ok: true, position: raced, created: false };
    }
    throw new Error(`position close failed: ${error.message}`);
  }
  return { ok: true, position: data as PositionRow, created: true };
}

// ── Takes ─────────────────────────────────────────────────────────────────────

export type TakeOutcome =
  | { ok: true; position: PositionRow; kind: "open" | "close" }
  | {
      ok: false;
      code: "unknown_trade" | "window_closed" | "already_posted";
      message: string;
    };

/**
 * Post a take against a trade, identified by its client order id. The cloid
 * tells us which half this is, so the client can't say the wrong one.
 *
 * The refusals are normal outcomes, not errors.
 */
export async function postTake(
  userId: string,
  cloid: string,
  text: string,
): Promise<TakeOutcome> {
  const position = await findByCloid(userId, cloid);
  if (!position) {
    return { ok: false, code: "unknown_trade", message: "no recorded trade with that order id" };
  }

  const kind: "open" | "close" = position.open_cloid === cloid ? "open" : "close";
  const existingTake = kind === "open" ? position.open_take : position.close_take;
  const until = kind === "open" ? position.open_take_until : position.close_take_until;

  if (existingTake !== null) {
    return {
      ok: false,
      code: "already_posted",
      message: "a take has already been posted for that trade",
    };
  }
  if (!until || Date.parse(until) < Date.now()) {
    return {
      ok: false,
      code: "window_closed",
      message: "the window for posting about that trade has closed",
    };
  }

  const now = new Date().toISOString();
  const patch =
    kind === "open"
      ? { open_take: text, open_take_at: now }
      : { close_take: text, close_take_at: now };

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("positions")
    .update(patch)
    .eq("id", position.id)
    // Re-checked in WHERE so two concurrent posts can't both win.
    .is(kind === "open" ? "open_take" : "close_take", null)
    .select(POSITION_COLUMNS)
    .maybeSingle();

  if (error) throw new Error(`take post failed: ${error.message}`);
  if (!data) {
    return {
      ok: false,
      code: "already_posted",
      message: "a take has already been posted for that trade",
    };
  }
  return { ok: true, position: data as PositionRow, kind };
}

/**
 * Scoped to the caller: cloids are public in HL's fills, so an unscoped lookup
 * would hand back someone else's row. Two `.eq()`s rather than `.or()` so the
 * cloid is never interpolated into a PostgREST filter string.
 */
async function findByCloid(userId: string, cloid: string): Promise<PositionRow | null> {
  const db = supabaseAdmin();
  for (const column of ["open_cloid", "close_cloid"] as const) {
    const { data, error } = await db
      .from("positions")
      .select(POSITION_COLUMNS)
      .eq("user_id", userId)
      .eq(column, cloid)
      .maybeSingle();
    if (error) throw new Error(`position lookup failed: ${error.message}`);
    if (data) return data as PositionRow;
  }
  return null;
}
