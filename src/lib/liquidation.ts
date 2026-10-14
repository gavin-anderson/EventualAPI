import { supabaseAdmin } from "./supabase.js";
import { fetchClearinghouseState, fetchMarketQuotes, bareCoin } from "./hyperliquid.js";
import { config } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Liquidation tracking.
 *
 * Split into two operations with very different costs, because liquidation
 * proximity depends on two numbers that change at very different rates:
 *
 *   liquidationPx  changes when the POSITION changes   -> ~never
 *   mark price     changes when the MARKET moves       -> constantly
 *
 * So REFRESH (one Hyperliquid call per wallet) runs slowly, and EVALUATE (one
 * call for every market, plus one query) runs often. The fast-moving input is
 * the cheap one, which is what makes near-real-time detection affordable on top
 * of slow position refresh.
 */

/** Cadence tiers. A wallet holding risk is worth watching; an idle one isn't. */
const REFRESH_WITH_POSITIONS_MS = 2 * 60_000;
const REFRESH_IDLE_MS = 30 * 60_000;
/** Give up on a wallet after this many consecutive failures. */
const MAX_ERRORS = 10;

// ── Enrolment ─────────────────────────────────────────────────────────────────

/**
 * Enrol a wallet for tracking. Called when a profile's wallet is resolved — on
 * first authenticated call, NOT first trade, so a position opened before we ever
 * saw the user is still found.
 */
export async function trackWallet(userId: string, wallet: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("tracked_wallets")
    .upsert(
      { wallet_address: wallet, user_id: userId },
      { onConflict: "wallet_address", ignoreDuplicates: true },
    );
  // Non-fatal: tracking is a background concern and must never fail a sign-in.
  if (error) logger.warn({ err: error, wallet }, "could not enrol wallet for tracking");
}

// ── Refresh ───────────────────────────────────────────────────────────────────

export interface RefreshResult {
  walletsClaimed: number;
  walletsRefreshed: number;
  positionsOpen: number;
  errors: number;
}

interface DueWallet {
  wallet_address: string;
  user_id: string;
  consecutive_errors: number;
}

/**
 * Refresh the positions of every wallet that is due, up to `budget` wallets.
 *
 * Budget-capped rather than "refresh everyone every N minutes": the limit
 * degrades gracefully as users grow — the long tail just refreshes less often
 * instead of the whole sweep blowing a rate limit.
 */
export async function refreshDuePositions(budget = 100): Promise<RefreshResult> {
  const db = supabaseAdmin();
  const result: RefreshResult = {
    walletsClaimed: 0,
    walletsRefreshed: 0,
    positionsOpen: 0,
    errors: 0,
  };

  const { data, error } = await db
    .from("tracked_wallets")
    .select("wallet_address, user_id, consecutive_errors")
    .lte("next_refresh_at", new Date().toISOString())
    .lt("consecutive_errors", MAX_ERRORS)
    .order("next_refresh_at", { ascending: true })
    .limit(budget);
  if (error) throw new Error(`claiming due wallets failed: ${error.message}`);

  const due = (data as DueWallet[]) ?? [];
  result.walletsClaimed = due.length;
  if (due.length === 0) return result;

  for (const w of due) {
    try {
      const open = await refreshWallet(w.wallet_address);
      result.walletsRefreshed += 1;
      result.positionsOpen += open;
    } catch (err) {
      result.errors += 1;
      const attempts = w.consecutive_errors + 1;
      await db
        .from("tracked_wallets")
        .update({
          consecutive_errors: attempts,
          last_error: String(err instanceof Error ? err.message : err).slice(0, 300),
          // Back off so one bad wallet can't eat the budget every run.
          next_refresh_at: new Date(
            Date.now() + Math.min(2 ** attempts, 60) * 60_000,
          ).toISOString(),
        })
        .eq("wallet_address", w.wallet_address);
      logger.warn({ err, wallet: w.wallet_address, attempts }, "wallet refresh failed");
    }
  }
  return result;
}

