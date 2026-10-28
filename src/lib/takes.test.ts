import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClearinghouseState } from "./hyperliquid.js";

/** Query-builder stand-in: records each awaited chain, answers via `respond`. */
interface Call {
  table: string;
  op: string;
  payload?: unknown;
  filters: [string, ...unknown[]][];
}
let calls: Call[] = [];
let respond: (c: Call) => { data: unknown; error: null | { message: string; code?: string } };

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "is", "lte", "order", "limit"]) {
    chain[m] = (...args: unknown[]) => {
      call.filters.push([m, ...args]);
      return chain;
    };
  }
  for (const op of ["update", "insert"]) {
    chain[op] = (payload: unknown) => {
      call.op = op;
      call.payload = payload;
      return chain;
    };
  }
  chain.select = () => chain;
  const run = () => {
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  chain.maybeSingle = run;
  chain.single = run;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    run().then(resolve, reject);
  return chain;
}

vi.mock("./supabase.js", () => ({ supabaseAdmin: () => ({ from: builder }) }));
vi.mock("./hyperliquid.js", async (importActual) => ({
  ...(await importActual<typeof import("./hyperliquid.js")>()),
  fetchClearinghouseState: vi.fn(),
}));

const { heldPosition, changeReason, postTake, editTake, removeLiveTake, reconcileWalletTakes } =
  await import("./takes.js");
const { fetchClearinghouseState } = await import("./hyperliquid.js");

const USER = "did:privy:u1";
const WALLET = "0xabc";

/** HL holding `szi` of xyz:NVDA (negative is short), or nothing. */
function holding(szi: string | null): ClearinghouseState {
  return {
    marginSummary: { accountValue: "0", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
    withdrawable: "0",
    time: 0,
    assetPositions: szi
      ? [
          {
            type: "oneWay",
            position: {
              coin: "xyz:NVDA",
              szi,
              entryPx: "200",
              positionValue: "0",
              unrealizedPnl: "0",
              returnOnEquity: "0",
              leverage: { type: "isolated", value: 5, rawUsd: "0" },
              maxLeverage: 20,
              marginUsed: "0",
              cumFunding: { allTime: "0", sinceOpen: "0" },
              liquidationPx: null,
            },
          },
        ]
      : [],
  };
}

const LIVE = {
  id: "t1",
  user_id: USER,
  wallet_address: WALLET,
  coin: "NVDA",
  position_id: null,
  side: "long",
  size: 2,
  entry_px: 200,
  leverage: 5,
  text: "Guide is what matters.",
  posted_at: "2026-10-28T12:00:00Z",
  edited_at: null,
  removed_at: null,
  removed_reason: null,
};

/** A DB whose live take on NVDA is `live` (or none). */
function db(live: typeof LIVE | null) {
  respond = (c) => {
    if (c.table === "positions") return { data: { id: "p1" }, error: null };
    if (c.op === "insert") return { data: { ...LIVE, id: "t2", ...(c.payload as object) }, error: null };
    if (c.op === "update") {
      const p = c.payload as Record<string, unknown>;
      return { data: p.text ? { ...LIVE, ...p } : [{ id: "t1" }], error: null };
    }
    return { data: live, error: null };
  };
}

beforeEach(() => {
  calls = [];
  vi.mocked(fetchClearinghouseState).mockReset();
});

describe("heldPosition", () => {
  it("reads side, size and entry for the bare coin", () => {
    expect(heldPosition(holding("-1.5"), "NVDA")).toEqual({ side: "short", size: 1.5, entryPx: 200, leverage: 5 });
    expect(heldPosition(holding("1"), "TSLA")).toBeNull();
    expect(heldPosition(holding(null), "NVDA")).toBeNull();
  });
});

describe("changeReason", () => {
  it("stands while side and size are unchanged", () => {
    expect(changeReason({ side: "long", size: 2 }, { side: "long", size: 2 })).toBeNull();
  });

  it("is closed when the position is gone, changed on a new size or side", () => {
    expect(changeReason({ side: "long", size: 2 }, null)).toBe("closed");
    expect(changeReason({ side: "long", size: 2 }, { side: "long", size: 3 })).toBe("changed");
    expect(changeReason({ side: "long", size: 2 }, { side: "short", size: 2 })).toBe("changed");
  });
});

describe("postTake", () => {
  it("snapshots the live position and links the app's row", async () => {
    vi.mocked(fetchClearinghouseState).mockResolvedValue(holding("2"));
    db(null);

    const result = await postTake(USER, WALLET, "NVDA", "Guide is what matters.");

    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.op === "insert")!.payload).toMatchObject({
      user_id: USER,
      coin: "NVDA",
      position_id: "p1",
      side: "long",
      size: 2,
      entry_px: 200,
      leverage: 5,
      text: "Guide is what matters.",
    });
  });

  it("refuses without an open position", async () => {
    vi.mocked(fetchClearinghouseState).mockResolvedValue(holding(null));
    db(null);
    expect(await postTake(USER, WALLET, "NVDA", "Hello.")).toMatchObject({ ok: false, code: "no_open_position" });
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("refuses a second take on the same position", async () => {
    vi.mocked(fetchClearinghouseState).mockResolvedValue(holding("2"));
    db(LIVE);
    expect(await postTake(USER, WALLET, "NVDA", "Again.")).toMatchObject({ ok: false, code: "already_posted" });
    expect(calls.some((c) => c.op === "insert" || c.op === "update")).toBe(false);
  });

  it("replaces a take whose position has since changed", async () => {
    vi.mocked(fetchClearinghouseState).mockResolvedValue(holding("3"));
    db(LIVE);

    const result = await postTake(USER, WALLET, "NVDA", "Added more.");

    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.op === "update")!.payload).toMatchObject({ removed_reason: "changed" });
    expect(calls.find((c) => c.op === "insert")!.payload).toMatchObject({ size: 3 });
  });
});

