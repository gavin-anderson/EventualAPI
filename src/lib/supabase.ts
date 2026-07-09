import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config/env.js";

/**
 * Server-side Supabase client using the SERVICE ROLE key. This bypasses RLS and
 * is used only for trusted server operations (e.g. the lazy profile upsert in
 * /v1/profile). Never expose this key or this client to the app.
 *
 * Created lazily and only when Supabase is configured, so the public read tier
 * runs fine with no Supabase secrets present.
 */
let _admin: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!config.supabase.configured) {
    throw new Error("supabase_not_configured");
  }
  if (!_admin) {
    _admin = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }
  return _admin;
}
