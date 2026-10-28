import { supabaseAdmin } from "./supabase.js";
import { notifyMany } from "./notify.js";
import { logger } from "./logger.js";

/**
 * "Earnings are out": one push to every user when a release is filed.
 *
 * Runs as a sweep over confirmed events rather than inline where the release is
 * stamped, so a crash between stamping the event and sending still sends on the
 * next run — the imminent tier stops looking at an event once it is confirmed,
 * so an inline send would have no second chance.
 *
 * Idempotency is a claim on the event row: `released_notified_at` is set with
 * a conditional update BEFORE the fan-out, and only the run that flips it from
 * null sends. A crash mid-fan-out therefore loses the remaining pushes rather
 * than repeating the delivered ones — the right way round for a broadcast.
 */

/**
 * How far back a release still counts as news. The imminent tier pins a
 * release within ~5 minutes of filing; anything older was found late (e.g. by
 * the daily calendar sync) and "just reported" would be wrong.
 */
const FRESH_MS = 3 * 3_600_000;
/** Profiles read per page. PostgREST's default row cap is 1000. */
const PAGE = 1000;

interface AssetRef {
  ticker: string;
  name: string | null;
}

interface ReleasedRow {
  id: string;
  // To-one embed; typed loosely without generated schema types (see
  // refreshImminentEarnings.ts).
  assets: AssetRef | AssetRef[] | null;
}

export function releaseMessage(ticker: string, name: string | null): { title: string; body: string } {
  return {
    title: `${ticker} earnings are out`,
    body: `${name?.trim() || ticker} just reported. Tap to see the reaction.`,
  };
}

/** Notify everyone of each fresh, not-yet-announced release. Returns events sent. */
export async function notifyReleasedEarnings(): Promise<number> {
  const db = supabaseAdmin();
  const log = logger.child({ job: "earningsReleased" });
  const now = Date.now();

  const { data, error } = await db
    .from("earnings_events")
    .select("id, assets ( ticker, name )")
    .eq("is_confirmed", true)
    .eq("time_precision", "exact")
    .is("released_notified_at", null)
    .gte("earnings_at", new Date(now - FRESH_MS).toISOString())
    .lte("earnings_at", new Date(now).toISOString());
  if (error) throw new Error(`reading released events failed: ${error.message}`);

  let sent = 0;
  for (const row of (data as unknown as ReleasedRow[]) ?? []) {
    const asset = Array.isArray(row.assets) ? row.assets[0] : row.assets;
    if (!asset) continue;

    // The claim. Zero rows back means another run got here first.
    const { data: claimed, error: claimError } = await db
      .from("earnings_events")
      .update({ released_notified_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("released_notified_at", null)
      .select("id");
    if (claimError) {
      log.error({ ticker: asset.ticker, error: claimError.message }, "claim failed");
      continue;
    }
    if (((claimed as unknown[]) ?? []).length === 0) continue;

    const result = await broadcast(row.id, asset);
    sent += 1;
    log.info({ ticker: asset.ticker, eventId: row.id, ...result }, "earnings release pushed");
  }
  return sent;
}

/** Every user with a profile, a page at a time. */
async function broadcast(
  eventId: string,
  asset: AssetRef,
): Promise<{ users: number; delivered: number; failed: number }> {
  const db = supabaseAdmin();
  const { title, body } = releaseMessage(asset.ticker, asset.name);
  const totals = { users: 0, delivered: 0, failed: 0 };

  // Keyset paging on the primary key: stable while profiles are being added,
  // unlike offsets.
  let after = "";
  for (;;) {
    const { data, error } = await db
      .from("profiles")
      .select("id")
      .gt("id", after)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (error) throw new Error(`reading profiles failed: ${error.message}`);
    const ids = ((data as Array<{ id: string }>) ?? []).map((r) => r.id);
    if (ids.length === 0) break;

    const result = await notifyMany(
      ids.map((userId) => ({
        userId,
        kind: "earnings_confirmed" as const,
        title,
        body,
        route: `asset:${asset.ticker}`,
        collapseId: `earnings:${eventId}`,
      })),
    );
    totals.users += ids.length;
    totals.delivered += result.delivered;
    totals.failed += result.failed;

    if (ids.length < PAGE) break;
    after = ids[ids.length - 1]!;
  }
  return totals;
}
