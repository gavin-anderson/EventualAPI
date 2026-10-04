import { supabaseAdmin } from "./supabase.js";

/**
 * Per-user starred tickers. Both writes are idempotent — the client toggles
 * optimistically and shouldn't reconcile a 409 for a tap.
 */

/** Digits allowed: XYZ100, SP500, JP225, KR200 and H100 are real markets. */
const TICKER = /^[A-Z0-9]{1,15}$/;

/** Uppercased and shape-checked, or null if it can't be a ticker. */
export function normalizeTicker(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  return TICKER.test(t) ? t : null;
}

/** The user's starred tickers, newest first. */
export async function listWatchlist(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin()
    .from("watchlist")
    .select("ticker")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`watchlist read failed: ${error.message}`);
  return ((data as Array<{ ticker: string }>) ?? []).map((r) => r.ticker);
}

/** Star a ticker. Returns false when it was already starred. */
export async function addToWatchlist(userId: string, ticker: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("watchlist")
    // ignoreDuplicates: a repeat star is a no-op, and the returned rows say so.
    .upsert({ user_id: userId, ticker }, { onConflict: "user_id,ticker", ignoreDuplicates: true })
    .select("ticker");
  if (error) throw new Error(`watchlist add failed: ${error.message}`);
  return ((data as unknown[]) ?? []).length > 0;
}

/** Un-star a ticker. Returns false when it wasn't starred. */
export async function removeFromWatchlist(userId: string, ticker: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("watchlist")
    .delete()
    .eq("user_id", userId)
    .eq("ticker", ticker)
    .select("ticker");
  if (error) throw new Error(`watchlist remove failed: ${error.message}`);
  return ((data as unknown[]) ?? []).length > 0;
}

/**
 * How many users star each ticker; absent keys mean zero. An aggregate the
 * server may expose — watchlists themselves are private.
 */
export async function watchCounts(tickers: string[]): Promise<Record<string, number>> {
  if (tickers.length === 0) return {};
  const { data, error } = await supabaseAdmin()
    .from("watchlist")
    .select("ticker")
    .in("ticker", tickers);
  if (error) throw new Error(`watch counts failed: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of (data as Array<{ ticker: string }>) ?? []) {
    counts[row.ticker] = (counts[row.ticker] ?? 0) + 1;
  }
  return counts;
}
