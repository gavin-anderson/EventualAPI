import { describe, it, expect, vi } from "vitest";

/**
 * With no APNS_* vars the service must keep working: the inbox row is still
 * written and the push is skipped, not attempted or thrown.
 */
const inserts: unknown[] = [];

function builder(table: string) {
  const result =
    table === "device_tokens"
      ? { data: [{ token: "abc", environment: "sandbox" }], error: null }
      : { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "range"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.insert = async (row: unknown) => {
    inserts.push(row);
    return { error: null };
  };
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

vi.mock("./supabase.js", () => ({ supabaseAdmin: () => ({ from: builder }) }));
vi.mock("./apns.js", () => ({ sendPush: vi.fn() }));
vi.mock("../config/env.js", async (importActual) => {
  const { config } = await importActual<typeof import("../config/env.js")>();
  return { config: { ...config, apns: { ...config.apns, configured: false } } };
});

const { notify } = await import("./notify.js");
const { sendPush } = await import("./apns.js");

describe("notify without APNs credentials", () => {
  it("writes the inbox row and skips the push", async () => {
    const outcome = await notify({
      userId: "did:privy:someone",
      kind: "position_liquidated",
      title: "NVDA long liquidated",
      body: "Your NVDA long was liquidated.",
    });

    expect(outcome).toEqual({ delivered: false, reason: "push_not_configured", devices: 1 });
    expect(sendPush).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ pushed_at: null, push_error: "apns not configured" });
  });
});
