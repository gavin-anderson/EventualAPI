import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { badRequest } from "../lib/httpError.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { etMinutesOfDay } from "../lib/datetime.js";

export const earningsRouter = Router();

/**
 * GET /v1/earnings — ANONYMOUS.
 *
 * Upcoming earnings calendar, shaped 1:1 to the app's `MarketEvent`. This is a
 * SUPABASE-ONLY read (earnings_events INNER JOIN assets) — deliberately no
 * ClickHouse / price data, so the app's Home feed paints instantly and prices
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
