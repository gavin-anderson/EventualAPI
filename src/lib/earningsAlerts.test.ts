import { describe, it, expect, vi, beforeEach } from "vitest";

/** Query-builder stand-in: records each awaited chain, answers via `respond`. */
interface Call {
  table: string;
  op: string;
  payload?: unknown;
  filters: [string, ...unknown[]][];
}
let calls: Call[] = [];
let respond: (c: Call) => { data: unknown; error: null | { message: string } };

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "is", "gt", "gte", "lte", "order", "limit"]) {
    chain[m] = (...args: unknown[]) => {
      call.filters.push([m, ...args]);
      return chain;
    };
  }
  chain.update = (payload: unknown) => {
    call.op = "update";
    call.payload = payload;
    return chain;
  };
  chain.select = () => chain;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    calls.push(call);
    return Promise.resolve(respond(call)).then(resolve, reject);
  };
  return chain;
}

vi.mock("./supabase.js", () => ({ supabaseAdmin: () => ({ from: builder }) }));
vi.mock("./notify.js", () => ({
  notifyMany: vi.fn(async (inputs: unknown[]) => ({ delivered: inputs.length, failed: 0 })),
}));

const { notifyReleasedEarnings, releaseMessage } = await import("./earningsAlerts.js");
const { notifyMany } = await import("./notify.js");

const EVENT = { id: "ev1", assets: { ticker: "NVDA", name: "NVIDIA" } };

beforeEach(() => {
  calls = [];
  vi.mocked(notifyMany).mockClear();
});

describe("releaseMessage", () => {
  it("names the company, falling back to the ticker", () => {
    expect(releaseMessage("NVDA", "NVIDIA")).toEqual({
      title: "NVDA earnings are out",
      body: "NVIDIA just reported. Tap to see the reaction.",
    });
    expect(releaseMessage("NVDA", null).body).toBe("NVDA just reported. Tap to see the reaction.");
  });
});

describe("notifyReleasedEarnings", () => {
  it("claims the event, then pushes every profile across pages", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `u${String(i).padStart(4, "0")}` }));
    const page2 = [{ id: "u9999" }];
    respond = (c) => {
      if (c.table === "earnings_events" && c.op === "select") return { data: [EVENT], error: null };
      if (c.table === "earnings_events" && c.op === "update") return { data: [{ id: "ev1" }], error: null };
      const after = c.filters.find((f) => f[0] === "gt")?.[2];
      return { data: after === "" ? page1 : page2, error: null };
    };

    expect(await notifyReleasedEarnings()).toBe(1);

    // The claim is conditional on not having been sent.
    const claim = calls.find((c) => c.op === "update")!;
    expect(claim.filters).toContainEqual(["is", "released_notified_at", null]);

    const sent = vi.mocked(notifyMany).mock.calls.flatMap(([inputs]) => inputs);
    expect(sent).toHaveLength(1001);
    expect(sent[0]).toMatchObject({
      userId: "u0000",
      kind: "earnings_confirmed",
      title: "NVDA earnings are out",
      route: "asset:NVDA",
    });
    // Second page resumes after the last id of the first.
    expect(calls.filter((c) => c.table === "profiles")[1]!.filters).toContainEqual(["gt", "id", "u0999"]);
  });

  it("sends nothing when another run already claimed the event", async () => {
    respond = (c) => {
      if (c.table === "earnings_events" && c.op === "select") return { data: [EVENT], error: null };
      return { data: [], error: null };
    };

    expect(await notifyReleasedEarnings()).toBe(0);
    expect(notifyMany).not.toHaveBeenCalled();
    expect(calls.some((c) => c.table === "profiles")).toBe(false);
  });
});