describe("editTake", () => {
  it("rewrites the live take and stamps edited_at", async () => {
    vi.mocked(fetchClearinghouseState).mockResolvedValue(holding("2"));
    db(LIVE);

    const result = await editTake(USER, WALLET, "NVDA", "Guide and margins.");

    expect(result).toMatchObject({ ok: true, take: { text: "Guide and margins." } });
    const edit = calls.find((c) => c.op === "update")!;
    expect(edit.payload).toMatchObject({ text: "Guide and margins." });
    expect((edit.payload as { edited_at: string }).edited_at).toBeTruthy();
    // Never revives a take removed in the meantime.
    expect(edit.filters).toContainEqual(["is", "removed_at", null]);
  });

  it("refuses when there is no live take", async () => {
    db(null);
    expect(await editTake(USER, WALLET, "NVDA", "Hi.")).toMatchObject({ ok: false, code: "no_live_take" });
    expect(fetchClearinghouseState).not.toHaveBeenCalled();
  });

  it("removes rather than edits a take whose position closed", async () => {
    vi.mocked(fetchClearinghouseState).mockResolvedValue(holding(null));
    db(LIVE);

    expect(await editTake(USER, WALLET, "NVDA", "Hi.")).toMatchObject({ ok: false, code: "position_changed" });
    const updates = calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({ removed_reason: "closed" });
  });
});

describe("removeLiveTake", () => {
  it("only removes takes posted before the event", async () => {
    db(null);
    const at = new Date("2026-10-28T13:00:00Z");
    expect(await removeLiveTake(USER, "NVDA", "liquidated", at)).toBe(1);
    const call = calls[0]!;
    expect(call.payload).toMatchObject({ removed_reason: "liquidated" });
    expect(call.filters).toContainEqual(["lte", "posted_at", at.toISOString()]);
  });
});

describe("reconcileWalletTakes", () => {
  it("removes takes whose position closed or changed, keeps the rest", async () => {
    respond = (c) =>
      c.op === "update"
        ? { data: null, error: null }
        : {
            data: [
              { id: "same", coin: "NVDA", side: "long", size: 2 },
              { id: "grown", coin: "TSLA", side: "short", size: 1 },
              { id: "gone", coin: "AAPL", side: "long", size: 4 },
            ],
            error: null,
          };

    const removed = await reconcileWalletTakes(WALLET, [
      { coin: "NVDA", side: "long", size: 2 },
      { coin: "TSLA", side: "short", size: 1.5 },
    ]);

    expect(removed).toBe(2);
    const updates = calls.filter((c) => c.op === "update");
    expect(updates.map((u) => [u.filters.find((f) => f[1] === "id")![2], (u.payload as { removed_reason: string }).removed_reason])).toEqual([
      ["grown", "changed"],
      ["gone", "closed"],
    ]);
  });
});
