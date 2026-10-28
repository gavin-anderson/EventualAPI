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
  for (const m of ["eq", "in", "gte"]) chain[m] = () => chain;
  chain.select = () => chain;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    calls.push(call);
    return Promise.resolve(respond(call)).then(resolve, reject);
  };
  return chain;
}

/** rpc() resolves like a chain, recorded as op "rpc" on the function name. */
function rpc(fn: string, args: { p_alerts: unknown }) {
  const call: Call = { table: fn, op: "rpc", payload: args.p_alerts };
  calls.push(call);
  return Promise.resolve(respond(call));
}

vi.mock("./supabase.js", () => ({ supabaseAdmin: () => ({ from: builder, rpc }) }));
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

/** A DB where `sent` alerts are cooling down and `watch` maps tickers to watchers. */
function db(watch: Record<string, string[]>, sent: Row[] = []) {
  respond = (c) => {
    if (c.table === "watchlist") {
      const rows = Object.entries(watch).flatMap(([ticker, users]) =>
        users.map((user_id) => ({ user_id, ticker })),
      );
      return { data: rows, error: null };
    }
    if (c.op === "rpc") {
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
    const claim = calls.find((c) => c.op === "rpc")!;
    expect(claim.payload as Row[]).toHaveLength(4); // 10 and 20, for each watcher
    const sent = vi.mocked(notifyMany).mock.calls[0]![0];
    expect(sent.map((s) => s.userId).sort()).toEqual(["u1", "u2"]);
    expect(sent[0]).toMatchObject({ kind: "price_move", title: "NVDA down 25.0% today", route: "asset:NVDA" });
  });

  it("sends the 20% push to someone whose 10% is still cooling down", async () => {
    vi.mocked(fetchMarketQuotes).mockResolvedValue(new Map([["NVDA", quote("NVDA", 121, 100)]]));
    db({ NVDA: ["u1"] }, [{ user_id: "u1", coin: "NVDA", direction: "up", threshold: 10 }]);

    await detectPriceMoves();

    const claim = calls.find((c) => c.op === "rpc")!;
    expect((claim.payload as Row[]).map((r) => r.threshold)).toEqual([20]);
    expect(vi.mocked(notifyMany).mock.calls[0]![0]).toHaveLength(1);
  });

  it("sends nothing while every crossed threshold is cooling down", async () => {
    vi.mocked(fetchMarketQuotes).mockResolvedValue(new Map([["NVDA", quote("NVDA", 112, 100)]]));
    db({ NVDA: ["u1"] }, [{ user_id: "u1", coin: "NVDA", direction: "up", threshold: 10 }]);

    expect(await detectPriceMoves()).toEqual({ moves: 1, notified: 0 });
    expect(calls.some((c) => c.op === "rpc")).toBe(false);
    expect(notifyMany).not.toHaveBeenCalled();
  });

  it("sends nothing when another run claimed first", async () => {
    vi.mocked(fetchMarketQuotes).mockResolvedValue(new Map([["NVDA", quote("NVDA", 112, 100)]]));
    db({ NVDA: ["u1"] });
    const base = respond;
    respond = (c) => (c.op === "rpc" ? { data: [], error: null } : base(c));

    expect(await detectPriceMoves()).toEqual({ moves: 1, notified: 0 });
    expect(calls.find((c) => c.op === "rpc")!.table).toBe("claim_price_move_alerts");
    expect(vi.mocked(notifyMany).mock.calls[0]![0]).toHaveLength(0);
  });

  it("does no database work on a quiet day", async () => {
    vi.mocked(fetchMarketQuotes).mockResolvedValue(new Map([["NVDA", quote("NVDA", 103, 100)]]));
    db({});
    expect(await detectPriceMoves()).toEqual({ moves: 0, notified: 0 });
    expect(calls).toHaveLength(0);
  });
});
