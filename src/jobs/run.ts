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
import { syncAssets } from "./syncAssets.js";
import { syncEarningsCalendar } from "./syncEarningsCalendar.js";
import { syncEarningsHistory } from "./syncEarningsHistory.js";
import { syncEarningsOdds } from "./syncEarningsOdds.js";
import { snapshotAccountValues } from "./snapshotAccountValues.js";
import { refreshImminentEarnings } from "./refreshImminentEarnings.js";

/** Registry of runnable jobs. The imminent tiers bake in their window defaults. */
const jobs: Record<string, () => Promise<void>> = {
  "sync-assets": syncAssets,
  "sync-earnings-calendar": syncEarningsCalendar,
  "sync-earnings-history": syncEarningsHistory,
  "sync-earnings-odds": syncEarningsOdds,
  "snapshot-account-values": snapshotAccountValues,
  // Near-event precision tiers. The daily calendar sync covers everything
  // broadly; these ONLY touch soon-and-still-unconfirmed events, so they never
  // re-do the daily's work and never fetch the whole universe. Each self-gates
  // to a single indexed query when nothing is in its window.
  //   Approaching: events in (1h, 24h] — hourly.
  "refresh-approaching": () => refreshImminentEarnings({ fromHours: 1, toHours: 24 }),
  //   Imminent: events in [~now, 1h] — every 5 min (escalated cadence).
  "refresh-imminent": () => refreshImminentEarnings({ fromHours: -0.25, toHours: 1 }),
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
