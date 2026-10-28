import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MarketQuote } from "./hyperliquid.js";

/** Query-builder stand-in: records each awaited chain, answers via `respond`. */
interface Call {
  table: string;
  op: string;
  payload?: unknown;
}
let calls: Call[] = [];
let respond: (c: Call) => { data: unknown; error: null | { message: string } };

function builder(table: string) {
  const call: Call = { table, op: "select" };
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "in"]) chain[m] = () => chain;
  chain.upsert = (payload: unknown) => {
    call.op = "upsert";
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
vi.mock("./hyperliquid.js", () => ({ fetchMarketQuotes: vi.fn() }));

const { bigMoves, crossedThresholds, priceMoveMessage, detectPriceMoves } = await import("./priceMoves.js");
const { notifyMany } = await import("./notify.js");
const { fetchMarketQuotes } = await import("./hyperliquid.js");

function quote(coin: string, markPx: number, prevDayPx: number | null, isDelisted = false): MarketQuote {
  return { coin, markPx, prevDayPx, isDelisted };
}

type Row = { user_id: string; coin: string; direction: string; threshold: number };

/** A DB where `sent` alerts already exist and `watch` maps tickers to watchers. */
function db(watch: Record<string, string[]>, sent: Row[] = []) {
  respond = (c) => {
    if (c.table === "watchlist") {
      const rows = Object.entries(watch).flatMap(([ticker, users]) =>
        users.map((user_id) => ({ user_id, ticker })),
      );
      return { data: rows, error: null };
    }
    if (c.op === "upsert") {
      const same = (a: Row, b: Row) =>
        a.user_id === b.user_id && a.coin === b.coin && a.direction === b.direction && a.threshold === b.threshold;
      const rows = (c.payload as Row[]).filter((r) => !sent.some((s) => same(s, r)));
      return { data: rows, error: null };
    }
    return { data: sent, error: null };
  };
}

beforeEach(() => {
  calls = [];
  vi.mocked(notifyMany).mockClear();
});

describe("crossedThresholds", () => {
  it("counts rises and drops alike", () => {
    expect(crossedThresholds(0.099)).toEqual([]);
    expect(crossedThresholds(0.1)).toEqual([10]);
    expect(crossedThresholds(-0.15)).toEqual([10]);
    expect(crossedThresholds(-0.25)).toEqual([10, 20]);
  });
});

describe("bigMoves", () => {
  it("skips small moves, delisted markets and missing references", () => {
    const quotes = new Map(
      [
        quote("NVDA", 111.2, 100),
        quote("TSLA", 105, 100),
        quote("OLD", 50, 100, true),
        quote("NEW", 50, null),
      ].map((q) => [q.coin, q]),
    );
    const moves = bigMoves(quotes);
    expect(moves.map((m) => m.coin)).toEqual(["NVDA"]);
    expect(moves[0]!.change).toBeCloseTo(0.112);
  });
});

describe("priceMoveMessage", () => {
  it("reports the move to one decimal", () => {
    expect(priceMoveMessage("NVDA", 0.112)).toEqual({
      title: "NVDA up 11.2% today",
      body: "NVDA is up 11.2% in the last 24 hours.",
    });
    expect(priceMoveMessage("NVDA", -0.2049).title).toBe("NVDA down 20.5% today");
  });
});

describe("detectPriceMoves", () => {
  it("pushes each watcher once, for the furthest threshold reached", async () => {
    vi.mocked(fetchMarketQuotes).mockResolvedValue(new Map([["NVDA", quote("NVDA", 75, 100)]]));
    db({ NVDA: ["u1", "u2"] });

    const result = await detectPriceMoves();

    expect(result).toEqual({ moves: 1, notified: 2 });
    const upsert = calls.find((c) => c.op === "upsert")!;
    expect(upsert.payload as Row[]).toHaveLength(4); // 10 and 20, for each watcher
    const sent = vi.mocked(notifyMany).mock.calls[0]![0];
    expect(sent.map((s) => s.userId).sort()).toEqual(["u1", "u2"]);
    expect(sent[0]).toMatchObject({ kind: "price_move", title: "NVDA down 25.0% today", route: "asset:NVDA" });
  });

  it("sends the 20% push to someone who already had today's 10%", async () => {
    vi.mocked(fetchMarketQuotes).mockResolvedValue(new Map([["NVDA", quote("NVDA", 121, 100)]]));
    db({ NVDA: ["u1"] }, [{ user_id: "u1", coin: "NVDA", direction: "up", threshold: 10 }]);

    await detectPriceMoves();

    const upsert = calls.find((c) => c.op === "upsert")!;
    expect((upsert.payload as Row[]).map((r) => r.threshold)).toEqual([20]);
    expect(vi.mocked(notifyMany).mock.calls[0]![0]).toHaveLength(1);
  });

  it("sends nothing once today's thresholds are recorded", async () => {
    vi.mocked(fetchMarketQuotes).mockResolvedValue(new Map([["NVDA", quote("NVDA", 112, 100)]]));
    db({ NVDA: ["u1"] }, [{ user_id: "u1", coin: "NVDA", direction: "up", threshold: 10 }]);

    expect(await detectPriceMoves()).toEqual({ moves: 1, notified: 0 });
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
    expect(notifyMany).not.toHaveBeenCalled();
  });

  it("does no database work on a quiet day", async () => {
    vi.mocked(fetchMarketQuotes).mockResolvedValue(new Map([["NVDA", quote("NVDA", 103, 100)]]));
    db({});
    expect(await detectPriceMoves()).toEqual({ moves: 0, notified: 0 });
    expect(calls).toHaveLength(0);
  });
});
