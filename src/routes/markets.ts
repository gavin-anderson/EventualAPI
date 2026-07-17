import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { badRequest } from "../lib/httpError.js";
import { query } from "../lib/clickhouse.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { config } from "../config/env.js";
import { TtlCache } from "../lib/cache.js";

export const marketsRouter = Router();

/**
 * GET /v1/markets — ANONYMOUS. The browse/markets list.
 *
 * Merges the two "list" halves the app actually needs together:
 *   - live market data from ClickHouse asset_ctx (mark price, volume, 24h change)
 *   - asset metadata from Supabase (ticker, name, logo)
 *
 * DRIVEN BY ALL LIVE COINS: the row set comes from ClickHouse, so every live
 * market shows up; the Supabase `assets` join is a LEFT join — name/logo appear
 * where the asset has been catalogued, and are null otherwise (ticker falls back
 * to the coin). This also means the endpoint works before `assets` is seeded (or
 * even before Supabase is configured) — you just get bare coins + prices.
 *
 * 24h change is computed in the same query: argMin(mark_px) over the last day is
 * the ~24h-ago price, so no extra scan.
 */

interface LiveRow {
  dex: string;
  coin: string;
  mark_now: number;
  oracle_px: number;
  open_interest: number;
  day_volume: number;
  mark_1d_ago: number;
  as_of: string;
}

interface AssetMeta {
  ticker: string;
  name: string | null;
  image_ref: string | null;
  kind: string;
}

const browseCache = new TtlCache<object>();
const BROWSE_TTL = 5_000;

const schema = z.object({
  dex: z.string().trim().min(1).max(64).optional(),
  kind: z.string().trim().min(1).max(16).optional(), // equity | etf | index | commodity | fx | crypto | other
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

marketsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { limit, kind } = parsed.data;
    const dex = parsed.data.dex ?? (config.clickhouse.dex || undefined);

    const result = await browseCache.getOrSet(
      `browse:${dex ?? "all"}:${kind ?? "all"}:${limit}`,
      BROWSE_TTL,
      async () => {
        // 1. Live market data — the driving row set (all live coins). No SQL
        //    LIMIT: the kind filter lives in Supabase metadata, so we fetch the
        //    full (small) universe and apply kind + limit after the merge.
        const conditions: string[] = ["ts > now() - INTERVAL 1 DAY"];
        const params: Record<string, unknown> = {};
        if (dex) {
          conditions.push("dex = {dex:String}");
          params.dex = dex;
        }
        const live = await query<LiveRow>(
          "markets_browse",
          `SELECT
             dex,
             coin,
             argMax(mark_px, ts)       AS mark_now,
             argMax(oracle_px, ts)     AS oracle_px,
             argMax(open_interest, ts) AS open_interest,
             argMax(day_volume, ts)    AS day_volume,
             argMin(mark_px, ts)       AS mark_1d_ago,
             max(ts)                   AS as_of
           FROM ${config.clickhouse.database}.asset_ctx
           WHERE ${conditions.join(" AND ")}
           GROUP BY dex, coin
           ORDER BY day_volume DESC`,
          params,
        );

        // 2. Asset metadata (optional — empty map if Supabase unconfigured).
        const metaByCoin = await fetchAssetMeta();

        // 3. Merge (LEFT join on coin == hl_coin).
        let markets = live.map((r) => {
          const meta = metaByCoin.get(r.coin) ?? null;
          const change24hPct =
            r.mark_1d_ago > 0
              ? Number(
                  (((r.mark_now - r.mark_1d_ago) / r.mark_1d_ago) * 100).toFixed(4),
                )
              : null;
          return {
            dex: r.dex,
            coin: r.coin,
            ticker: meta?.ticker ?? r.coin,
            name: meta?.name ?? null,
            imageRef: meta?.image_ref ?? null,
            kind: meta?.kind ?? null,
            markPx: r.mark_now,
            oraclePx: r.oracle_px,
            openInterest: r.open_interest,
            dayVolume: r.day_volume,
            change24hPct,
            asOf: r.as_of,
          };
        });

        // 4. Optional kind filter (e.g. ?kind=equity), then cap to limit.
        if (kind) markets = markets.filter((m) => m.kind === kind);
        markets = markets.slice(0, limit);

        return { count: markets.length, asOf: live[0]?.as_of ?? null, markets };
      },
    );

    res.json(result);
  }),
);

/** Fetch asset metadata keyed by HL coin. Empty when Supabase isn't configured. */
async function fetchAssetMeta(): Promise<Map<string, AssetMeta>> {
  const map = new Map<string, AssetMeta>();
  if (!config.supabase.configured) return map;

  const db = supabaseAdmin();
  const { data } = await db.from("assets").select("hl_coin, ticker, name, image_ref, kind");
  for (const row of (data as Array<{
    hl_coin: string;
    ticker: string;
    name: string | null;
    image_ref: string | null;
    kind: string;
  }> | null) ?? []) {
    map.set(row.hl_coin, {
      ticker: row.ticker,
      name: row.name,
      image_ref: row.image_ref,
      kind: row.kind,
    });
  }
  return map;
}
