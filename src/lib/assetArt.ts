import { createHash } from "node:crypto";
import { config } from "../config/env.js";

/**
 * Asset art: storage paths in, public URLs out.
 *
 * `assets.icon_ref` and `assets.card_ref` hold a path inside the public
 * `asset-logos` bucket, not a URL. The bucket and the project URL are
 * deployment details, so storing them in a row would mean rewriting every row
 * to move buckets.
 *
 * WHY PATHS ARE CONTENT-HASHED (`cards/NVDA-a1b2c3d4.webp`): the ref is stored
 * rather than derived from the ticker, which means new art can land at a NEW
 * path and the row simply points at it. No CDN invalidation, ever, and the
 * objects can be served `immutable` with a one-year max-age. A ticker-keyed
 * path would have forced either a short TTL or a purge step on every art change.
 */

export const ART_BUCKET = "asset-logos";

/**
 * One year, immutable — safe only because paths are content-hashed.
 *
 * This is NOT a full header. Supabase Storage interpolates the value it is
 * given into `public, max-age=${value}`, so passing a complete header here
 * yields the nested, invalid `max-age=public, max-age=...` and the object stops
 * being cacheable at all. Only the part after `max-age=` belongs here.
 */
export const ART_CACHE_CONTROL = "31536000, immutable";

/** First 8 hex chars of the content's SHA-256. Short enough to read in a path. */
export function artHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

export function iconPath(ticker: string, hash: string, ext: string): string {
  return `icons/${ticker.toUpperCase()}-${hash}.${ext}`;
}

export function cardPath(ticker: string, hash: string): string {
  return `cards/${ticker.toUpperCase()}-${hash}.webp`;
}

/**
 * Turn a stored ref into something the app can load.
 *
 * Returns null for a null ref so the caller can pass it straight through — the
 * app already treats missing art as normal and falls back to a logo tile, so a
 * null here is a layout decision, not an error.
 *
 * An absolute URL is returned unchanged, which keeps the door open to art
 * hosted somewhere other than our bucket without a schema change.
 */
export function artUrl(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  if (!config.supabase.configured) return null;
  const base = config.supabase.url.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${ART_BUCKET}/${ref}`;
}

/** The art block returned to the app. Both sides nullable, independently. */
export interface AssetArt {
  iconUrl: string | null;
  cardUrl: string | null;
}

export function assetArt(row: {
  icon_ref?: string | null;
  card_ref?: string | null;
}): AssetArt {
  return { iconUrl: artUrl(row.icon_ref), cardUrl: artUrl(row.card_ref) };
}
