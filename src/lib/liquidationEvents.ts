import { supabaseAdmin } from "./supabase.js";
import { fetchUserFills, bareCoin, type HlFill } from "./hyperliquid.js";
import { notify } from "./notify.js";
import { logger } from "./logger.js";

/**
 * Detecting liquidations, and telling the user once.
 *
 * DETECTION RULE (verified against live fills, 2026-10-04): a wallet was
 * liquidated when its own fill carries a `liquidation` object whose
 * `liquidatedUser` equals that wallet.
 *
 * The naive check — "does this fill have a liquidation field" — is wrong and
 * would notify the wrong person. On your account that field usually means you
 * were the counterparty who absorbed someone else's position: `dir: "Open …"`,
 * `closedPnl: 0`, `liquidatedUser` a different address. The victim's own fill
 * is the mirror image: `dir: "Close …"`, a negative `closedPnl`, and
 * `liquidatedUser` set to themselves.
 */

/** Re-scan overlap, so a fill arriving slightly out of order isn't missed. */
const OVERLAP_MS = 10 * 60_000;
/** First scan for a wallet reaches back this far rather than all of history. */
const FIRST_SCAN_MS = 24 * 60 * 60_000;

export interface DetectResult {
  walletsScanned: number;
  eventsFound: number;
  notified: number;
  errors: number;
}

interface Candidate {
  wallet_address: string;
  user_id: string;
  fills_checked_at: string | null;
}

/**
 * One liquidation unwinds in several fills — 8 in the verified sample, all
 * sharing a timestamp. They are grouped into the single event they are, so the
 * user hears about it once with the full size and loss.
 */
interface Grouped {
  coin: string;
  side: "long" | "short";
  liquidatedAt: Date;
  size: number;
  realizedPnl: number;
  markPx: number | null;
  method: string | null;
  fillCount: number;
}

function group(fills: HlFill[], wallet: string): Grouped[] {
  const own = wallet.toLowerCase();
  const byEvent = new Map<string, Grouped>();

  for (const f of fills) {
    const liq = f.liquidation;
    // The whole rule, in one condition.
    if (!liq || liq.liquidatedUser?.toLowerCase() !== own) continue;

    const coin = bareCoin(f.coin);
    const key = `${coin}:${f.time}`;
    const size = Number(f.sz) || 0;
    const pnl = Number(f.closedPnl) || 0;

    const existing = byEvent.get(key);
    if (existing) {
      existing.size += size;
      existing.realizedPnl += pnl;
      existing.fillCount += 1;
      continue;
    }
    byEvent.set(key, {
      coin,
      // The fill CLOSES the position, so its side is the opposite of what was
      // held: a long is closed by selling (side "A").
      side: f.side === "A" ? "long" : "short",
      liquidatedAt: new Date(f.time),
      size,
      realizedPnl: pnl,
      markPx: Number(liq.markPx) || null,
      method: liq.method ?? null,
      fillCount: 1,
    });
  }
  return [...byEvent.values()];
}

/**
 * Scan tracked wallets for liquidations and notify any that are new.
 *
 * Idempotency comes from the `liquidation_events` primary key
 * (wallet, coin, liquidated_at): a re-scan of the same window inserts nothing,
 * so nobody is told twice. That matters more than usual here — a duplicate
 * "you were liquidated" would be alarming.
 */
export async function detectLiquidations(budget = 100): Promise<DetectResult> {
  const db = supabaseAdmin();
  const result: DetectResult = { walletsScanned: 0, eventsFound: 0, notified: 0, errors: 0 };

  // Only wallets that hold or recently held risk. A wallet that has never had a
  // position cannot have been liquidated.
  const { data, error } = await db
    .from("tracked_wallets")
    .select("wallet_address, user_id, fills_checked_at")
    .or("has_open_positions.eq.true,fills_checked_at.not.is.null")
    .lt("consecutive_errors", 10)
    .order("fills_checked_at", { ascending: true, nullsFirst: true })
    .limit(budget);
  if (error) throw new Error(`claiming wallets failed: ${error.message}`);

  for (const w of (data as Candidate[]) ?? []) {
    try {
      const since = w.fills_checked_at
        ? Date.parse(w.fills_checked_at) - OVERLAP_MS
        : Date.now() - FIRST_SCAN_MS;

      const fills = await fetchUserFills(w.wallet_address, since);
      const events = group(fills, w.wallet_address);
      result.walletsScanned += 1;
      result.eventsFound += events.length;

      for (const e of events) {
        const inserted = await recordAndNotify(w.user_id, w.wallet_address, e);
        if (inserted) result.notified += 1;
      }

      await db
        .from("tracked_wallets")
        .update({ fills_checked_at: new Date().toISOString() })
        .eq("wallet_address", w.wallet_address);
    } catch (err) {
      result.errors += 1;
      logger.warn({ err, wallet: w.wallet_address }, "liquidation scan failed");
    }
  }
  return result;
}

/** Returns true when this was a new event (and so a notification was sent). */
async function recordAndNotify(
  userId: string,
  wallet: string,
  e: Grouped,
): Promise<boolean> {
  const db = supabaseAdmin();

  // Insert first. A conflict means we have already handled this event, so the
  // notification is skipped — the row, not a flag, is what prevents a repeat.
  const { data, error } = await db
    .from("liquidation_events")
    .upsert(
      {
        wallet_address: wallet,
        coin: e.coin,
        liquidated_at: e.liquidatedAt.toISOString(),
        user_id: userId,
        side: e.side,
        size: e.size,
        mark_px: e.markPx,
        realized_pnl: e.realizedPnl,
        fill_count: e.fillCount,
        method: e.method,
      },
      { onConflict: "wallet_address,coin,liquidated_at", ignoreDuplicates: true },
    )
    .select("coin");
  if (error) throw new Error(`recording liquidation failed: ${error.message}`);
  if (((data as unknown[]) ?? []).length === 0) return false;

  const loss = Math.abs(e.realizedPnl);
  const outcome = await notify({
    userId,
    kind: "position_liquidated",
    title: `${e.coin} ${e.side} liquidated`,
    body:
      `Your ${e.coin} ${e.side} was liquidated` +
      (e.markPx ? ` at $${e.markPx.toLocaleString("en-US")}` : "") +
      (loss > 0 ? `. Realized loss $${loss.toFixed(2)}.` : "."),
    route: `asset:${e.coin}`,
  });

  await db
    .from("liquidation_events")
    .update({ notified_at: new Date().toISOString() })
    .eq("wallet_address", wallet)
    .eq("coin", e.coin)
    .eq("liquidated_at", e.liquidatedAt.toISOString());

  logger.info(
    { coin: e.coin, side: e.side, realizedPnl: e.realizedPnl, delivered: outcome.delivered },
    "liquidation detected and notified",
  );
  return true;
}
