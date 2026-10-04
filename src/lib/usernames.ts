/**
 * Username rules — the server-side authority. Mirrors the iOS client's
 * `UsernameRules` so client-side validation matches what we accept.
 *
 * Uniqueness is NOT enforced here. An availability check followed by a write is
 * racy, so the unique index decides; see `claimUsername`.
 */

export const MIN_LENGTH = 3;
export const MAX_LENGTH = 20;

/**
 * Impersonation risks and route collisions. Server-side so it can change
 * without an App Store release — the client has its own stale copy.
 */
const RESERVED = new Set([
  "earnings", "admin", "support", "help", "official", "team", "staff",
  "moderator", "mod", "root", "system", "you", "null", "undefined",
  "api", "www", "app", "auth", "login", "logout", "signup", "settings",
  "profile", "profiles", "user", "users", "me", "about", "legal", "privacy",
  "terms", "security", "billing", "payments", "wallet", "hyperliquid",
  "privy", "supabase",
]);

export function normalizeUsername(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, MAX_LENGTH);
}

/** Nil when valid, else a short reason suitable for showing the user. */
export function usernameProblem(name: string): string | null {
  if (name.length < MIN_LENGTH) return `At least ${MIN_LENGTH} characters`;
  if (name.length > MAX_LENGTH) return `At most ${MAX_LENGTH} characters`;
  if (!/^[a-z]/.test(name)) return "Start with a letter";
  if (!/^[a-z0-9_]+$/.test(name)) return "Letters, numbers and underscores only";
  if (RESERVED.has(name)) return "That name isn't available";
  return null;
}

export function isReserved(name: string): boolean {
  return RESERVED.has(name.toLowerCase());
}
