import { supabaseAdmin } from "./supabase.js";
import { notifyMany, type NotifyInput } from "./notify.js";
import { fetchMarketQuotes, type MarketQuote } from "./hyperliquid.js";
import { config } from "../config/env.js";

/**
 * Big-move pushes: "NVDA up 11.2% today", to everyone watching the market.
 *
 * Measured against HL's `prevDayPx`, the mark 24 hours ago (rolling), which is
 * the reference behind HL's own 24h change. Rises and drops both count.
 *
 * Per user, per market, per UTC day, per direction: one push at 10%, and one
 * more if the move reaches 20%. A market that gaps straight to 20% gets the
 * 20% push only; both thresholds are recorded so it isn't followed by the 10%.
 * "Day" is the UTC date the push was sent — the move itself is rolling — so a
 * move that lasts past midnight UTC can be announced again the next day.
 *
 * Recipients are watchlist users only, by product decision: holders already get
 * PnL milestones on their position (see pnlMilestones.ts).
 *
 * Idempotency is the `price_move_alerts` primary key: rows are inserted first
 * and only newly inserted ones are announced.
 */

const THRESHOLDS = [10, 20];
/** Rows per insert, to keep a busy day's request bodies modest. */
const CHUNK = 500;

export interface Move {
  coin: string;
  /** Signed fraction: +0.112 is up 11.2%. */
  change: number;
}

/** Thresholds a 24h change has reached, smallest first. */
export function crossedThresholds(change: number): number[] {
  return THRESHOLDS.filter((t) => Math.abs(change) * 100 >= t);
}

/** Markets past the first threshold. Delisted ones keep a frozen mark and are skipped. */
export function bigMoves(quotes: Map<string, MarketQuote>): Move[] {
  const out: Move[] = [];
  for (const q of quotes.values()) {
    if (q.isDelisted || q.prevDayPx === null || q.prevDayPx <= 0) continue;
    const change = q.markPx / q.prevDayPx - 1;
    if (crossedThresholds(change).length > 0) out.push({ coin: q.coin, change });
  }
  return out;
}

export function priceMoveMessage(coin: string, change: number): { title: string; body: string } {
  const dir = change >= 0 ? "up" : "down";
  const pct = (Math.abs(change) * 100).toFixed(1);
  return {
    title: `${coin} ${dir} ${pct}% today`,
    body: `${coin} is ${dir} ${pct}% in the last 24 hours.`,
  };
}

export interface PriceMoveResult {
  moves: number;
  notified: number;
}

interface AlertRow {
  user_id: string;
  coin: string;
  direction: string;
  threshold: number;
}

export async function detectPriceMoves(): Promise<PriceMoveResult> {
  const db = supabaseAdmin();
  const moves = bigMoves(await fetchMarketQuotes(config.hyperliquid.dex));
  const result: PriceMoveResult = { moves: moves.length, notified: 0 };
  if (moves.length === 0) return result;

  const day = new Date().toISOString().slice(0, 10);
  const coins = moves.map((m) => m.coin);
  const [watchers, sent] = await Promise.all([
    db.from("watchlist").select("user_id, ticker").in("ticker", coins),
    db
      .from("price_move_alerts")
      .select("user_id, coin, direction, threshold")
      .eq("day", day)
      .in("coin", coins),
  ]);
  if (watchers.error) throw new Error(`reading watchers failed: ${watchers.error.message}`);
  if (sent.error) throw new Error(`reading sent moves failed: ${sent.error.message}`);

  const watching = new Map<string, string[]>();
  for (const w of (watchers.data as Array<{ user_id: string; ticker: string }>) ?? []) {
    watching.set(w.ticker, [...(watching.get(w.ticker) ?? []), w.user_id]);
  }
  const key = (userId: string, coin: string, direction: string, threshold: number) =>
    `${userId}|${coin}|${direction}|${threshold}`;
  const already = new Set(
    ((sent.data as AlertRow[]) ?? []).map((a) => key(a.user_id, a.coin, a.direction, a.threshold)),
  );

  const rows: Array<AlertRow & { day: string; change_pct: number }> = [];
  for (const m of moves) {
    const direction = m.change >= 0 ? "up" : "down";
    for (const userId of watching.get(m.coin) ?? []) {
      for (const threshold of crossedThresholds(m.change)) {
        if (already.has(key(userId, m.coin, direction, threshold))) continue;
        rows.push({
          user_id: userId,
          coin: m.coin,
          day,
          direction,
          threshold,
          change_pct: Number((m.change * 100).toFixed(2)),
        });
      }
    }
  }
  if (rows.length === 0) return result;

  // The insert is the lock: only rows that didn't already exist come back.
  const won: AlertRow[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { data, error } = await db
      .from("price_move_alerts")
      .upsert(rows.slice(i, i + CHUNK), {
        onConflict: "user_id,coin,day,direction,threshold",
        ignoreDuplicates: true,
      })
      .select("user_id, coin, direction, threshold");
    if (error) throw new Error(`recording price moves failed: ${error.message}`);
    won.push(...((data as AlertRow[]) ?? []));
  }

  // One push per user per market, for the furthest threshold just reached.
  const changeOf = new Map(moves.map((m) => [m.coin, m.change]));
  const announced = new Set<string>();
  const inputs: NotifyInput[] = [];
  for (const a of [...won].sort((x, y) => y.threshold - x.threshold)) {
    const once = `${a.user_id}|${a.coin}`;
    if (announced.has(once)) continue;
    announced.add(once);
    inputs.push({
      userId: a.user_id,
      kind: "price_move",
      ...priceMoveMessage(a.coin, changeOf.get(a.coin)!),
      route: `asset:${a.coin}`,
      collapseId: `move:${a.coin}`,
    });
  }

  result.notified = (await notifyMany(inputs)).delivered;
  return result;
}
