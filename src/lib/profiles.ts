import { supabaseAdmin } from "./supabase.js";
import type { VerifiedPrivyIdentity } from "./authBridge.js";
import { fetchEmbeddedWallet } from "./privy.js";
import { normalizeUsername, usernameProblem } from "./usernames.js";
import { logger } from "./logger.js";
import { config } from "../config/env.js";

/** Postgres unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

const PROFILE_COLUMNS =
  "id, wallet_address, username, display_name, image_ref, region, eligibility, created_at, updated_at";

export interface Profile {
  id: string;
  wallet_address: string | null;
  /** Public handle, and the referral code. Null until onboarding claims one. */
  username: string | null;
  display_name: string | null;
  image_ref: string | null;
  region: string | null;
  eligibility: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface BootstrapResult {
  profile: Profile;
  /** True when this call created the row — i.e. a genuine first sign-up. */
  created: boolean;
  /** Why the wallet is null, when it is — ops problem vs still provisioning. */
  walletStatus: "resolved" | "unresolved" | "not_configured";
}

/**
 * Create-or-fetch the caller's profile, keyed by Privy DID. Idempotent, so it
 * serves both sign-up and every-launch bootstrap.
 *
 * Service role, because it writes columns the user deliberately cannot write
 * themselves (`username`) — otherwise the rules in `usernames.ts` could be
 * bypassed through the Data API.
 */
export async function bootstrapProfile(
  identity: VerifiedPrivyIdentity,
): Promise<BootstrapResult> {
  const db = supabaseAdmin();
  const did = identity.privyDid;

  // Null when unconfigured or still provisioning; neither blocks sign-up.
  const wallet = identity.wallet ?? (await fetchEmbeddedWallet(did));

  const existing = await selectProfile(db, did);
  if (existing) {
    const patched = await backfill(db, existing, wallet);
    return { profile: patched, created: false, walletStatus: statusOf(patched.wallet_address) };
  }

  const { data, error } = await db
    .from("profiles")
    .insert({ id: did, ...(wallet ? { wallet_address: wallet } : {}) })
    .select(PROFILE_COLUMNS)
    .single();

  if (!error && data) {
    return {
      profile: data as Profile,
      created: true,
      walletStatus: statusOf((data as Profile).wallet_address),
    };
  }

  // Two concurrent first calls raced; the other won. Read its row and carry on.
  if (error?.code === UNIQUE_VIOLATION) {
    const raced = await selectProfile(db, did);
    if (raced) {
      const patched = await backfill(db, raced, wallet);
      return {
        profile: patched,
        created: false,
        walletStatus: statusOf(patched.wallet_address),
      };
    }
  }

  throw new Error(`profile insert failed: ${error?.message ?? "unknown"}`);
}

/** Fill in anything a pre-existing row is missing, without clobbering. */
async function backfill(
  db: ReturnType<typeof supabaseAdmin>,
  profile: Profile,
  wallet: string | null,
): Promise<Profile> {
  const patch: Record<string, unknown> = {};

  // Only fill an absent wallet. Overwriting would silently re-point everything
  // joined to it (positions, fee attribution) as a side effect of signing in.
  if (wallet && !profile.wallet_address) patch.wallet_address = wallet;
  if (wallet && profile.wallet_address && profile.wallet_address !== wallet) {
    logger.warn(
      { did: profile.id, stored: profile.wallet_address, resolved: wallet },
      "privy wallet differs from stored wallet_address; leaving stored value alone",
    );
  }

  if (Object.keys(patch).length === 0) return profile;

  const { data, error } = await db
    .from("profiles")
    .update(patch)
    .eq("id", profile.id)
    .select(PROFILE_COLUMNS)
    .single();

  if (error) {
    // Non-fatal: return what we have, next call retries.
    logger.warn({ err: error, did: profile.id }, "profile backfill failed");
    return profile;
  }
  return data as Profile;
}

async function selectProfile(
  db: ReturnType<typeof supabaseAdmin>,
  did: string,
): Promise<Profile | null> {
  const { data, error } = await db
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", did)
    .maybeSingle();
  if (error) throw new Error(`profile read failed: ${error.message}`);
  return (data as Profile | null) ?? null;
}

function statusOf(wallet: string | null): BootstrapResult["walletStatus"] {
  if (wallet) return "resolved";
  // An ops problem vs one that resolves itself.
  return config.privy.canResolveWallet ? "unresolved" : "not_configured";
}

