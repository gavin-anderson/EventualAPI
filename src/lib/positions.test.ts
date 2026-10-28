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
  for (const m of ["eq", "is"]) {
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
  const run = () => {
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  chain.maybeSingle = run;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    run().then(resolve, reject);
  return chain;
}

vi.mock("./supabase.js", () => ({ supabaseAdmin: () => ({ from: builder }) }));

const { postTake } = await import("./positions.js");

const OPEN = "0x" + "a".repeat(32);
const CLOSE = "0x" + "b".repeat(32);
const row = { id: "p1", open_cloid: OPEN, close_cloid: CLOSE, open_take: null, close_take: null };

/** A DB holding `row`, found by whichever cloid column the lookup filters on. */
function db() {
  respond = (c) => {
    if (c.op === "update") return { data: { ...row, open_take: "Guide is what matters." }, error: null };
    const byCloid = c.filters.find((f) => f[1] === "open_cloid" || f[1] === "close_cloid");
    const hit = byCloid && (byCloid[1] === "open_cloid" ? row.open_cloid : row.close_cloid) === byCloid[2];
    return { data: hit ? row : null, error: null };
  };
}

beforeEach(() => {
  calls = [];
  db();
});

describe("postTake", () => {
  it("takes a take on an open", async () => {
    const result = await postTake("did:privy:u1", OPEN, "Guide is what matters.");
    expect(result).toMatchObject({ ok: true, kind: "open" });
    expect(calls.find((c) => c.op === "update")!.payload).toMatchObject({ open_take: "Guide is what matters." });
  });

  it("refuses a take on a close and writes nothing", async () => {
    const result = await postTake("did:privy:u1", CLOSE, "Here's how it went.");
    expect(result).toMatchObject({ ok: false, code: "close_takes_removed" });
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("refuses a cloid it has no trade for", async () => {
    const result = await postTake("did:privy:u1", "0x" + "c".repeat(32), "Hello.");
    expect(result).toMatchObject({ ok: false, code: "unknown_trade" });
  });
});
