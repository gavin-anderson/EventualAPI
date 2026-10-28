/**
 * Job runner — a standalone entrypoint (NOT the API server).
 *
 * systemd timers invoke `node dist/jobs/run.js <job-name>`, so each scheduled
 * job runs in its OWN process. Consequences:
 *   - job work never touches the API server's event loop; and
 *   - a job that hangs, OOMs, or throws can't take the API down.
 *
 * Exit codes: 0 success · 1 job failed · 2 unknown/missing job name.
 *
 * Usage: node dist/jobs/run.js <job-name>
 */
import { logger } from "../lib/logger.js";
import { syncEarningsCalendar } from "./syncEarningsCalendar.js";
import { syncEarningsHistory } from "./syncEarningsHistory.js";
import { syncEarningsOdds } from "./syncEarningsOdds.js";
import { refreshImminentEarnings } from "./refreshImminentEarnings.js";
import { refreshPositions } from "./refreshPositions.js";
import { evaluateRiskJob } from "./evaluateRisk.js";
import { detectLiquidationsJob } from "./detectLiquidations.js";
import { detectPriceMovesJob } from "./detectPriceMoves.js";
import { backfillEarningsReactions } from "./backfillEarningsReactions.js";

/** Registry of runnable jobs. The imminent tiers bake in their window defaults. */
const jobs: Record<string, () => Promise<void>> = {
  "sync-earnings-calendar": syncEarningsCalendar,
  "sync-earnings-history": () => syncEarningsHistory({ tickers: process.argv.slice(3) }),
  "sync-earnings-odds": syncEarningsOdds,
  // Near-event precision tiers. The daily calendar sync covers everything
  // broadly; these ONLY touch soon-and-still-unconfirmed events, so they never
  // re-do the daily's work and never fetch the whole universe. Each self-gates
  // to a single indexed query when nothing is in its window.
  //   Approaching: events in (1h, 24h] — hourly.
  "refresh-approaching": () => refreshImminentEarnings({ fromHours: 1, toHours: 24 }),
  //   Imminent: events in [-3h, 1h] — every 5 min (escalated cadence). Looks back
  //   because a slot's stored time is a default and the filing can land after it.
  "refresh-imminent": () => refreshImminentEarnings({ fromHours: -3, toHours: 1 }),

  // Liquidation tracking. Split because liquidation prices barely move while
  // marks move constantly: the per-wallet half is slow and budgeted, the
  // all-markets half is one call and runs often.
  "refresh-positions": refreshPositions,
  //   SHADOW MODE: computes proximity and logs it. Sends nothing.
  "evaluate-risk": evaluateRiskJob,
  //   The one liquidation notification we send: past tense, never a false
  //   positive. Proximity warnings are deliberately not shipped yet.
  "detect-liquidations": detectLiquidationsJob,
  // 10%/20% moves against 24h ago, pushed to watchers once per UTC day.
  "detect-price-moves": detectPriceMovesJob,
  // One-time/on-demand: backfill historical reactions for report dates that predate
  // can't cover (pre-perp dates). Extra args are an optional ticker filter.
  "backfill-earnings-reactions": () => backfillEarningsReactions(process.argv.slice(3)),
};

async function main(): Promise<void> {
  const name = process.argv[2];

  if (!name || name === "-h" || name === "--help") {
    logger.info(
      { jobs: Object.keys(jobs) },
      "usage: node dist/jobs/run.js <job-name>",
    );
    process.exit(name ? 0 : 2);
  }

  const job = jobs[name];
  if (!job) {
    logger.error({ name, available: Object.keys(jobs) }, "unknown job");
    process.exit(2);
  }

  const start = Date.now();
  logger.info({ job: name }, "job runner: start");
  try {
    await job();
    logger.info({ job: name, ms: Date.now() - start }, "job runner: success");
    process.exit(0);
  } catch (err) {
    logger.error({ job: name, ms: Date.now() - start, err }, "job runner: failed");
    process.exit(1);
  }
}

void main();
