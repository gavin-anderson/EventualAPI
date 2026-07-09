import { supabaseAdmin } from "./supabase.js";
import type { VerifiedPrivyIdentity } from "./authBridge.js";

export interface Profile {
  id: string;
  wallet_address: string | null;
  display_name: string | null;
  image_ref: string | null;
  region: string | null;
  eligibility: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Lazily create-or-fetch the caller's profile, keyed by Privy DID. Runs with the
 * service role (bypasses RLS) since it is a trusted server operation. No Privy
 * webhook is needed — the row appears on the user's first authenticated call.
 */
export async function upsertProfile(
  identity: VerifiedPrivyIdentity,
): Promise<Profile> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("profiles")
    .upsert(
      {
        id: identity.privyDid,
        ...(identity.wallet ? { wallet_address: identity.wallet } : {}),
      },
      { onConflict: "id", ignoreDuplicates: false },
    )
    .select()
    .single();

  if (error) {
    throw new Error(`profile upsert failed: ${error.message}`);
  }
  return data as Profile;
}
