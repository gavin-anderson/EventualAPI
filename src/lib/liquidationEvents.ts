import { supabaseAdmin } from "./supabase.js";
import { fetchUserFills, bareCoin, type HlFill } from "./hyperliquid.js";
import { notify } from "./notify.js";
import { logger } from "./logger.js";
import { removeLiveTake } from "./takes.js";

/**
 * Detecting liquidations, and telling the user once.
 *
 * DETECTION RULE (verified against live fills, 2026-10-04): a wallet was
 * liquidated when its own fill carries a `liquidation` object whose
 * `liquidatedUser` equals that wallet.
 *
 * The naive check — "does this fill have a liquidation field" — is wrong and
 * would notify the wrong person. On your account that field usually means you
 * were the counterparty who absorbed someone else's position: `dir: "Open …"`,
 * `closedPnl: 0`, `liquidatedUser` a different address. The victim's own fill
 * is the mirror image: `dir: "Close …"`, a negative `closedPnl`, and
 * `liquidatedUser` set to themselves.
 */

/** Re-scan overlap, so a fill arriving slightly out of order isn't missed. */
const OVERLAP_MS = 10 * 60_000;
/** First scan for a wallet reaches back this far rather than all of history. */
const FIRST_SCAN_MS = 24 * 60 * 60_000;
/**
 * HL can take one position down in steps a few seconds apart: a partial
 * "market" liquidation, then a "backstop" one for the rest (verified on an INTC
 * long, 2026-10-29: 0.36 then 0.74, six seconds apart). Steps of the same
 * position closer than this are one liquidation to the user.
 */
const STEP_GAP_MS = 60_000;
/**
 * A partial liquidation waits this long before it is announced, so a follow-up
 * step can join it into one push. Shorter than OVERLAP_MS, so the re-scan that
 * finally announces it still sees its fills; longer than STEP_GAP_MS, so once
 * announced no later step can merge into it and re-announce the same loss.
 */
const PARTIAL_SETTLE_MS = 2 * 60_000;

export interface DetectResult {
  walletsScanned: number;
  eventsFound: number;
  notified: number;
  positionsClosed: number;
  errors: number;
}

interface Candidate {
  wallet_address: string;
  user_id: string;
  fills_checked_at: string | null;
}

/**
 * One liquidation unwinds in several fills — 8 in the verified sample, all
 * sharing a timestamp. They are grouped into the single event they are, so the
 * user hears about it once with the full size and loss.
 */
export interface Grouped {
  coin: string;
  side: "long" | "short";
  liquidatedAt: Date;
  size: number;
  realizedPnl: number;
  markPx: number | null;
  method: string | null;
  fillCount: number;
  /** Fees across the event's fills, carried onto the closed position rows. */
  fee: number;
  /**
   * Size still held once the event's fills settle. Zero means the position is
   * gone; anything above is a partial liquidation, and the position stays open.
   */
  remaining: number;
}

/** Size left after one fill: it closes `sz` of `|startPosition|`. */
function remainingAfter(f: HlFill): number {
  return Math.max(0, Math.abs(Number(f.startPosition) || 0) - (Number(f.sz) || 0));
}

export function group(fills: HlFill[], wallet: string): Grouped[] {
  const own = wallet.toLowerCase();
  const byEvent = new Map<string, Grouped>();

  for (const f of fills) {
    const liq = f.liquidation;
    // The whole rule, in one condition.
    if (!liq || liq.liquidatedUser?.toLowerCase() !== own) continue;

    const coin = bareCoin(f.coin);
    const key = `${coin}:${f.time}`;
    const size = Number(f.sz) || 0;
    const pnl = Number(f.closedPnl) || 0;
    const fee = Number(f.fee) || 0;

    const existing = byEvent.get(key);
    if (existing) {
      existing.size += size;
      existing.realizedPnl += pnl;
      existing.fee += fee;
      existing.fillCount += 1;
      // The fills share a timestamp, so their order is not trusted: the
      // smallest remainder is the one left after all of them.
      existing.remaining = Math.min(existing.remaining, remainingAfter(f));
      continue;
    }
    byEvent.set(key, {
      coin,
      // The fill CLOSES the position, so its side is the opposite of what was
      // held: a long is closed by selling (side "A").
      side: f.side === "A" ? "long" : "short",
      liquidatedAt: new Date(f.time),
      size,
      realizedPnl: pnl,
      markPx: Number(liq.markPx) || null,
      method: liq.method ?? null,
      fillCount: 1,
      fee,
      remaining: remainingAfter(f),
    });
  }
  return joinSteps([...byEvent.values()]);
}

