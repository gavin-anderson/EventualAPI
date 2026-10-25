/**
 * Job scheduler — the long-running process behind the Heroku `worker` dyno.
 *
 * Replaces the systemd timers in deploy/systemd (same names, same UTC
 * schedule) on hosts without systemd. It only decides WHEN: each run is still
 * `node dist/jobs/run.js <job-name>` in its own child process, so a job that
 * hangs, OOMs or throws can't take the scheduler (or the other jobs) down.
 *
 * Guarantees it keeps from systemd:
 *   - no overlap: a job still running when its next tick comes is skipped;
 *   - a wedged job is killed after JOB_TIMEOUT_MS (systemd's TimeoutStartSec).
 *
 * Deliberately NOT kept: the on-boot runs of the daily syncs. Heroku restarts
 * dynos daily and on every deploy, and the history sync spends most of the
 * Alpha Vantage free tier's 25 requests/day, so a run per restart would starve
 * the scheduled one. A restart landing exactly on 08:15/08:30 skips that day.
 *
 * Run exactly ONE scheduler: two would run every job twice (and
 * detect-liquidations would push twice).
 *
 * Usage: node dist/jobs/scheduler.js
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger.js";

const RUNNER = fileURLToPath(new URL("./run.js", import.meta.url));
const TICK_MS = 30_000;
const JOB_TIMEOUT_MS = 600_000;
/** Heroku sends SIGKILL 30s after SIGTERM; leave room to exit cleanly. */
const SHUTDOWN_GRACE_MS = 25_000;

/** UTC wall-clock matchers, evaluated on each 30-second boundary. */
type Due = (t: Date) => boolean;
const atMinute = (m: number): Due => (t) => t.getUTCSeconds() === 0 && t.getUTCMinutes() === m;
const daily = (h: number, m: number): Due => (t) => atMinute(m)(t) && t.getUTCHours() === h;

/** Mirrors deploy/systemd/*.timer. Keep the two in step. */
const schedule: Array<{ job: string; due: Due }> = [
  { job: "refresh-positions", due: () => true }, //                       every 30s
  { job: "evaluate-risk", due: () => true }, //                           every 30s, shadow mode
  { job: "detect-liquidations", due: (t) => t.getUTCSeconds() === 0 }, // every minute
  { job: "refresh-imminent", due: (t) => t.getUTCSeconds() === 0 && t.getUTCMinutes() % 5 === 0 },
  { job: "refresh-approaching", due: atMinute(0) }, //                    hourly
  { job: "sync-earnings-odds", due: atMinute(5) }, //                     hourly
  { job: "sync-earnings-calendar", due: daily(8, 15) },
  { job: "sync-earnings-history", due: daily(8, 30) },
];

const running = new Map<string, ChildProcess>();
let stopping = false;

function start(job: string): void {
  if (running.has(job)) {
    logger.warn({ job }, "scheduler: previous run still going, skipping tick");
    return;
  }
  const startedAt = Date.now();
  const child = spawn(process.execPath, [RUNNER, job], { stdio: "inherit" });
  running.set(job, child);

  const timeout = setTimeout(() => {
    logger.error({ job, ms: Date.now() - startedAt }, "scheduler: job timed out, killing");
    child.kill("SIGKILL");
  }, JOB_TIMEOUT_MS);

  child.on("exit", (code, signal) => {
    clearTimeout(timeout);
    running.delete(job);
    const fields = { job, code, signal, ms: Date.now() - startedAt };
    if (code === 0) logger.debug(fields, "scheduler: job finished");
    else logger.error(fields, "scheduler: job failed");
  });
  child.on("error", (err) => logger.error({ job, err }, "scheduler: could not start job"));
}

function tick(): void {
  if (stopping) return;
  // Round to the boundary so a late timer still matches its slot.
  const now = new Date(Math.round(Date.now() / TICK_MS) * TICK_MS);
  for (const { job, due } of schedule) if (due(now)) start(job);
  setTimeout(tick, TICK_MS - (Date.now() % TICK_MS));
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal, running: [...running.keys()] }, "scheduler: shutting down");
  for (const child of running.values()) child.kill("SIGTERM");
  const done = setInterval(() => {
    if (running.size === 0) process.exit(0);
  }, 200);
  setTimeout(() => {
    clearInterval(done);
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

logger.info({ jobs: schedule.map((s) => s.job) }, "scheduler: started");
setTimeout(tick, TICK_MS - (Date.now() % TICK_MS));
