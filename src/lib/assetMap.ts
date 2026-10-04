import { supabaseAdmin } from "./supabase.js";
import { config } from "../config/env.js";

/**
 * ticker → hl_coin resolution for the price WebSocket. The app subscribes by
 * ticker (its display key); Hyperliquid keys markets on the bare coin. For the
 * equity dex these are usually identical, but where `assets` records a different
 * `hl_coin` we honour it. Cached with a short TTL so a screen full of subscribes
 * doesn't hammer Supabase.
 *
 * Unknown tickers fall back to identity (coin == ticker, dex == HL_DEX), which
 * keeps pricing working even when the `assets` catalogue is sparse.
 */

export interface AssetInfo {
  coin: string;
  dex: string | null;
}

const TTL_MS = 5 * 60_000;

let cache: Map<string, AssetInfo> | null = null;
let expiresAt = 0;

async function load(): Promise<Map<string, AssetInfo>> {
  const map = new Map<string, AssetInfo>();
  if (!config.supabase.configured) return map;

  const db = supabaseAdmin();
  const { data, error } = await db.from("assets").select("ticker, hl_coin, dex");
  if (error) throw new Error(`assetMap load failed: ${error.message}`);

  for (const row of (data as Array<{
    ticker: string;
    hl_coin: string;
    dex: string | null;
  }> | null) ?? []) {
    if (!row.ticker || !row.hl_coin) continue;
    map.set(row.ticker.toUpperCase(), { coin: row.hl_coin, dex: row.dex });
  }
  return map;
}

async function getMap(): Promise<Map<string, AssetInfo>> {
  const now = Date.now();
  if (cache && now < expiresAt) return cache;
  cache = await load();
  expiresAt = now + TTL_MS;
  return cache;
}

/**
 * Resolve each requested ticker to its {coin, dex}. Every ticker resolves — a
 * miss falls back to identity (coin == ticker, dex == configured HL_DEX or null).
 */
export async function resolveTickers(
  tickers: string[],
): Promise<Map<string, AssetInfo>> {
  const map = await getMap();
  const fallbackDex = config.hyperliquid.dex || null;
  const out = new Map<string, AssetInfo>();
  for (const t of tickers) {
    const key = t.toUpperCase();
    out.set(key, map.get(key) ?? { coin: key, dex: fallbackDex });
  }
  return out;
}
