/**
 * Job: Asset Catalog Sync
 *
 * Reads distinct (dex, coin) from ClickHouse perp_meta, maps each HL coin to
 * a ticker symbol, fetches name + logo from Benzinga, uploads the logo to the
 * asset-logos Storage bucket, and upserts the assets table.
 *
 * Scheduling: deferred — export the function for the scheduler to call.
 * Run frequency: daily (logos rarely change).
 */
import { query } from "../lib/clickhouse.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";

interface PerpMetaCoin {
  dex: string;
  coin: string;
}

/**
 * HL perp coins use symbol suffixes that need stripping to get the equity ticker.
 * e.g. "AAPL" → "AAPL", "TSLA" → "TSLA" (most are clean on the xyz dex already).
 * Extend this map if any coins diverge from their ticker symbol.
 */
const HL_COIN_TO_TICKER: Record<string, string> = {
  // Add overrides here if hl_coin != ticker (e.g. "BRK" -> "BRK.B")
};

function coinToTicker(coin: string): string {
  return HL_COIN_TO_TICKER[coin] ?? coin;
}

export async function syncAssets(): Promise<void> {
  const log = logger.child({ job: "syncAssets" });
  log.info("starting");

  const db = config.clickhouse.database;
  const dex = config.clickhouse.dex || undefined;
  const dexFilter = dex ? "WHERE dex = {dex:String}" : "";
  const params: Record<string, unknown> = {};
  if (dex) params.dex = dex;

  // 1. Read all distinct perp coins from ClickHouse
  const coins = await query<PerpMetaCoin>(
    "perp_meta_coins",
    `SELECT DISTINCT dex, coin FROM ${db}.perp_meta ${dexFilter} ORDER BY coin`,
    params,
  );
  log.info({ count: coins.length }, "coins found in perp_meta");

  const sb = supabaseAdmin();

  for (const { dex: coinDex, coin } of coins) {
    const ticker = coinToTicker(coin);
    try {
      // 2. Fetch name + logo URL from Benzinga (company profile endpoint)
      let name: string | null = null;
      let imageRef: string | null = null;

      if (config.benzinga.configured) {
        const result = await fetchCompanyProfile(ticker);
        name = result.name;
        if (result.logoUrl) {
          imageRef = await uploadLogo(sb, ticker, result.logoUrl);
        }
      }

      // 3. Upsert into assets table
      const { error } = await sb
        .from("assets")
        .upsert(
          { dex: coinDex, hl_coin: coin, ticker, name, image_ref: imageRef },
          { onConflict: "dex,hl_coin" },
        );

      if (error) {
        log.error({ coin, ticker, error: error.message }, "upsert failed");
      } else {
        log.debug({ coin, ticker }, "upserted");
      }
    } catch (err) {
      log.error({ coin, ticker, err }, "error processing coin — skipping");
    }
  }

  log.info("done");
}

// ── Benzinga company profile ──────────────────────────────────────────────────

interface CompanyProfile {
  name: string | null;
  logoUrl: string | null;
}

async function fetchCompanyProfile(ticker: string): Promise<CompanyProfile> {
  // Benzinga's logo endpoint returns a logo URL for a given ticker.
  // API: GET https://api.benzinga.com/api/v2/logos?token=...&symbols=AAPL
  const url = new URL("https://api.benzinga.com/api/v2/logos");
  url.searchParams.set("token", config.benzinga.apiKey);
  url.searchParams.set("symbols", ticker);
  url.searchParams.set("fields", "mark_vector_light,logo_light");

  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Benzinga logos ${resp.status}`);

  const data = (await resp.json()) as { logos?: Array<{ logo_light?: string; mark_vector_light?: string }> };
  const logo = data.logos?.[0];

  return {
    name: null, // Benzinga logos endpoint doesn't return company names
    logoUrl: logo?.mark_vector_light ?? logo?.logo_light ?? null,
  };
}

// ── Logo upload to Supabase Storage ──────────────────────────────────────────

async function uploadLogo(
  sb: ReturnType<typeof supabaseAdmin>,
  ticker: string,
  logoUrl: string,
): Promise<string> {
  const logoResp = await fetch(logoUrl, { signal: AbortSignal.timeout(15_000) });
  if (!logoResp.ok) throw new Error(`logo fetch failed: ${logoResp.status}`);

  const contentType = logoResp.headers.get("content-type") ?? "image/png";
  const ext = contentType.includes("svg") ? "svg" : contentType.includes("webp") ? "webp" : "png";
  const path = `${ticker.toLowerCase()}.${ext}`;
  const buffer = Buffer.from(await logoResp.arrayBuffer());

  const { error } = await sb.storage
    .from("asset-logos")
    .upload(path, buffer, { contentType, upsert: true });

  if (error) throw new Error(`storage upload failed: ${error.message}`);
  return path;
}
