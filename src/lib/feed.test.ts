import { describe, it, expect, vi } from "vitest";

/** Records the ordering and filters applied to the feed query. */
const applied: [string, ...unknown[]][] = [];

function builder() {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "order", "range", "eq"]) {
    chain[m] = (...args: unknown[]) => {
      applied.push([m, ...args]);
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
  return chain;
}

vi.mock("./supabase.js", () => ({ supabaseAdmin: () => ({ from: builder }) }));

const { readFeed } = await import("./feed.js");

describe("readFeed", () => {
  it("ranks by position value, then newest take, then id", async () => {
    await readFeed({ coin: "NVDA", limit: 20, offset: 40 });

    expect(applied.filter((a) => a[0] === "order")).toEqual([
      ["order", "notional", { ascending: false }],
      ["order", "posted_at", { ascending: false }],
      ["order", "id", { ascending: false }],
    ]);
    expect(applied).toContainEqual(["range", 40, 59]);
    expect(applied).toContainEqual(["eq", "coin", "NVDA"]);
  });
});
