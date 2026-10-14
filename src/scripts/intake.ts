/**
 * Market intake — bring `assets` in line with the live Hyperliquid universe.
 *
 *   npm run intake status           # what's new, what's delisted, what's missing
 *   npm run intake sync -- --dry-run
 *   npm run intake sync             # insert new listings, flag delisted ones
 *   npm run intake seed             # backfill name/description from the app bundle
 *
 * Run locally and on purpose, not on a timer. Two steps here need judgement —
 * classifying a market and deciding whether it reports earnings — and a
 * scheduled job that guessed would quietly fill the catalogue with wrong rows.
 * New listings arrive a few a month, so a command you run is enough.
 *
 * Art is NOT handled here. `npm run art` does that, because it reads the iOS
 * asset catalogue and its expensive step (generating a card from a logo) still
 * needs a person.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { supabaseAdmin } from "../lib/supabase.js";
import { config } from "../config/env.js";

const RESOURCES = resolve(
  process.cwd(),
  "../earningsMobile/Earnings/Earnings/Resources",
);

interface HlMarket {
  ticker: string;
  coin: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted: boolean;
}

interface AssetRow {
  id: string;
  ticker: string;
  name: string | null;
  kind: string;
  description: string | null;
  reports_earnings: boolean | null;
  delisted_at: string | null;
}

/** What the app bundle knows, which is currently more than the database does. */
interface Bundled {
  name: string | null;
  description: string | null;
  isEquity: boolean | null;
}

async function hlUniverse(): Promise<HlMarket[]> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "meta", dex: config.hyperliquid.dex }),
  });
  if (!res.ok) throw new Error(`hyperliquid meta failed: ${res.status}`);
  const body = (await res.json()) as {
    universe: Array<{
      name: string;
      szDecimals: number;
      maxLeverage: number;
      isDelisted?: boolean;
    }>;
  };
  return body.universe.map((u) => ({
    ticker: (u.name.split(":").pop() ?? u.name).toUpperCase(),
    coin: u.name,
    szDecimals: u.szDecimals,
    maxLeverage: u.maxLeverage,
    isDelisted: u.isDelisted === true,
  }));
}

/**
 * Read the app's bundled catalogue. It is the best editorial source we have:
 * every market it knows has a human-written name and description, and these
 * were shipped, so they have been looked at.
 */
async function bundled(): Promise<Map<string, Bundled>> {
  const out = new Map<string, Bundled>();
  try {
    const markets = JSON.parse(
      await readFile(resolve(RESOURCES, "markets.json"), "utf-8"),
    ) as Array<{ ticker: string; companyName: string | null; isEquity: boolean }>;
    for (const m of markets) {
      out.set(m.ticker.toUpperCase(), {
        name: m.companyName,
        description: null,
        isEquity: m.isEquity,
      });
    }
    const info = JSON.parse(
      await readFile(resolve(RESOURCES, "company-info.json"), "utf-8"),
    ) as Array<{ ticker: string; name: string; description: string }>;
    for (const c of info) {
      const key = c.ticker.toUpperCase();
      const prev = out.get(key) ?? { name: null, description: null, isEquity: null };
      out.set(key, {
        name: prev.name ?? c.name,
        description: c.description,
        isEquity: prev.isEquity,
      });
    }
  } catch (err) {
    console.warn(
      `could not read the app bundle at ${RESOURCES} — ` +
        `new rows will be unnamed (${err instanceof Error ? err.message : err})`,
    );
  }
  return out;
}

/**
 * A first-pass classification, never a final one.
 *
 * HL's `meta` carries no notion of what a market IS, so `kind` has to come from
 * somewhere else. A leveraged-ETF name is recognisable; most things are not,
 * which is why anything uncertain lands as `other` and is printed for review
 * rather than guessed into a specific bucket.
 */
function classify(ticker: string, b: Bundled | undefined): { kind: string } {
  if (b?.isEquity === true) return { kind: "equity" };
  const name = b?.name ?? "";
  if (/\bETFs?\b/i.test(name)) return { kind: "etf" };
  return { kind: "other" };
}

async function loadRows(): Promise<Map<string, AssetRow>> {
  const { data, error } = await supabaseAdmin()
    .from("assets")
    .select("id, ticker, name, kind, description, reports_earnings, delisted_at");
  if (error) throw new Error(`reading assets failed: ${error.message}`);
  return new Map((data as AssetRow[]).map((r) => [r.ticker.toUpperCase(), r]));
}

function fmt(list: string[]): string {
  return list.length > 0 ? list.join(" ") : "(none)";
}