/**
 * Merge the steps of one liquidation (see STEP_GAP_MS) into a single event,
 * keyed and priced by its last step: that is when and where the position was
 * finally taken, and the loss and size are the totals across all steps.
 */
function joinSteps(events: Grouped[]): Grouped[] {
  const sorted = events.sort((a, b) => a.liquidatedAt.getTime() - b.liquidatedAt.getTime());
  const out: Grouped[] = [];
  const lastOf = new Map<string, Grouped>();
  for (const e of sorted) {
    const key = `${e.coin}:${e.side}`;
    const prev = lastOf.get(key);
    if (
      prev &&
      prev.remaining > 0 &&
      e.liquidatedAt.getTime() - prev.liquidatedAt.getTime() <= STEP_GAP_MS
    ) {
      prev.size += e.size;
      prev.realizedPnl += e.realizedPnl;
      prev.fee += e.fee;
      prev.fillCount += e.fillCount;
      prev.liquidatedAt = e.liquidatedAt;
      prev.markPx = e.markPx;
      prev.method = e.method;
      prev.remaining = e.remaining;
      continue;
    }
    out.push(e);
    lastOf.set(key, e);
  }
  return out;
}

/** A partial that may still be joined by a next step is not announced yet. */
export function isSettled(e: Grouped, now = Date.now()): boolean {
  return e.remaining === 0 || now - e.liquidatedAt.getTime() >= PARTIAL_SETTLE_MS;
}

/**
 * Scan tracked wallets for liquidations and notify any that are new.
 *
 * Idempotency comes from the `liquidation_events` primary key
 * (wallet, coin, liquidated_at): a re-scan of the same window inserts nothing,
 * so nobody is told twice. That matters more than usual here — a duplicate
 * "you were liquidated" would be alarming.
 */
export async function detectLiquidations(budget = 100): Promise<DetectResult> {
  const db = supabaseAdmin();
  const result: DetectResult = {
    walletsScanned: 0,
    eventsFound: 0,
    notified: 0,
    positionsClosed: 0,
    errors: 0,
  };

  // Only wallets that hold or recently held risk. A wallet that has never had a
  // position cannot have been liquidated.
  const { data, error } = await db
    .from("tracked_wallets")
    .select("wallet_address, user_id, fills_checked_at")
    .or("has_open_positions.eq.true,fills_checked_at.not.is.null")
    .lt("consecutive_errors", 10)
    .order("fills_checked_at", { ascending: true, nullsFirst: true })
    .limit(budget);
  if (error) throw new Error(`claiming wallets failed: ${error.message}`);

  for (const w of (data as Candidate[]) ?? []) {
    try {
      const since = w.fills_checked_at
        ? Date.parse(w.fills_checked_at) - OVERLAP_MS
        : Date.now() - FIRST_SCAN_MS;

      const fills = await fetchUserFills(w.wallet_address, since);
      // Unsettled partials are left for the next scan, which re-reads them
      // through the overlap.
      const events = group(fills, w.wallet_address).filter((e) => isSettled(e));
      result.walletsScanned += 1;
      result.eventsFound += events.length;

      for (const e of events) {
        const inserted = await recordAndNotify(w.user_id, w.wallet_address, e);
        if (inserted) result.notified += 1;
        // Run on every scan of the event, not only the first: closing is
        // idempotent, and a failure here then retries on the overlap re-scan
        // instead of being hidden behind the already-recorded event row.
        result.positionsClosed += await closeLiquidatedPositions(w.user_id, e);
        // The take was about the position before this. A partial liquidation
        // changed it; a full one ended it. Takes posted after are left alone.
        await removeLiveTake(w.user_id, e.coin, e.remaining > 0 ? "changed" : "liquidated", e.liquidatedAt);
      }

      await db
        .from("tracked_wallets")
        .update({ fills_checked_at: new Date().toISOString() })
        .eq("wallet_address", w.wallet_address);
    } catch (err) {
      result.errors += 1;
      logger.warn({ err, wallet: w.wallet_address }, "liquidation scan failed");
    }
  }
  return result;
}

