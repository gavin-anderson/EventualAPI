/**
 * Job: Polymarket Earnings Odds Sync
 *
 * Fetches the market-implied "will this company beat earnings?" probability from
 * Polymarket's Gamma API and upserts it into earnings_odds (one row per asset).
 *
 * Matching (rewritten for reliability):
 *   - Fetch the EVENTS tagged "earnings" (not raw markets) — these are exactly
 *     the "Will <Company> (TICKER) beat quarterly earnings?" markets.
 *   - Each event's slug/title carries the stock TICKER, so we match on an EXACT
 *     ticker (e.g. from "(NXPI)"), never a fuzzy company-name substring. This
 *     avoids mis-binding novelty markets like "Will Tesla say 'Energy' ...".
 *   - The YES price is looked up by the "Yes" outcome index (outcomes /
 *     outcomePrices arrive as JSON strings and are parsed).
 *
 * Coverage is intentionally sparse: Polymarket only lists a beat market for a
 * subset of companies, and only near their earnings date — so most assets get
 * no row, which is expected. Polymarket Gamma API is public (no key).
 *
 * Scheduling: deferred — export the function for the scheduler to call.
 */
import { supabaseAdmin } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const REQUEST_TIMEOUT_MS = 15_000;

interface PolyInnerMarket {
  outcomes?: unknown; // JSON string like '["Yes","No"]'
  outcomePrices?: unknown; // JSON string like '["0.44","0.56"]'
}

interface PolyEvent {
  id: string;
  slug: string;
  title: string;
  markets?: PolyInnerMarket[];
}

export interface BeatOdds {
  ticker: string;
  beatPct: number; // 0..100
  marketUrl: string;
}

/** Parse Gamma's stringified JSON arrays (which may also already be arrays). */
function parseStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? (p as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Extract the stock ticker from an earnings event's title or slug. */
function tickerFromEvent(ev: PolyEvent): string | null {
  // Prefer the "(TICKER)" in the title, e.g. "Will NXP Semiconductors (NXPI) ...".
  const m = ev.title?.match(/\(([A-Z][A-Z.]{0,9})\)/);
  if (m) return m[1]!;
  // Fallback: slug is "<ticker>-quarterly-earnings-...".
  const slugTicker = ev.slug?.split("-quarterly-earnings")[0];
  return slugTicker ? slugTicker.toUpperCase() : null;
}

/** YES probability (0..1) for a beat-earnings event, or null if unparseable. */
function yesProbability(ev: PolyEvent): number | null {
  const mk = ev.markets?.[0];
  if (!mk) return null;
  const outcomes = parseStrArray(mk.outcomes).map((o) => o.toLowerCase());
  const prices = parseStrArray(mk.outcomePrices);
  if (prices.length === 0) return null;
  const yesIdx = outcomes.indexOf("yes");
  const px = Number(prices[yesIdx >= 0 ? yesIdx : 0]);
  return Number.isFinite(px) && px >= 0 && px <= 1 ? px : null;
}

/**
 * Fetch current Polymarket beat-earnings odds, keyed by ticker. Pure (no DB),
 * so it can be tested/live-checked on its own.
 */
export async function fetchPolymarketBeatOdds(): Promise<Map<string, BeatOdds>> {
  const url = new URL(`${GAMMA_BASE}/events`);
  url.searchParams.set("tag_slug", "earnings");
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "500"); // bounded; earnings events active at once are few

  const resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Polymarket Gamma API ${resp.status}`);
  const events = (await resp.json()) as PolyEvent[];

  const byTicker = new Map<string, BeatOdds>();
  for (const ev of events) {
    const ticker = tickerFromEvent(ev);
    if (!ticker) continue;
    const yes = yesProbability(ev);
    if (yes === null) continue;
    // First match per ticker wins (Gamma returns newest first).
    if (!byTicker.has(ticker)) {
      byTicker.set(ticker, {
        ticker,
        beatPct: Number((yes * 100).toFixed(2)),
        marketUrl: `https://polymarket.com/event/${ev.slug}`,
      });
    }
  }
  return byTicker;
}

export async function syncEarningsOdds(): Promise<void> {
  const log = logger.child({ job: "syncEarningsOdds" });
  log.info("starting");

  const sb = supabaseAdmin();

  // Assets that have an upcoming earnings event (to link the odds row to it).
  const { data, error } = await sb
    .from("assets")
    .select("id, ticker, earnings_events (id, earnings_at)")
    .gte("earnings_events.earnings_at", new Date().toISOString())
    .order("earnings_at", { referencedTable: "earnings_events", ascending: true })
    .limit(1, { referencedTable: "earnings_events" });

  if (error) {
    log.error({ error: error.message }, "failed to load assets");
    return;
  }

  type AssetRow = {
    id: string;
    ticker: string;
    earnings_events: Array<{ id: string; earnings_at: string }>;
  };
  const assets = (data as AssetRow[] | null) ?? [];
  if (assets.length === 0) {
    log.info("no assets with upcoming earnings — nothing to sync");
    return;
  }

  let odds: Map<string, BeatOdds>;
  try {
    odds = await fetchPolymarketBeatOdds();
  } catch (err) {
    log.error({ err }, "failed to fetch Polymarket odds — aborting");
    return;
  }
  log.info({ markets: odds.size }, "polymarket beat markets fetched");

  let upserted = 0;
  let matched = 0;
  for (const asset of assets) {
    const nextEvent = asset.earnings_events[0];
    if (!nextEvent) continue;
    const hit = odds.get(asset.ticker.toUpperCase());
    if (!hit) continue;
    matched++;

    const { error: upErr } = await sb.from("earnings_odds").upsert(
      {
        asset_id: asset.id,
        earnings_event_id: nextEvent.id,
        beat_pct: hit.beatPct,
        market_url: hit.marketUrl,
        source: "polymarket",
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "asset_id" },
    );
    if (upErr) {
      log.error({ ticker: asset.ticker, error: upErr.message }, "upsert failed");
    } else {
      upserted++;
    }
  }

  log.info({ matched, upserted }, "done");
}
