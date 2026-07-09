/**
 * Job: Polymarket Earnings Odds Sync
 *
 * Fetches beat-probability from Polymarket's Gamma API for upcoming earnings
 * events and upserts earnings_odds (one row per asset, current event only).
 *
 * Fragility note: Polymarket market titles are not structured; this job does
 * fuzzy matching on company name / ticker and may miss markets or match the
 * wrong one. Log misses and review manually. The source column is always set
 * to 'polymarket' so stale rows can be audited.
 *
 * Polymarket Gamma API is public (no key required as of mid-2026).
 *
 * Scheduling: deferred — export the function for the scheduler to call.
 * Run frequency: hourly (odds update frequently near event date).
 */
import { supabaseAdmin } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const REQUEST_TIMEOUT_MS = 15_000;

interface PolyMarket {
  id: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  outcomePrices: string[];  // e.g. ["0.75", "0.25"] → YES, NO
  url: string;
  endDate: string;
}

export async function syncEarningsOdds(): Promise<void> {
  const log = logger.child({ job: "syncEarningsOdds" });
  log.info("starting");

  const sb = supabaseAdmin();

  // 1. Load assets + their upcoming earnings events
  const { data: assets } = await sb
    .from("assets")
    .select(
      `id, ticker, name,
       earnings_events (id, earnings_at)`,
    )
    .gte("earnings_events.earnings_at", new Date().toISOString())
    .order("earnings_at", { referencedTable: "earnings_events", ascending: true })
    .limit(1, { referencedTable: "earnings_events" });

  type AssetWithEvent = {
    id: string;
    ticker: string;
    name: string | null;
    earnings_events: Array<{ id: string; earnings_at: string }>;
  };

  if (!assets?.length) {
    log.info("no upcoming earnings events — nothing to sync");
    return;
  }

  // 2. Fetch active earnings markets from Polymarket
  let markets: PolyMarket[] = [];
  try {
    markets = await fetchPolymarketEarningsMarkets();
  } catch (err) {
    log.error({ err }, "failed to fetch Polymarket markets — aborting");
    return;
  }
  log.info({ count: markets.length }, "polymarket markets fetched");

  let upserted = 0;

  for (const asset of assets as AssetWithEvent[]) {
    const nextEvent = asset.earnings_events[0];
    if (!nextEvent) continue;

    const market = findMarketForAsset(markets, asset.ticker, asset.name);
    if (!market) {
      log.debug({ ticker: asset.ticker }, "no polymarket match — skipping");
      continue;
    }

    // YES probability is the first outcome price
    const yesPx = Number(market.outcomePrices[0]);
    if (isNaN(yesPx) || yesPx < 0 || yesPx > 1) continue;

    const { error } = await sb.from("earnings_odds").upsert(
      {
        asset_id:          asset.id,
        earnings_event_id: nextEvent.id,
        beat_pct:          Number((yesPx * 100).toFixed(2)),
        market_url:        market.url,
        source:            "polymarket",
        fetched_at:        new Date().toISOString(),
      },
      { onConflict: "asset_id" },
    );

    if (error) {
      log.error({ ticker: asset.ticker, error: error.message }, "upsert failed");
    } else {
      log.debug({ ticker: asset.ticker, beat_pct: yesPx * 100 }, "upserted odds");
      upserted++;
    }
  }

  log.info({ upserted }, "done");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchPolymarketEarningsMarkets(): Promise<PolyMarket[]> {
  const url = new URL(`${GAMMA_BASE}/markets`);
  url.searchParams.set("tag_slug", "earnings");
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "200");

  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Polymarket Gamma API ${resp.status}`);
  return resp.json() as Promise<PolyMarket[]>;
}

/**
 * Fuzzy-match a Polymarket market to a ticker/name.
 * Matches on ticker symbol OR company name (case-insensitive) in the question text.
 * Returns null if no confident match found.
 */
function findMarketForAsset(
  markets: PolyMarket[],
  ticker: string,
  name: string | null,
): PolyMarket | null {
  const tLower = ticker.toLowerCase();
  const nLower = name?.toLowerCase() ?? "";

  // Prefer exact ticker match in question (e.g. "Will AAPL beat earnings?")
  const exactTicker = markets.find((m) => {
    const q = m.question.toLowerCase();
    return q.includes(` ${tLower} `) || q.includes(`(${tLower})`);
  });
  if (exactTicker) return exactTicker;

  // Fall back to company name match
  if (nLower) {
    const byName = markets.find((m) => m.question.toLowerCase().includes(nLower));
    if (byName) return byName;
  }

  return null;
}
