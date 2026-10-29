import { supabaseAdmin } from "./supabase.js";
import { notify } from "./notify.js";
import { logger } from "./logger.js";
import type { MarketQuote } from "./hyperliquid.js";

/**
 * Position PnL milestones: "your NVDA long is up 50%", measured on MARGIN.
 *
 * Up 25%, 50%, 100%, 200%, then every further doubling (400%, 800%, ...); down
 * 25% and 50%. Each milestone fires once per position, and only the highest
 * newly crossed one is sent — a position that gaps from 20% to 110% between
 * runs hears "up 100%", not three pushes, and the skipped ones are recorded so
 * a pullback to 60% doesn't then announce 50%.
 *
 * A POSITION is (wallet, coin, side, opened_at). `opened_at` is set when the
 * mirror row is first inserted and survives refreshes, and the row is deleted
 * when the position closes, so a close-and-reopen is a new position with fresh
 * milestones. Side is in the key because a flip from long to short can happen
 * between refreshes without the row ever being deleted.
 *
 * Idempotency is the `position_pnl_alerts` primary key, as with
 * `liquidation_events`: the rows are inserted first and only a newly inserted
 * one is announced.
 */

const UP_FIRST = [25, 50, 100];
const DOWN = [-25, -50];

/**
 * Return on margin, as a fraction: +0.5 means the position is up 50% of the
 * margin behind it.
 *
 * Computed from the live mark rather than `unrealized_pnl / margin_used` on the
 * mirror row. Those two are only as fresh as the last refresh (up to 2 minutes,
 * longer under backoff), while the mark here is seconds old — and a milestone
 * crossed in a fast move is exactly the moment worth being on time for. At
 * entry the two agree: HL's margin is notional / leverage. They drift apart
 * only by funding, which this ignores, and for cross margin, where
 * `margin_used` is not a fixed stake and the ratio would wander anyway.
 */
export function returnOnMargin(
  side: "long" | "short",
  entryPx: number,
  markPx: number,
  leverage: number,
): number {
  const move = (markPx - entryPx) / entryPx;
  return (side === "long" ? move : -move) * leverage;
}

/** Every milestone at or past `roe`, as signed percents, smallest first. */
export function crossedMilestones(roe: number): number[] {
  const pct = roe * 100;
  if (pct >= UP_FIRST[0]!) {
    const out: number[] = [];
    for (const m of UP_FIRST) if (pct >= m) out.push(m);
    // 200%, 400%, 800%... with no ceiling.
    for (let m = 200; pct >= m; m *= 2) out.push(m);
    return out;
  }
  return DOWN.filter((m) => pct <= m);
}

export function milestoneMessage(
  coin: string,
  side: "long" | "short",
  milestone: number,
  roe: number,
): { title: string; body: string } {
  const dir = milestone > 0 ? "up" : "down";
  // Rounded actual, never below the milestone: crossing +50 means |roe| >= 0.5.
  // Title and body both carry it: a fast move can be well past the milestone by
  // the time it is seen, and "down 50%" over "down 60%" reads as a mistake.
  const actual = Math.max(Math.abs(milestone), Math.round(Math.abs(roe) * 100));
  return {
    title: `${coin} ${side} ${dir} ${actual}%`,
    body: `Your ${coin} ${side} is ${dir} ${actual}% on margin.`,
  };
}

export interface PnlResult {
  positions: number;
  crossing: number;
  notified: number;
  skippedNoMark: number;
}

interface PositionRow {
  wallet_address: string;
  coin: string;
  side: "long" | "short";
  entry_px: number;
  leverage: number | null;
  opened_at: string;
}

interface AlertRow {
  wallet_address: string;
  coin: string;
  side: string;
  opened_at: string;
  milestone: number;
}

/** Timestamps compared as instants: the same value can come back formatted differently. */
const positionKey = (r: { wallet_address: string; coin: string; side: string; opened_at: string }) =>
  `${r.wallet_address}|${r.coin}|${r.side}|${Date.parse(r.opened_at)}`;

