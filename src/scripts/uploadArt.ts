/**
 * One-time migration: move the app's bundled company art into Supabase Storage
 * and write the refs back onto `assets`.
 *
 * Run locally, not on a schedule — it reads the iOS asset catalogue, which only
 * exists in a checkout of the mobile repo.
 *
 *   npm run art -- --dry-run                 # report what would happen
 *   npm run art                              # convert, upload, write refs
 *   npm run art -- NVDA TSLA                 # just these tickers
 *   npm run art -- --force                   # re-upload when only headers changed
 *   npm run art -- --catalogue=<path>        # non-default checkout location
 *
 * Cards are converted to WebP on the way through (they average ~1.0 MB as PNGs
 * and there is no reason to serve that). SVG icons are uploaded untouched — a
 * few KB at most, and already resolution-independent.
 *
 * Idempotent: the destination path contains a hash of the content, so a second
 * run computes the same path, sees the row already points there, and skips.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { supabaseAdmin } from "../lib/supabase.js";
import {
  ART_BUCKET,
  ART_CACHE_CONTROL,
  artHash,
  cardPath,
  iconPath,
} from "../lib/assetArt.js";

/** Default location of the iOS asset catalogue, relative to this repo. */
const DEFAULT_CATALOGUE = resolve(
  process.cwd(),
  "../earningsMobile/Earnings/Earnings/Assets.xcassets",
);

/**
 * Imagesets that are app chrome rather than company art. These are named like
 * assets but are onboarding screens and launch images, and uploading them would
 * put 4.7 MB of unrelated art in the bucket.
 */
const NOT_COMPANY_ART = /^(Onboarding|Launch|AppIcon|Accent)/i;

/** WebP quality for cards. 82 is visually indistinguishable at card size. */
const CARD_QUALITY = 82;
const ICON_QUALITY = 90;

interface Found {
  ticker: string;
  kind: "icon" | "card";
  file: string;
  ext: string;
  bytes: number;
}

/** Walk the asset catalogue and classify every imageset we care about. */
async function discover(catalogue: string): Promise<Found[]> {
  const out: Found[] = [];
  for (const entry of await readdir(catalogue)) {
    if (!entry.endsWith(".imageset")) continue;
    const stem = entry.slice(0, -".imageset".length);
    if (NOT_COMPANY_ART.test(stem)) continue;

    const isCard = stem.endsWith("-card");
    const ticker = (isCard ? stem.slice(0, -"-card".length) : stem).toUpperCase();
    // Tickers are uppercase alphanumerics. Anything else is app chrome we
    // haven't named in NOT_COMPANY_ART.
    if (!/^[A-Z0-9]{1,16}$/.test(ticker)) continue;

    const dir = join(catalogue, entry);
    const images = (await readdir(dir)).filter((f) => /\.(png|svg|jpg)$/i.test(f));
    // Multi-scale sets (@2x/@3x) only occur in app chrome, which is filtered
    // out above; take the first image otherwise.
    const file = images.find((f) => !/@[23]x\./.test(f)) ?? images[0];
    if (!file) continue;

    const path = join(dir, file);
    out.push({
      ticker,
      kind: isCard ? "card" : "icon",
      file: path,
      ext: (file.split(".").pop() ?? "").toLowerCase(),
      bytes: (await stat(path)).size,
    });
  }
  return out.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.kind.localeCompare(b.kind));
}

/**
 * Convert to the format we serve. SVG passes through: it is already small and
 * scalable, and rasterising it would be a downgrade.
 */
async function encode(item: Found): Promise<{ body: Uint8Array; ext: string }> {
  const raw = await readFile(item.file);
  if (item.ext === "svg") return { body: raw, ext: "svg" };
  const quality = item.kind === "card" ? CARD_QUALITY : ICON_QUALITY;
  const body = await sharp(raw).webp({ quality, effort: 5 }).toBuffer();
  return { body, ext: "webp" };
}