// ── Usernames ─────────────────────────────────────────────────────────────────

export type Availability =
  | { available: true; username: string }
  | { available: false; username: string; reason: string };

/**
 * Availability *hint* — racy by construction, so it lights up a form and never
 * reserves a name. `claimUsername` is the authority.
 *
 * Checks the all-time namespace: a released name stays unavailable to everyone
 * but its original owner, since it may still circulate as a referral link.
 */
export async function checkUsername(raw: string, forUserId?: string): Promise<Availability> {
  const username = normalizeUsername(raw);
  const problem = usernameProblem(username);
  if (problem) return { available: false, username, reason: problem };

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("username_claims")
    .select("user_id")
    .eq("username_lower", username)
    .maybeSingle();
  if (error) throw new Error(`username check failed: ${error.message}`);

  const holder = (data as { user_id: string } | null)?.user_id;
  if (holder && holder !== forUserId) {
    return { available: false, username, reason: "Already taken" };
  }
  return { available: true, username };
}

export type ClaimResult =
  | { ok: true; profile: Profile }
  | { ok: false; reason: string; code: "taken" | "invalid" };

/**
 * Claim a username.
 *
 * The username doubles as the referral code, so uniqueness must hold across
 * *history*: handing a released name to someone else would redirect an old
 * link's fee share to them. `username_claims` is the append-only ledger that
 * prevents it; its primary key is the all-time atomic claim.
 *
 * Write order matters — take the new name BEFORE releasing the old one, or a
 * rejected claim leaves the user with no username. A failure in between is
 * recoverable: they keep the old name and a retry is idempotent.
 */
export async function claimUsername(privyDid: string, raw: string): Promise<ClaimResult> {
  const username = normalizeUsername(raw);
  const problem = usernameProblem(username);
  if (problem) return { ok: false, reason: problem, code: "invalid" };

  const db = supabaseAdmin();

  // 1. Take the name. The PK rejects the loser of a race.
  const { error: claimError } = await db
    .from("username_claims")
    .insert({ username_lower: username, user_id: privyDid });

  if (claimError) {
    if (claimError.code !== UNIQUE_VIOLATION) {
      throw new Error(`username claim failed: ${claimError.message}`);
    }
    // Only the original owner may take it back, which keeps "rename freely"
    // working without ever reassigning a name.
    const { data: holder, error: readError } = await db
      .from("username_claims")
      .select("user_id")
      .eq("username_lower", username)
      .maybeSingle();
    if (readError) throw new Error(`username claim failed: ${readError.message}`);

    if ((holder as { user_id: string } | null)?.user_id !== privyDid) {
      return { ok: false, reason: "Already taken", code: "taken" };
    }
    // Reclaiming a name this user previously released.
    await db
      .from("username_claims")
      .update({ released_at: null, claimed_at: new Date().toISOString() })
      .eq("username_lower", username);
  }

  // 2. Make it current; the unique index on lower(username) guards that.
  const { data, error } = await db
    .from("profiles")
    .update({ username })
    .eq("id", privyDid)
    .select(PROFILE_COLUMNS)
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { ok: false, reason: "Already taken", code: "taken" };
    }
    throw new Error(`username claim failed: ${error.message}`);
  }

  // 3. Retire the old name. Last because it is the only non-essential step: a
  //    failure leaves a stale row the next claim cleans up.
  const { error: releaseError } = await db
    .from("username_claims")
    .update({ released_at: new Date().toISOString() })
    .eq("user_id", privyDid)
    .is("released_at", null)
    .neq("username_lower", username);
  if (releaseError) {
    logger.warn(
      { err: releaseError, did: privyDid },
      "failed to retire previous username claim; namespace still safe",
    );
  }

  return { ok: true, profile: data as Profile };
}

/**
 * Resolve a referral code (a username) to its owner.
 *
 * Reads the ledger, not `profiles.username`, so a code still resolves after a
 * rename — an old link credits the original owner or nobody, never a stranger.
 *
 * Store the returned **user id** on attribution records, never the code string.
 */
export async function resolveReferralCode(raw: string): Promise<string | null> {
  const username = normalizeUsername(raw);
  if (usernameProblem(username)) return null;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("username_claims")
    .select("user_id")
    .eq("username_lower", username)
    .maybeSingle();
  if (error) throw new Error(`referral code lookup failed: ${error.message}`);
  return (data as { user_id: string } | null)?.user_id ?? null;
}
