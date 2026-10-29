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
  /** Size held when the liquidation began: the first step's start position. */
  startSize: number;
  /** Each step joined into this event (see joinSteps), oldest first. */
  steps: Array<{ size: number; markPx: number | null }>;
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
      existing.startSize = Math.max(existing.startSize, Math.abs(Number(f.startPosition) || 0));
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
      startSize: Math.abs(Number(f.startPosition) || 0),
      steps: [],
    });
  }
  for (const e of byEvent.values()) e.steps = [{ size: e.size, markPx: e.markPx }];
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
      prev.startSize = Math.max(prev.startSize, e.startSize);
      prev.steps.push(...e.steps);
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

/** Size as HL quotes it, without float noise: 0.36, 1.1, 0.74. */
const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });
const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Past tense only. A full liquidation ended the position; a partial took some
 * of it and the user still holds the rest, so it says how much of each.
 *
 * `numbersOk: false` (see checkLiquidation) drops the loss figure rather than
 * send one that doesn't add up: the event itself is certain, the sum is not.
 */
export function liquidationMessage(
  e: Grouped,
  numbersOk = true,
): { title: string; body: string } {
  const at = e.markPx ? ` at ${usd(e.markPx)}` : "";
  const loss = Math.abs(e.realizedPnl);
  const lossLine = numbersOk && loss > 0 ? ` Realized loss ${usd(loss)}.` : "";

  if (e.remaining > 0) {
    return {
      title: `${e.coin} ${e.side} partly liquidated`,
      body:
        `${qty(e.size)} of your ${qty(e.startSize)} ${e.coin} ${e.side} was liquidated${at}.` +
        lossLine +
        ` The other ${qty(e.remaining)} is still open.`,
    };
  }
  // Taken in steps: a partial first, then the rest. Say so, with each step's
  // size and mark, so the loss isn't read as one fill at one price.
  if (e.steps.length === 2) {
    const [first, last] = e.steps as [Grouped["steps"][0], Grouped["steps"][0]];
    const stepAt = (s: Grouped["steps"][0]) => (s.markPx ? ` at ${usd(s.markPx)}` : "");
    return {
      title: `${e.coin} ${e.side} liquidated`,
      body:
        `Your ${e.coin} ${e.side} was liquidated in two steps: ` +
        `${qty(first.size)}${stepAt(first)}, then the other ${qty(last.size)}${stepAt(last)}.` +
        lossLine,
    };
  }
  if (e.steps.length > 2) {
    return {
      title: `${e.coin} ${e.side} liquidated`,
      body: `Your ${e.coin} ${e.side} was liquidated in ${e.steps.length} steps, the last${at}.` + lossLine,
    };
  }
  return {
    title: `${e.coin} ${e.side} liquidated`,
    body: `Your ${e.coin} ${e.side} was liquidated${at}.` + lossLine,
  };
}

/**
 * Sanity checks on an event's numbers before they are sent to the user. Each
 * returned string is a check that failed; empty means the numbers agree.
 *
 * - The sizes add up: what was taken plus what is left is what was held.
 * - A liquidation is a loss, never a gain.
 * - An isolated position cannot lose more than the margin behind it (`margin`,
 *   from the position rows, when known). A little slack covers fees and the
 *   rounding of HL's margin figure.
 */
export function checkLiquidation(e: Grouped, margin: number | null): string[] {
  const problems: string[] = [];
  const tol = Math.max(1e-9, e.startSize * 1e-6);
  if (Math.abs(e.size + e.remaining - e.startSize) > tol) {
    problems.push(`size ${e.size} + remaining ${e.remaining} != held ${e.startSize}`);
  }
  if (e.realizedPnl > 0) problems.push(`realized pnl is a gain: ${e.realizedPnl}`);
  if (margin !== null && margin > 0) {
    const loss = Math.abs(e.realizedPnl);
    if (loss > margin * 1.02 + 0.01) problems.push(`loss ${loss} exceeds margin ${margin}`);
  }
  return problems;
}

/** Margin on the user's open rows for this position, or null when unknown. */
async function marginBehind(userId: string, e: Grouped): Promise<number | null> {
  const { data, error } = await supabaseAdmin()
    .from("positions")
    .select("margin_used")
    .eq("user_id", userId)
    .eq("coin", e.coin)
    .eq("side", e.side)
    .is("closed_at", null)
    .lte("opened_at", e.liquidatedAt.toISOString());
  // The check is a guard, not a gate: a failed lookup skips it.
  if (error) return null;
  const rows = (data as Array<{ margin_used: number | null }>) ?? [];
  const total = rows.reduce((sum, r) => sum + (Number(r.margin_used) || 0), 0);
  return total > 0 ? total : null;
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

  const problems = checkLiquidation(e, await marginBehind(userId, e));
  if (problems.length > 0) {
    logger.error(
      { coin: e.coin, side: e.side, wallet, problems },
      "liquidation numbers failed sanity check; sending without the loss",
    );
  }
  const outcome = await notify({
    userId,
    kind: "position_liquidated",
    ...liquidationMessage(e, problems.length === 0),
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
  opened_at?: string;
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
export function planLiquidationCloses(
  rows: OpenRow[],
  e: Grouped,
  /** Loss already taken by earlier partial liquidations of the same position. */
  earlierPnl = 0,
): ClosePatch[] {
  const total = rows.reduce((sum, r) => sum + (Number(r.size) || 0), 0);
  return rows.map((r) => {
    const share = total > 0 ? (Number(r.size) || 0) / total : 1 / rows.length;
    return {
      id: r.id,
      closed_at: e.liquidatedAt.toISOString(),
      // Mark, not the fill px: HL liquidates against mark, and the fills of one
      // event land at several prices.
      exit_px: e.markPx,
      realized_pnl: (e.realizedPnl + earlierPnl) * share,
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
    .select("id, size, opened_at")
    .eq("user_id", userId)
    .eq("coin", e.coin)
    .eq("side", e.side)
    .is("closed_at", null)
    .lte("opened_at", e.liquidatedAt.toISOString());
  if (error) throw new Error(`liquidated position lookup failed: ${error.message}`);
  const rows = (data as OpenRow[]) ?? [];
  if (rows.length === 0) return 0;

  let closed = 0;
  const earlier = await earlierPartialPnl(userId, e, rows);
  for (const { id, ...patch } of planLiquidationCloses(rows, e, earlier)) {
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

/**
 * Loss from partial liquidations of this position that were announced on their
 * own, before the step that ended it (too far apart to join, see STEP_GAP_MS).
 * The closed row carries the position's whole liquidation loss, not just the
 * last step's.
 */
async function earlierPartialPnl(userId: string, e: Grouped, rows: OpenRow[]): Promise<number> {
  const opened = rows
    .map((r) => Date.parse(r.opened_at ?? ""))
    .filter((t) => Number.isFinite(t));
  if (opened.length === 0) return 0;
  const { data, error } = await supabaseAdmin()
    .from("liquidation_events")
    .select("realized_pnl")
    .eq("user_id", userId)
    .eq("coin", e.coin)
    .eq("side", e.side)
    .gte("liquidated_at", new Date(Math.min(...opened)).toISOString())
    .lt("liquidated_at", e.liquidatedAt.toISOString());
  if (error) throw new Error(`earlier partial lookup failed: ${error.message}`);
  return ((data as Array<{ realized_pnl: number }>) ?? []).reduce(
    (sum, r) => sum + (Number(r.realized_pnl) || 0),
    0,
  );
}
