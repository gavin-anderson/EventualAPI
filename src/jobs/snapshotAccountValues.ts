/**
 * Job: Daily Account Value Snapshot
 *
 * For each user with a wallet_address in their profile, fetches live HL
 * clearinghouseState via the EU proxy and writes one account_value_snapshots
 * row for today. Idempotent: upserts on (user_id, captured_on).
 *
 * This powers the 24h account-value change shown on the portfolio screen
 * without storing a full time-series (daily granularity is sufficient per spec).
 *
 * Scheduling: deferred — export the function for the scheduler to call.
 * Run frequency: once daily (e.g. 00:05 UTC so yesterday's close is captured).
 */
import { supabaseAdmin } from "../lib/supabase.js";
import { fetchClearinghouseState } from "../lib/hyperliquid.js";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";

export async function snapshotAccountValues(): Promise<void> {
  const log = logger.child({ job: "snapshotAccountValues" });
  log.info("starting");

  if (!config.hyperliquid.configured) {
    log.warn("HL proxy not configured — skipping");
    return;
  }

  const sb = supabaseAdmin();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Load all profiles that have a wallet address
  const { data: profiles, error } = await sb
    .from("profiles")
    .select("id, wallet_address")
    .not("wallet_address", "is", null);

  if (error) {
    log.error({ error: error.message }, "failed to load profiles");
    return;
  }

  type Profile = { id: string; wallet_address: string };
  const users = (profiles as Profile[]) ?? [];
  log.info({ count: users.length }, "users with wallets");

  let snapshotted = 0;
  let failed = 0;

  for (const { id: userId, wallet_address } of users) {
    try {
      const state = await fetchClearinghouseState(wallet_address);
      const { marginSummary, assetPositions } = state;

      const accountValue = Number(marginSummary.accountValue);
      const positionValue = assetPositions.reduce(
        (sum, ap) => sum + Number(ap.position.positionValue),
        0,
      );
      const cashValue = accountValue - positionValue;

      const { error: upsertErr } = await sb
        .from("account_value_snapshots")
        .upsert(
          {
            user_id:        userId,
            captured_on:    today,
            account_value:  accountValue,
            cash_value:     Number(cashValue.toFixed(2)),
            position_value: Number(positionValue.toFixed(2)),
            captured_at:    new Date().toISOString(),
          },
          { onConflict: "user_id,captured_on" },
        );

      if (upsertErr) {
        log.error({ userId, error: upsertErr.message }, "upsert failed");
        failed++;
      } else {
        snapshotted++;
      }
    } catch (err) {
      // Per-user failure is non-fatal; log and continue
      log.error({ userId, wallet_address, err }, "snapshot failed for user — skipping");
      failed++;
    }
  }

  log.info({ snapshotted, failed }, "done");
}