interface Row {
  id: string;
  ticker: string;
  icon_ref: string | null;
  card_ref: string | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  // Re-upload even when the ref matches — needed when only the object's
  // metadata (e.g. Cache-Control) has to change, since the content hash,
  // and therefore the path, is unchanged.
  const force = argv.includes("--force");
  const catalogue = resolve(
    argv.find((a) => a.startsWith("--catalogue="))?.split("=")[1] ?? DEFAULT_CATALOGUE,
  );
  const only = new Set(
    argv.filter((a) => !a.startsWith("--")).map((t) => t.toUpperCase()),
  );

  const db = supabaseAdmin();
  const { data, error } = await db.from("assets").select("id, ticker, icon_ref, card_ref");
  if (error) throw new Error(`reading assets failed: ${error.message}`);
  const rows = new Map((data as Row[]).map((r) => [r.ticker.toUpperCase(), r]));

  let found = await discover(catalogue);
  if (only.size > 0) found = found.filter((f) => only.has(f.ticker));

  console.log(
    `catalogue: ${catalogue}\n` +
      `found ${found.length} images (${found.filter((f) => f.kind === "card").length} cards, ` +
      `${found.filter((f) => f.kind === "icon").length} icons)\n` +
      `assets rows: ${rows.size}${dryRun ? "\n--dry-run: nothing will be written" : ""}\n`,
  );

  // Art for a ticker with no row is reported, not uploaded. Creating the row is
  // the intake script's job, and it needs a `kind` nobody can infer here.
  const orphans = [...new Set(found.filter((f) => !rows.has(f.ticker)).map((f) => f.ticker))];

  let uploaded = 0;
  let skipped = 0;
  let savedBytes = 0;
  const patches = new Map<string, { icon_ref?: string; card_ref?: string }>();

  for (const item of found) {
    const row = rows.get(item.ticker);
    if (!row) continue;

    const { body, ext } = await encode(item);
    const hash = artHash(body);
    const path =
      item.kind === "card" ? cardPath(item.ticker, hash) : iconPath(item.ticker, hash, ext);
    const current = item.kind === "card" ? row.card_ref : row.icon_ref;

    if (current === path && !force) {
      skipped += 1;
      continue;
    }

    savedBytes += item.bytes - body.byteLength;
    const pct = Math.round((1 - body.byteLength / item.bytes) * 100);
    console.log(
      `${item.ticker.padEnd(10)} ${item.kind.padEnd(5)} ` +
        `${(item.bytes / 1024).toFixed(0).padStart(5)}KB -> ` +
        `${(body.byteLength / 1024).toFixed(0).padStart(5)}KB (${pct > 0 ? "-" : "+"}${Math.abs(pct)}%)  ${path}`,
    );

    if (!dryRun) {
      const { error: upErr } = await db.storage.from(ART_BUCKET).upload(path, body, {
        contentType: ext === "svg" ? "image/svg+xml" : "image/webp",
        cacheControl: ART_CACHE_CONTROL,
        // Same path means same content, so a re-upload is a no-op either way.
        upsert: true,
      });
      if (upErr) throw new Error(`upload ${path} failed: ${upErr.message}`);
    }

    const patch = patches.get(row.id) ?? {};
    if (item.kind === "card") patch.card_ref = path;
    else patch.icon_ref = path;
    patches.set(row.id, patch);
    uploaded += 1;
  }

  if (!dryRun) {
    for (const [id, patch] of patches) {
      const { error: wErr } = await db.from("assets").update(patch).eq("id", id);
      if (wErr) throw new Error(`writing refs for ${id} failed: ${wErr.message}`);
    }
  }

  console.log(
    `\n${dryRun ? "would upload" : "uploaded"} ${uploaded}, skipped ${skipped} (ref already current)` +
      `\nrows ${dryRun ? "that would be" : ""} updated: ${patches.size}` +
      `\nsize change: ${(savedBytes / 1e6).toFixed(1)} MB smaller`,
  );
  if (orphans.length > 0) {
    console.log(
      `\nart with no assets row (${orphans.length}) — run the intake script first:\n  ${orphans.join(" ")}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
