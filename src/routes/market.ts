import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { badRequest, notFound } from "../lib/httpError.js";
import { query } from "../lib/clickhouse.js";
import { config } from "../config/env.js";
import { TtlCache } from "../lib/cache.js";

export const marketRouter = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketRow {
  dex: string;
  coin: string;
  mark_px: number;
  oracle_px: number;
  mid_px: number | null;
  open_interest: number;
  day_volume: number;
  ts: string;
}

interface PerpMetaRow {
  dex: string;
  coin: string;
  max_leverage: number;
}

interface PerpPriceRow {
  coin: string;
  mark_px: number;
  ts: string;
}

interface CandleRow {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 5-second TTL for per-coin perp snapshots (live-read cache)
const perpCache = new TtlCache<object>();
const PERP_CACHE_TTL = 5_000;

// ── GET /v1/market/sample ─────────────────────────────────────────────────────

const sampleSchema = z.object({
  coin: z.string().trim().min(1).max(32).optional(),
  dex: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * GET /v1/market/sample — ANONYMOUS.
 *
 * Latest snapshot per coin from hl-ingest's asset_ctx, newest-volume first.
 * Optional filters: ?coin=BTC, ?dex=xyz, ?limit=25.
 */
marketRouter.get(
  "/sample",
  asyncHandler(async (req, res) => {
    const parsed = sampleSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { coin, limit } = parsed.data;
    const dex = parsed.data.dex ?? (config.clickhouse.dex || undefined);

    const conditions: string[] = ["ts > now() - INTERVAL 1 DAY"];
    const params: Record<string, unknown> = { limit };
    if (dex) { conditions.push("dex = {dex:String}"); params.dex = dex; }
    if (coin) { conditions.push("coin = {coin:String}"); params.coin = coin; }

    const sql = `
      SELECT
        dex,
        coin,
        argMax(mark_px, ts)       AS mark_px,
        argMax(oracle_px, ts)     AS oracle_px,
        argMax(mid_px, ts)        AS mid_px,
        argMax(open_interest, ts) AS open_interest,
        argMax(day_volume, ts)    AS day_volume,
        max(ts)                   AS ts
      FROM ${config.clickhouse.database}.asset_ctx
      WHERE ${conditions.join(" AND ")}
      GROUP BY dex, coin
      ORDER BY day_volume DESC
      LIMIT {limit:UInt32}
    `;

    const rows = await query<MarketRow>("market_sample", sql, params);
    res.json({ asOf: rows[0]?.ts ?? null, count: rows.length, markets: rows });
  }),
);

// ── GET /v1/market/perp/:coin ─────────────────────────────────────────────────

const VALID_COIN = /^[A-Za-z0-9]{1,20}$/;

/**
 * GET /v1/market/perp/:coin — ANONYMOUS.
 *
 * Returns mark price (not oracle), max leverage, and price-change over
 * standard timeframes — all sourced from ClickHouse.
 *
 * Price changes are computed by comparing the current mark_px against the
 * close price of candles at each lookback boundary (1h, 24h, 7d, 30d).
 */
marketRouter.get(
  "/perp/:coin",
  asyncHandler(async (req, res) => {
    const coin = req.params["coin"]!.toUpperCase();
    if (!VALID_COIN.test(coin)) throw badRequest("invalid coin");

    const dex = config.clickhouse.dex || undefined;
    const db = config.clickhouse.database;

    const result = await perpCache.getOrSet(`perp:${coin}`, PERP_CACHE_TTL, async () => {
      const dexFilter = dex ? "AND dex = {dex:String}" : "";
      const params: Record<string, unknown> = { coin };
      if (dex) params.dex = dex;

      // Current snapshot
      const [snapshot] = await query<PerpPriceRow>(
        "perp_snapshot",
        `SELECT coin, argMax(mark_px, ts) AS mark_px, max(ts) AS ts
         FROM ${db}.asset_ctx
         WHERE coin = {coin:String} ${dexFilter}
           AND ts > now() - INTERVAL 1 HOUR
         GROUP BY coin`,
        params,
      );
      if (!snapshot) throw notFound(`coin not found: ${coin}`);

      // Max leverage from perp_meta
      const [meta] = await query<PerpMetaRow>(
        "perp_meta",
        `SELECT dex, coin, argMax(max_leverage, ts) AS max_leverage
         FROM ${db}.perp_meta
         WHERE coin = {coin:String} ${dexFilter}
         GROUP BY dex, coin`,
        params,
      );

      // Price changes: close price at each lookback boundary from 1d candles
      const changeRows = await query<{ bucket: string; close: number }>(
        "perp_price_change",
        `SELECT
           multiIf(
             ts >= now() - INTERVAL 1 HOUR,  '1h',
             ts >= now() - INTERVAL 1 DAY,   '1d',
             ts >= now() - INTERVAL 7 DAY,   '7d',
             '30d'
           ) AS bucket,
           argMin(close, ts) AS close
         FROM ${db}.candles
         WHERE coin = {coin:String} ${dexFilter}
           AND interval = '1h'
           AND ts >= now() - INTERVAL 30 DAY
           AND ts < now() - INTERVAL 1 MINUTE
         GROUP BY bucket`,
        params,
      );

      const baseline: Record<string, number> = {};
      for (const r of changeRows) baseline[r.bucket] = r.close;

      const markPx = Number(snapshot.mark_px);
      function pctChange(base: number | undefined) {
        if (!base || base === 0) return null;
        return Number(((markPx - base) / base * 100).toFixed(4));
      }

      return {
        coin,
        dex: dex ?? null,
        markPx,
        maxLeverage: meta?.max_leverage ?? null,
        priceChange: {
          "1h":  pctChange(baseline["1h"]),
          "1d":  pctChange(baseline["1d"]),
          "7d":  pctChange(baseline["7d"]),
          "30d": pctChange(baseline["30d"]),
        },
        asOf: snapshot.ts,
      };
    });

    res.json(result);
  }),
);

// ── GET /v1/market/perp/:coin/candles ─────────────────────────────────────────

const VALID_INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

const candlesSchema = z.object({
  interval: z.string().min(1).max(4),
  from: z.coerce.number().int().positive(),
  to:   z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

/**
 * GET /v1/market/perp/:coin/candles — ANONYMOUS.
 *
 * Chart candle data from ClickHouse. Intervals: 1m,5m,15m,1h,4h,1d.
 * ?from= and ?to= are unix timestamps in seconds; ?limit= caps the result.
 */
marketRouter.get(
  "/perp/:coin/candles",
  asyncHandler(async (req, res) => {
    const coin = req.params["coin"]!.toUpperCase();
    if (!VALID_COIN.test(coin)) throw badRequest("invalid coin");

    const parsed = candlesSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { interval, from, limit } = parsed.data;
    const to = parsed.data.to ?? Math.floor(Date.now() / 1000);

    if (!VALID_INTERVALS.has(interval)) {
      throw badRequest(`interval must be one of: ${[...VALID_INTERVALS].join(", ")}`);
    }
    if (from >= to) throw badRequest("from must be before to");

    const dex = config.clickhouse.dex || undefined;
    const db = config.clickhouse.database;
    const dexFilter = dex ? "AND dex = {dex:String}" : "";
    const params: Record<string, unknown> = { coin, interval, from, to, limit };
    if (dex) params.dex = dex;

    const rows = await query<CandleRow>(
      "perp_candles",
      `SELECT ts, open, high, low, close, volume
       FROM ${db}.candles
       WHERE coin = {coin:String}
         AND interval = {interval:String}
         AND ts >= fromUnixTimestamp({from:Int64})
         AND ts <= fromUnixTimestamp({to:Int64})
         ${dexFilter}
       ORDER BY ts ASC
       LIMIT {limit:UInt32}`,
      params,
    );

    res.json({ coin, interval, count: rows.length, candles: rows });
  }),
);
