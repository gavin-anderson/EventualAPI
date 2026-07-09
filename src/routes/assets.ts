import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { badRequest, notFound } from "../lib/httpError.js";
import { query } from "../lib/clickhouse.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { config } from "../config/env.js";

export const assetsRouter = Router();

const VALID_TICKER = /^[A-Za-z]{1,10}$/;

const listSchema = z.object({
  dex: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /v1/assets — ANONYMOUS.
 *
 * Paginated asset catalog. Optional ?dex= filter.
 */
assetsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { dex, limit, offset } = parsed.data;

    const db = supabaseAdmin();
    let q = db
      .from("assets")
      .select("id, dex, hl_coin, ticker, name, image_ref", { count: "exact" })
      .order("ticker")
      .range(offset, offset + limit - 1);

    if (dex) q = q.eq("dex", dex);

    const { data, error, count } = await q;
    if (error) throw new Error(`assets list failed: ${error.message}`);

    res.json({ total: count, offset, limit, assets: data });
  }),
);

/**
 * GET /v1/assets/:ticker — ANONYMOUS.
 *
 * Full asset detail page payload:
 *   - Asset metadata (name, symbol, logo)
 *   - Next earnings event (date + time precision + expected EPS)
 *   - Polymarket beat odds
 *   - Past earnings history (EPS surprise + 24h price reaction)
 *   - Current mark price + timeframe price changes from ClickHouse
 */
assetsRouter.get(
  "/:ticker",
  asyncHandler(async (req, res) => {
    const ticker = req.params["ticker"]!.toUpperCase();
    if (!VALID_TICKER.test(ticker)) throw badRequest("invalid ticker");

    const db = supabaseAdmin();

    // Fetch asset + earnings data from Supabase in parallel with ClickHouse price
    const [assetResult, priceRows] = await Promise.all([
      db
        .from("assets")
        .select(
          `id, dex, hl_coin, ticker, name, image_ref,
           earnings_events (
             id, earnings_at, time_precision, session, is_confirmed, expected_eps, source
           ),
           earnings_history (
             reported_at, eps_actual, eps_estimate, eps_surprise_pct,
             price_change_24h_pct, source
           ),
           earnings_odds (
             beat_pct, market_url, source, fetched_at
           )`,
        )
        .eq("ticker", ticker)
        .order("earnings_at", { ascending: true, referencedTable: "earnings_events" })
        .order("reported_at", {
          ascending: false,
          referencedTable: "earnings_history",
        })
        .limit(1, { referencedTable: "earnings_odds" })
        .single(),

      // Current mark price from ClickHouse (non-fatal if CH unavailable)
      fetchMarkPrice(ticker).catch(() => null),
    ]);

    if (assetResult.error || !assetResult.data) {
      throw notFound(`asset not found: ${ticker}`);
    }

    const asset = assetResult.data as Record<string, unknown>;

    // Split earnings events: next upcoming vs past (in case any leaked through)
    const allEvents = (asset.earnings_events as Array<Record<string, unknown>>) ?? [];
    const now = new Date().toISOString();
    const nextEvent = allEvents.find((e) => (e.earnings_at as string) >= now) ?? null;

    res.json({
      asset: {
        id: asset.id,
        dex: asset.dex,
        hlCoin: asset.hl_coin,
        ticker: asset.ticker,
        name: asset.name,
        imageRef: asset.image_ref,
      },
      nextEarnings: nextEvent,
      earningsOdds: (asset.earnings_odds as unknown[])?.[0] ?? null,
      earningsHistory: asset.earnings_history,
      market: priceRows,
    });
  }),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

interface PriceRow {
  mark_px: number;
  ts: string;
}

async function fetchMarkPrice(ticker: string) {
  const db = config.clickhouse.database;
  const dex = config.clickhouse.dex || undefined;
  const dexFilter = dex ? "AND dex = {dex:String}" : "";
  const params: Record<string, unknown> = { ticker };
  if (dex) params.dex = dex;

  // Join assets → coin via HL coin name matching ticker symbol
  // hl_coin in asset_ctx matches the ticker for most HL perps (e.g. AAPL-PERP → AAPL)
  const rows = await query<PriceRow>(
    "asset_mark_price",
    `SELECT argMax(mark_px, ts) AS mark_px, max(ts) AS ts
     FROM ${db}.asset_ctx
     WHERE coin = {ticker:String}
       AND ts > now() - INTERVAL 1 HOUR
       ${dexFilter}
     GROUP BY coin`,
    params,
  );
  return rows[0] ?? null;
}
