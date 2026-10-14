import { config } from "../config/env.js";

/**
 * Avatars the user uploads.
 *
 * DEFAULT avatars are not handled here, deliberately. The app draws its own —
 * an animal glyph on a green tile, picked by hashing a seed (`AvatarView`) —
 * and that needs no server involvement, no storage and no bytes over the wire.
 * A user has an avatar from the moment they exist; this file only covers
 * replacing it with a photo of their own.
 */

export const AVATAR_BUCKET = "avatars";

/** Square, and large enough for the 88pt account sheet at 3x. */
export const AVATAR_SIZE = 512;

/**
 * One hour, and deliberately NOT `immutable` — unlike company art.
 *
 * Paths are content-hashed, so a *replacement* is visible immediately at its new
 * path and a long TTL would be free. Deletion is the problem: the bucket is
 * public and behind a CDN, so an object removed from storage keeps being served
 * from cache until its TTL expires. Measured: after deleting the object, the URL
 * still returned 200 with a cache HIT.
 *
 * A year of that would mean "delete my photo" doesn't actually make the photo
 * unreachable. An hour bounds the window while still absorbing the repeat
 * fetches a feed page generates.
 *
 * As in `assetArt.ts`, this is a max-age value, not a full header.
 */
export const AVATAR_CACHE_CONTROL = "3600";

/**
 * A storage path for a user's own avatar.
 *
 * Namespaced by user so one person's delete can never orphan another's image,
 * and content-hashed within that so a replacement lands at a new path and is
 * visible at once, with no stale-cache window and nothing to invalidate.
 *
 * The DID is sanitised because it contains colons (`did:privy:abc`).
 */
export function avatarPath(privyDid: string, hash: string): string {
  const safe = privyDid.replace(/[^A-Za-z0-9]+/g, "-");
  return `${safe}/${hash}.webp`;
}

/**
 * Public URL for a stored avatar ref.
 *
 * Null means the user has not set a photo, which is not an error — the app
 * falls back to the avatar it draws itself.
 */
export function avatarUrl(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  if (!config.supabase.configured) return null;
  const base = config.supabase.url.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${AVATAR_BUCKET}/${ref}`;
}
