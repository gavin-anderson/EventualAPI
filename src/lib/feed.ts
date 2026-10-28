import { supabaseAdmin } from "./supabase.js";

/**
 * The position feed: takes, biggest position first.
 *
 * Reads `feed_items`, a view over `takes`: one entry per LIVE take on an open
 * position. A take is removed when its position closes or changes (see
 * src/lib/takes.ts), and removed or hidden takes never appear. `kind` is
 * always "open" now; it stays in the shape for clients that read it.
 */

const COLUMNS =
  "id, position_id, kind, user_id, username, image_ref, coin, side, size, " +
  "notional, leverage, price, take, traded_at, posted_at, realized_pnl, is_closed, edited_at";

export interface FeedItemRow {
  id: string;
  position_id: string | null;
  kind: "open" | "close";
  user_id: string;
  username: string | null;
  image_ref: string | null;
  coin: string;
  side: "long" | "short";
  size: number;
  notional: number;
  leverage: number | null;
  price: number;
  take: string;
  traded_at: string;
  posted_at: string | null;
  realized_pnl: number | null;
  is_closed: boolean;
  edited_at: string | null;
}

export interface FeedQuery {
  /** Restrict to one ticker's room. */
  coin?: string;
  /** Restrict to one author — a user's own take history. */
  userId?: string;
  limit: number;
  offset: number;
}

export interface FeedPage {
  items: FeedItemRow[];
  total: number | null;
}

/**
 * A page of the feed.
 *
 * Offset pagination rather than a keyset cursor. Volume here is bounded by real
 * trades — a room can't reach 2,000 posts unless 2,000 positions were opened in
 * that ticker — so offsets never go deep enough for the usual drift to matter.
 * If a room ever does get big, the upgrade is a keyset on (notional, posted_at,
 * id).
 */
export async function readFeed(q: FeedQuery): Promise<FeedPage> {
  let query = supabaseAdmin()
    .from("feed_items")
    .select(COLUMNS, { count: "exact" })
    // Biggest position first: notional is the take's snapshot, size x entry
    // when it was posted, so the order doesn't shift with the price. Newest
    // take then id break ties, so a page boundary is stable.
    .order("notional", { ascending: false })
    .order("posted_at", { ascending: false })
    .order("id", { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);

  if (q.coin) query = query.eq("coin", q.coin);
  if (q.userId) query = query.eq("user_id", q.userId);

  const { data, error, count } = await query;
  if (error) throw new Error(`feed read failed: ${error.message}`);
  // feed_items is a view, so supabase-js has no generated type for it and
  // widens the row to its error shape. Cast via unknown.
  return { items: (data as unknown as FeedItemRow[]) ?? [], total: count ?? null };
}

/**
 * Long/short split across every position opened through the app on this coin,
 * open or closed, whether or not anyone posted a take on it. Two head counts,
 * so no rows come back.
 */
export async function positionSentiment(
  coin: string,
): Promise<{ long: number; short: number }> {
  const count = async (side: "long" | "short") => {
    const { count, error } = await supabaseAdmin()
      .from("positions")
      .select("id", { count: "exact", head: true })
      .eq("coin", coin)
      .eq("side", side);
    if (error) throw new Error(`sentiment read failed: ${error.message}`);
    return count ?? 0;
  };
  const [long, short] = await Promise.all([count("long"), count("short")]);
  return { long, short };
}