async function status(): Promise<void> {
  const [hl, rows] = await Promise.all([hlUniverse(), loadRows()]);
  const live = hl.filter((m) => !m.isDelisted);
  const dead = hl.filter((m) => m.isDelisted);
  const known = new Set(rows.keys());

  const newLive = live.filter((m) => !known.has(m.ticker)).map((m) => m.ticker);
  const newDead = dead.filter((m) => !known.has(m.ticker)).map((m) => m.ticker);
  const nowDelisted = dead
    .filter((m) => known.has(m.ticker) && !rows.get(m.ticker)!.delisted_at)
    .map((m) => m.ticker);
  const hlTickers = new Set(hl.map((m) => m.ticker));
  const notOnHl = [...known].filter((t) => !hlTickers.has(t));

  console.log(
    `hyperliquid "${config.hyperliquid.dex}": ${hl.length} markets (${live.length} live, ${dead.length} delisted)\n` +
      `assets: ${rows.size} rows\n`,
  );
  console.log(`new and live — sync will insert (${newLive.length}):\n  ${fmt(newLive)}\n`);
  console.log(
    `new but already delisted — sync skips, never worth a row (${newDead.length}):\n  ${fmt(newDead)}\n`,
  );
  console.log(
    `in the catalogue but delisted upstream — sync will flag (${nowDelisted.length}):\n  ${fmt(nowDelisted)}\n`,
  );
  if (notOnHl.length > 0) {
    console.log(`rows with no HL market at all (${notOnHl.length}):\n  ${fmt(notOnHl)}\n`);
  }

  const all = [...rows.values()];
  const liveRows = all.filter((r) => !r.delisted_at);
  console.log(
    `editorial coverage, live rows only (${liveRows.length}):\n` +
      `  named            ${liveRows.filter((r) => r.name).length}\n` +
      `  described        ${liveRows.filter((r) => r.description).length}\n` +
      `  earnings vetted  ${liveRows.filter((r) => r.reports_earnings !== null).length}` +
      ` (${liveRows.filter((r) => r.reports_earnings === true).length} report)`,
  );
}

async function sync(dryRun: boolean): Promise<void> {
  const [hl, rows, app] = await Promise.all([hlUniverse(), loadRows(), bundled()]);
  const db = supabaseAdmin();

  const inserts = hl
    .filter((m) => !m.isDelisted && !rows.has(m.ticker))
    .map((m) => {
      const b = app.get(m.ticker);
      const { kind } = classify(m.ticker, b);
      return {
        row: {
          dex: config.hyperliquid.dex,
          hl_coin: m.coin,
          ticker: m.ticker,
          name: b?.name ?? null,
          kind,
          description: b?.description ?? null,
          description_source: b?.description ? "manual" : null,
          description_updated_at: b?.description ? new Date().toISOString() : null,
          // Null stays null: an unrecognised market is unvetted, not "no".
          reports_earnings: b?.isEquity ?? null,
        },
        known: b !== undefined,
      };
    });

  const delisted = hl
    .filter((m) => m.isDelisted && rows.has(m.ticker) && !rows.get(m.ticker)!.delisted_at)
    .map((m) => rows.get(m.ticker)!);

  console.log(`inserting ${inserts.length} new live markets:`);
  for (const { row, known } of inserts) {
    console.log(
      `  ${row.ticker.padEnd(10)} ${row.kind.padEnd(7)} ` +
        `earnings=${String(row.reports_earnings).padEnd(5)} ` +
        `${known ? "" : "UNKNOWN to the app bundle — needs a name, kind and vetting"}` +
        `${known ? (row.name ?? "") : ""}`,
    );
  }
  console.log(`\nflagging ${delisted.length} rows delisted upstream:\n  ${fmt(delisted.map((r) => r.ticker))}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing written");
    return;
  }

  if (inserts.length > 0) {
    const { error } = await db.from("assets").insert(inserts.map((i) => i.row));
    if (error) throw new Error(`insert failed: ${error.message}`);
  }
  if (delisted.length > 0) {
    const now = new Date().toISOString();
    const { error } = await db
      .from("assets")
      .update({ delisted_at: now })
      .in("id", delisted.map((r) => r.id));
    if (error) throw new Error(`delist update failed: ${error.message}`);
  }
  console.log(`\ndone: +${inserts.length} rows, ${delisted.length} delisted`);

  const unvetted = inserts.filter((i) => i.row.reports_earnings === null);
  if (unvetted.length > 0) {
    console.log(
      `\nneeds you: ${unvetted.map((i) => i.row.ticker).join(" ")} — ` +
        `set kind and reports_earnings by hand`,
    );
  }
}

/**
 * Backfill the editorial layer onto rows that predate it, from the app bundle.
 * Only fills blanks — anything already set in the database wins, so this is
 * safe to re-run and never overwrites an edit made since.
 */
async function seed(dryRun: boolean): Promise<void> {
  const [rows, app] = await Promise.all([loadRows(), bundled()]);
  const db = supabaseAdmin();
  const now = new Date().toISOString();

  const patches: Array<{ id: string; ticker: string; patch: Record<string, unknown> }> = [];
  for (const [ticker, row] of rows) {
    const b = app.get(ticker);
    if (!b) continue;
    const patch: Record<string, unknown> = {};
    if (!row.name && b.name) patch.name = b.name;
    if (!row.description && b.description) {
      patch.description = b.description;
      patch.description_source = "manual";
      patch.description_updated_at = now;
    }
    if (row.reports_earnings === null && b.isEquity !== null) {
      patch.reports_earnings = b.isEquity;
    }
    if (Object.keys(patch).length > 0) patches.push({ id: row.id, ticker, patch });
  }

  console.log(`${patches.length} rows to fill (of ${rows.size}):`);
  for (const p of patches) {
    console.log(`  ${p.ticker.padEnd(10)} ${Object.keys(p.patch).join(", ")}`);
  }
  if (dryRun) {
    console.log("\n--dry-run: nothing written");
    return;
  }
  for (const p of patches) {
    const { error } = await db.from("assets").update(p.patch).eq("id", p.id);
    if (error) throw new Error(`seeding ${p.ticker} failed: ${error.message}`);
  }
  console.log(`\ndone: ${patches.length} rows filled`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith("--")) ?? "status";
  const dryRun = argv.includes("--dry-run");

  switch (cmd) {
    case "status":
      await status();
      break;
    case "sync":
      await sync(dryRun);
      break;
    case "seed":
      await seed(dryRun);
      break;
    default:
      console.error(`unknown command: ${cmd}\nusage: intake <status|sync|seed> [--dry-run]`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