/** Past tense only, and "partly" when the user still holds the rest. */
export function liquidationMessage(e: Grouped): { title: string; body: string } {
  const partial = e.remaining > 0;
  const loss = Math.abs(e.realizedPnl);
  return {
    title: `${e.coin} ${e.side} ${partial ? "partly liquidated" : "liquidated"}`,
    body:
      (partial ? `Part of your ${e.coin} ${e.side} was liquidated` : `Your ${e.coin} ${e.side} was liquidated`) +
      (e.markPx ? ` at $${e.markPx.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "") +
      (loss > 0 ? `. Realized loss $${loss.toFixed(2)}.` : "."),
  };
}

/** Returns true when this was a new event (and so a notification was sent). */
async function recordAndNotify(
  userId: string,
  wallet: string,
  e: Grouped,
): Promise<boolean> {
  const db = supabaseAdmin();

  // Insert first. A conflict means we have already handled this event, so the
  // notification is skipped — the row, not a flag, is what prevents a repeat.
  const { data, error } = await db
    .from("liquidation_events")
    .upsert(
      {
        wallet_address: wallet,
        coin: e.coin,
        liquidated_at: e.liquidatedAt.toISOString(),
        user_id: userId,
        side: e.side,
        size: e.size,
        mark_px: e.markPx,
        realized_pnl: e.realizedPnl,
        fill_count: e.fillCount,
        method: e.method,
      },
      { onConflict: "wallet_address,coin,liquidated_at", ignoreDuplicates: true },
    )
    .select("coin");
  if (error) throw new Error(`recording liquidation failed: ${error.message}`);
  if (((data as unknown[]) ?? []).length === 0) return false;

  const outcome = await notify({
    userId,
    kind: "position_liquidated",
    ...liquidationMessage(e),
    route: `asset:${e.coin}`,
  });

  await db
    .from("liquidation_events")
    .update({ notified_at: new Date().toISOString() })
    .eq("wallet_address", wallet)
    .eq("coin", e.coin)
    .eq("liquidated_at", e.liquidatedAt.toISOString());

  logger.info(
    { coin: e.coin, side: e.side, realizedPnl: e.realizedPnl, delivered: outcome.delivered },
    "liquidation detected and notified",
  );
  return true;
}

// ── Closing the position rows ────────────────────────────────────────────────

/** The open-row fields the close needs. */
export interface OpenRow {
  id: string;
  size: number;
}

export interface ClosePatch {
  id: string;
  closed_at: string;
  exit_px: number | null;
  realized_pnl: number;
  close_fee_paid: number;
}

/**
 * The updates that close `rows` for a full liquidation.
 *
 * Usually one row. More than one happens when adding to a position left an
 * extra open row; all of them were the one HL position, so all close, and the
 * loss and fees are split by size so the feed doesn't count them twice.
 *
 * There is no `close_cloid` (HL placed these orders, not the app). The user's
 * take on the position is removed separately (see removeLiveTake).
 */
export function planLiquidationCloses(rows: OpenRow[], e: Grouped): ClosePatch[] {
  const total = rows.reduce((sum, r) => sum + (Number(r.size) || 0), 0);
  return rows.map((r) => {
    const share = total > 0 ? (Number(r.size) || 0) / total : 1 / rows.length;
    return {
      id: r.id,
      closed_at: e.liquidatedAt.toISOString(),
      // Mark, not the fill px: HL liquidates against mark, and the fills of one
      // event land at several prices.
      exit_px: e.markPx,
      realized_pnl: e.realizedPnl * share,
      close_fee_paid: e.fee * share,
    };
  });
}

/**
 * Close the user's open rows for a liquidated position. Returns how many closed.
 *
 * Only a FULL liquidation closes anything: after a partial one the user still
 * holds the rest, and the row stays open. Only rows opened before the
 * liquidation match, so a position reopened since — same coin, same side — is
 * left alone, which is also what makes a re-scan a no-op.
 */
export async function closeLiquidatedPositions(userId: string, e: Grouped): Promise<number> {
  if (e.remaining > 0) return 0;
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("positions")
    .select("id, size")
    .eq("user_id", userId)
    .eq("coin", e.coin)
    .eq("side", e.side)
    .is("closed_at", null)
    .lte("opened_at", e.liquidatedAt.toISOString());
  if (error) throw new Error(`liquidated position lookup failed: ${error.message}`);

  let closed = 0;
  for (const { id, ...patch } of planLiquidationCloses((data as OpenRow[]) ?? [], e)) {
    const { data: updated, error: updateError } = await db
      .from("positions")
      .update(patch)
      .eq("id", id)
      // Re-checked in WHERE so a concurrent close (the app's, or another scan)
      // isn't overwritten.
      .is("closed_at", null)
      .select("id");
    if (updateError) throw new Error(`closing liquidated position failed: ${updateError.message}`);
    closed += ((updated as unknown[]) ?? []).length;
  }

  if (closed > 0) {
    logger.info({ coin: e.coin, side: e.side, closed }, "closed liquidated position rows");
  }
  return closed;
}
