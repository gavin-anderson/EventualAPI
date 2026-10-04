import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { badRequest, notFound } from "../lib/httpError.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { etMinutesOfDay } from "../lib/datetime.js";

export const earningsRouter = Router();

/**
 * GET /v1/earnings — ANONYMOUS.
 *
 * Upcoming earnings calendar, shaped 1:1 to the app's `MarketEvent`. This is a
 * SUPABASE-ONLY read (earnings_events INNER JOIN assets) — deliberately no
 * price data, so the app's Home feed paints instantly and prices
 * are filled separately over the price WebSocket.
 *
 * Money (`epsEstimate`) is emitted as a STRING so the Swift client can decode it
 * into `Decimal` without a lossy trip through Double.
 */

const listSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  dex: z.string().trim().min(1).max(64).optional(),
});

interface AssetEmbed {
  ticker: string;
  name: string | null;
  hl_coin: string;
  dex: string;
  image_ref: string | null;
  kind: string | null;
}

interface EarningsEventJoinRow {
  earnings_at: string;
  time_precision: "exact" | "session";
  session: "bmo" | "amc" | "dmh" | null;
  is_confirmed: boolean;
  expected_eps: number | null;
  source: string;
  period: string | null;
  period_year: number | null;
  assets: AssetEmbed | AssetEmbed[] | null;
}

// US market session boundaries in minutes-since-ET-midnight (regular hours 9:30–16:00).
const ET_OPEN_MIN = 9 * 60 + 30;
const ET_CLOSE_MIN = 16 * 60;

/**
 * The app's EventTiming raw value (a US-market-session label, ET-anchored — not the
 * viewer's timezone). Benzinga's session code is authoritative when present; for
 * exact-time events (session=null) we derive it from the ET clock of `earnings_at`.
 */
function timingFor(session: "bmo" | "amc" | "dmh" | null, earningsAtISO: string): string {
  switch (session) {
    case "bmo": return "preMarket";
    case "amc": return "postMarket";
    case "dmh": return "duringMarket";
    default: break;
  }
  const min = etMinutesOfDay(earningsAtISO);
  if (min < ET_OPEN_MIN) return "preMarket";
  if (min < ET_CLOSE_MIN) return "duringMarket";
  return "postMarket";
}

/**
 * Composite event id the app keys everything on: "earnings-<TICKER>-<yyyy-MM-dd>".
 * The date is the UTC calendar day of `earnings_at` — derived identically here and
 * in the app's `event(id:)` reconstruction so ids stay stable across both paths.
 */
function eventId(ticker: string, earningsAtISO: string): string {
  return `earnings-${ticker}-${earningsAtISO.slice(0, 10)}`;
}

function embeddedAsset(a: AssetEmbed | AssetEmbed[] | null): AssetEmbed | null {
  if (!a) return null;
  return Array.isArray(a) ? a[0] ?? null : a;
}

earningsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { to, limit, dex } = parsed.data;
    const from = parsed.data.from ?? new Date().toISOString();

    const db = supabaseAdmin();
    let q = db
      .from("earnings_events")
      .select(
        `earnings_at, time_precision, session, is_confirmed, expected_eps, source,
         period, period_year,
         assets!inner ( ticker, name, hl_coin, dex, image_ref, kind )`,
      )
      .gte("earnings_at", from)
      .order("earnings_at", { ascending: true })
      .limit(limit);

    if (to) q = q.lte("earnings_at", to);
    if (dex) q = q.eq("assets.dex", dex);

    const { data, error } = await q;
    if (error) throw new Error(`earnings list failed: ${error.message}`);

    const events = ((data as unknown as EarningsEventJoinRow[] | null) ?? [])
      .map((row) => {
        const asset = embeddedAsset(row.assets);
        if (!asset) return null;
        const ticker = asset.ticker.toUpperCase();
        const periodLabel = [row.period, row.period_year].filter(Boolean).join(" ");
        return {
          id: eventId(ticker, row.earnings_at),
          type: "earnings",
          tickers: [ticker],
          timestamp: row.earnings_at,
          isTradeable: false,
          metadata: {
            title: periodLabel ? `${ticker} ${periodLabel} Earnings` : `${ticker} Earnings`,
            subtitle: asset.name,
            companyName: asset.name,
            fiscalPeriodEnd: null,
            consensus: {
              epsEstimate: row.expected_eps == null ? null : String(row.expected_eps),
              currency: "USD",
            },
            timing: timingFor(row.session, row.earnings_at),
          },
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    res.json({ count: events.length, events });
  }),
);

// ── GET /v1/earnings/:ticker ───────────────────────────────────────────────────

const VALID_TICKER = /^[A-Za-z0-9]{1,15}$/;

/**
 * GET /v1/earnings/:ticker — ANONYMOUS. One ticker's earnings payload.
 *
 * What `/v1/earnings` can't give you: the NEXT event for a single ticker plus
 * its PAST results and the beat odds. That's the asset page's earnings section,
 * and it is the only thing here no other source provides — prices, szDecimals
 * and the tradable universe all come from Hyperliquid directly.
 *
 * Carries a little asset metadata (name, kind) because it is free on the join,
 * not because the app needs us for it.
 */
earningsRouter.get(
  "/:ticker",
  asyncHandler(async (req, res) => {
    const ticker = req.params["ticker"]!.toUpperCase();
    // Allows digits: XYZ100, SP500, JP225, KR200 and H100 are real markets.
    if (!VALID_TICKER.test(ticker)) throw badRequest("invalid ticker");

    const { data, error } = await supabaseAdmin()
      .from("assets")
      .select(
        `ticker, name, kind, hl_coin,
         earnings_events (
           id, earnings_at, time_precision, session, is_confirmed, expected_eps, source,
           period, period_year
         ),
         earnings_history (
           reported_at, eps_actual, eps_estimate, eps_surprise_pct,
           price_change_24h_pct, source
         ),
         earnings_odds ( beat_pct, market_url, source, fetched_at )`,
      )
      .eq("ticker", ticker)
      .order("earnings_at", { ascending: true, referencedTable: "earnings_events" })
      .order("reported_at", { ascending: false, referencedTable: "earnings_history" })
      .limit(1, { referencedTable: "earnings_odds" })
      .maybeSingle();

    if (error) throw new Error(`earnings detail failed: ${error.message}`);
    if (!data) throw notFound(`unknown ticker: ${ticker}`);

    const row = data as Record<string, unknown>;
    const events = (row.earnings_events as Array<Record<string, unknown>>) ?? [];
    const now = new Date().toISOString();

    // earnings_odds is one-to-one (unique asset_id), so PostgREST may embed it as
    // an object rather than an array — index defensively.
    const oddsRaw = row.earnings_odds;
    const odds = Array.isArray(oddsRaw) ? (oddsRaw[0] ?? null) : (oddsRaw ?? null);

    res.json({
      ticker: row.ticker,
      name: row.name,
      kind: row.kind,
      coin: row.hl_coin,
      next: events.find((e) => (e.earnings_at as string) >= now) ?? null,
      history: row.earnings_history ?? [],
      odds,
    });
  }),
);
