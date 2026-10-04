import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { badRequest, notFound } from "../lib/httpError.js";
import { supabaseAdmin } from "../lib/supabase.js";

export const assetsRouter = Router();

const VALID_TICKER = /^[A-Za-z]{1,10}$/;

const listSchema = z.object({
  dex: z.string().trim().min(1).max(64).optional(),
  kind: z.string().trim().min(1).max(16).optional(),
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
    const { dex, kind, limit, offset } = parsed.data;

    const db = supabaseAdmin();
    let q = db
      .from("assets")
      .select("id, dex, hl_coin, ticker, name, image_ref, kind", { count: "exact" })
      .order("ticker")
      .range(offset, offset + limit - 1);

    if (dex) q = q.eq("dex", dex);
    if (kind) q = q.eq("kind", kind);

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
 *
 * No price data: the app reads marks from Hyperliquid directly.
 */
assetsRouter.get(
  "/:ticker",
  asyncHandler(async (req, res) => {
    const ticker = req.params["ticker"]!.toUpperCase();
    if (!VALID_TICKER.test(ticker)) throw badRequest("invalid ticker");

    const db = supabaseAdmin();

    const assetResult = await db
      .from("assets")
        .select(
          `id, dex, hl_coin, ticker, name, image_ref, kind,
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
      .single();

    if (assetResult.error || !assetResult.data) {
      throw notFound(`asset not found: ${ticker}`);
    }

    const asset = assetResult.data as Record<string, unknown>;

    // Split earnings events: next upcoming vs past (in case any leaked through)
    const allEvents = (asset.earnings_events as Array<Record<string, unknown>>) ?? [];
    const now = new Date().toISOString();
    const nextEvent = allEvents.find((e) => (e.earnings_at as string) >= now) ?? null;

    // earnings_odds is one-to-one (unique asset_id), so PostgREST embeds it as an
    // OBJECT, not an array — index defensively so it works either way.
    const oddsRaw = asset.earnings_odds;
    const earningsOdds = Array.isArray(oddsRaw) ? (oddsRaw[0] ?? null) : (oddsRaw ?? null);

    res.json({
      asset: {
        id: asset.id,
        dex: asset.dex,
        hlCoin: asset.hl_coin,
        ticker: asset.ticker,
        name: asset.name,
        imageRef: asset.image_ref,
        kind: asset.kind,
      },
      nextEarnings: nextEvent,
      earningsOdds,
      earningsHistory: asset.earnings_history,
    });
  }),
);