/**
 * Check every mirrored position against the milestones and announce new ones.
 * Takes the quotes the risk evaluation already fetched, so the step costs no
 * extra Hyperliquid call.
 */
export async function notifyPnlMilestones(quotes: Map<string, MarketQuote>): Promise<PnlResult> {
  const db = supabaseAdmin();
  const result: PnlResult = { positions: 0, crossing: 0, notified: 0, skippedNoMark: 0 };

  const { data, error } = await db
    .from("wallet_open_positions")
    .select("wallet_address, coin, side, entry_px, leverage, opened_at");
  if (error) throw new Error(`reading mirror failed: ${error.message}`);
  const rows = (data as PositionRow[]) ?? [];
  result.positions = rows.length;

  const crossing: Array<{ row: PositionRow; roe: number; crossed: number[] }> = [];
  for (const row of rows) {
    const quote = quotes.get(row.coin);
    // A delisted market's mark is frozen, so nothing about it is news.
    if (!quote || quote.isDelisted) {
      result.skippedNoMark += 1;
      continue;
    }
    const entry = Number(row.entry_px);
    const leverage = Number(row.leverage);
    if (!(entry > 0) || !(leverage > 0)) continue;

    const roe = returnOnMargin(row.side, entry, quote.markPx, leverage);
    const crossed = crossedMilestones(roe);
    if (crossed.length > 0) crossing.push({ row, roe, crossed });
  }
  result.crossing = crossing.length;
  if (crossing.length === 0) return result;

  const wallets = [...new Set(crossing.map((c) => c.row.wallet_address))];
  const [owners, sent] = await Promise.all([
    db.from("tracked_wallets").select("wallet_address, user_id").in("wallet_address", wallets),
    db
      .from("position_pnl_alerts")
      .select("wallet_address, coin, side, opened_at, milestone")
      .in("wallet_address", wallets),
  ]);
  if (owners.error) throw new Error(`reading wallet owners failed: ${owners.error.message}`);
  if (sent.error) throw new Error(`reading sent milestones failed: ${sent.error.message}`);

  const userOf = new Map(
    ((owners.data as Array<{ wallet_address: string; user_id: string }>) ?? []).map((o) => [
      o.wallet_address,
      o.user_id,
    ]),
  );
  const already = new Set(
    ((sent.data as AlertRow[]) ?? []).map((a) => `${positionKey(a)}|${a.milestone}`),
  );

  for (const { row, roe, crossed } of crossing) {
    const userId = userOf.get(row.wallet_address);
    if (!userId) continue;
    const key = positionKey(row);
    const fresh = crossed.filter((m) => !already.has(`${key}|${m}`));
    if (fresh.length === 0) continue;

    // Record every newly crossed milestone, announce only the furthest. The
    // insert is the lock: rows that already existed come back empty.
    const { data: inserted, error: insertError } = await db
      .from("position_pnl_alerts")
      .upsert(
        fresh.map((milestone) => ({
          wallet_address: row.wallet_address,
          coin: row.coin,
          side: row.side,
          opened_at: row.opened_at,
          milestone,
          user_id: userId,
          roe: Number(roe.toFixed(4)),
        })),
        { onConflict: "wallet_address,coin,side,opened_at,milestone", ignoreDuplicates: true },
      )
      .select("milestone");
    if (insertError) {
      logger.error({ err: insertError, coin: row.coin }, "could not record pnl milestone");
      continue;
    }
    const won = ((inserted as Array<{ milestone: number }>) ?? []).map((r) => r.milestone);
    if (won.length === 0) continue;

    const milestone = won.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
    await notify({
      userId,
      kind: "position_pnl",
      ...milestoneMessage(row.coin, row.side, milestone, roe),
      route: `asset:${row.coin}`,
      // A quick 25 -> 50 replaces the undelivered 25 rather than stacking.
      collapseId: `pnl:${row.wallet_address}:${row.coin}`,
    });
    result.notified += 1;
  }
  return result;
}