/** Replace one wallet's mirrored positions with what Hyperliquid reports now. */
async function refreshWallet(wallet: string): Promise<number> {
  const db = supabaseAdmin();
  // Scoped to the app's dex: these are the positions we can actually track.
  // Cross-margin positions elsewhere often have no single liquidation price.
  const state = await fetchClearinghouseState(wallet, config.hyperliquid.dex);
  const asOf = new Date().toISOString();

  const rows = state.assetPositions
    .map((ap) => ap.position)
    .filter((p) => Number(p.szi) !== 0)
    .map((p) => {
      const szi = Number(p.szi);
      return {
        wallet_address: wallet,
        coin: bareCoin(p.coin),
        side: szi > 0 ? "long" : "short",
        size: Math.abs(szi),
        entry_px: p.entryPx ? Number(p.entryPx) : 0,
        liquidation_px: p.liquidationPx ? Number(p.liquidationPx) : null,
        leverage: p.leverage?.value ?? null,
        margin_type: p.leverage?.type === "cross" ? "cross" : "isolated",
        margin_used: p.marginUsed ? Number(p.marginUsed) : null,
        unrealized_pnl: Number(p.unrealizedPnl) || 0,
        as_of: asOf,
      };
    })
    .filter((r) => r.entry_px > 0);

  if (rows.length > 0) {
    const { error } = await db
      .from("wallet_open_positions")
      .upsert(rows, { onConflict: "wallet_address,coin" });
    if (error) throw new Error(`mirror upsert failed: ${error.message}`);
  }

  // Anything still on file that HL no longer reports has been closed. Deleted
  // rather than flagged: this table answers "what is at risk now", and the
  // history lives in `positions`.
  const keep = rows.map((r) => r.coin);
  let prune = db.from("wallet_open_positions").delete().eq("wallet_address", wallet);
  if (keep.length > 0) prune = prune.not("coin", "in", `(${keep.join(",")})`);
  const { error: pruneError } = await prune;
  if (pruneError) throw new Error(`mirror prune failed: ${pruneError.message}`);

  const { error: schedError } = await db
    .from("tracked_wallets")
    .update({
      last_refreshed_at: asOf,
      has_open_positions: rows.length > 0,
      consecutive_errors: 0,
      last_error: null,
      next_refresh_at: new Date(
        Date.now() + (rows.length > 0 ? REFRESH_WITH_POSITIONS_MS : REFRESH_IDLE_MS),
      ).toISOString(),
    })
    .eq("wallet_address", wallet);
  if (schedError) throw new Error(`reschedule failed: ${schedError.message}`);

  return rows.length;
}

// ── Evaluate ──────────────────────────────────────────────────────────────────

export interface RiskReading {
  wallet: string;
  coin: string;
  side: "long" | "short";
  leverage: number | null;
  marginType: string | null;
  entryPx: number;
  liquidationPx: number;
  markPx: number;
  /**
   * Fraction of the entry-to-liquidation move already used: 0 at entry, 1 at
   * liquidation, negative when the position is in profit.
   *
   * Only comparable across positions for ISOLATED margin, where runway is
   * roughly 1/leverage. Under cross margin the liquidation price depends on
   * total account health, so a well-collateralised 30x position can sit 40%
   * away from liquidation and `consumed` says almost nothing about leverage.
   * Always read it alongside `marginType`.
   */
  consumed: number;
  /** How far the price must still move, as a fraction of the mark. */
  remainingPct: number;
  /** Age of the liquidation price in seconds. */
  stalenessSeconds: number;
}

export interface EvaluateResult {
  positions: number;
  evaluated: number;
  skippedNoLiqPrice: number;
  skippedNoMark: number;
  readings: RiskReading[];
}

interface MirrorRow {
  wallet_address: string;
  coin: string;
  side: "long" | "short";
  entry_px: number;
  liquidation_px: number | null;
  leverage: number | null;
  margin_type: string | null;
  as_of: string;
}

/**
 * Compute liquidation proximity for every mirrored position.
 *
 * SHADOW MODE: returns readings and logs them. It sends nothing and decides
 * nothing. The alert model — what to fire on, at which thresholds, how often —
 * is a separate product decision, and this pipeline doesn't depend on the
 * answer. Running it silently is what produces the data that decision needs.
 */
export async function evaluateRisk(): Promise<EvaluateResult> {
  const db = supabaseAdmin();
  const result: EvaluateResult = {
    positions: 0,
    evaluated: 0,
    skippedNoLiqPrice: 0,
    skippedNoMark: 0,
    readings: [],
  };

  const { data, error } = await db
    .from("wallet_open_positions")
    .select("wallet_address, coin, side, entry_px, liquidation_px, leverage, margin_type, as_of");
  if (error) throw new Error(`reading mirror failed: ${error.message}`);

  const rows = (data as MirrorRow[]) ?? [];
  result.positions = rows.length;
  if (rows.length === 0) return result;

  // One call covers every market, so this cost is flat in position count.
  const quotes = await fetchMarketQuotes(config.hyperliquid.dex);
  const now = Date.now();

  for (const r of rows) {
    if (r.liquidation_px === null) {
      // Cross-margin positions often have none: liquidation depends on total
      // account health, not this position. Not trackable without modelling
      // HL's whole margin engine.
      result.skippedNoLiqPrice += 1;
      continue;
    }
    const quote = quotes.get(r.coin);
    if (!quote) {
      result.skippedNoMark += 1;
      continue;
    }

    const liq = Number(r.liquidation_px);
    const entry = Number(r.entry_px);
    const mark = quote.markPx;

    const runway = Math.abs(entry - liq);
    const remaining = Math.abs(mark - liq);
    // Normalised against this position's own runway, because 8% from
    // liquidation means something very different at 2x than at 20x. Only
    // comparable across positions when margin is isolated — see RiskReading.
    const consumed = runway > 0 ? 1 - remaining / runway : 1;

    result.readings.push({
      wallet: r.wallet_address,
      coin: r.coin,
      side: r.side,
      leverage: r.leverage,
      marginType: r.margin_type,
      entryPx: entry,
      liquidationPx: liq,
      markPx: mark,
      consumed: Number(consumed.toFixed(4)),
      remainingPct: Number((remaining / mark).toFixed(6)),
      stalenessSeconds: Math.round((now - Date.parse(r.as_of)) / 1000),
    });
    result.evaluated += 1;
  }

  // Sorted worst-first so the log is useful at a glance.
  result.readings.sort((a, b) => b.consumed - a.consumed);
  return result;
}
