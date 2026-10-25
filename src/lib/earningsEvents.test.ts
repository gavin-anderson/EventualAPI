import { describe, it, expect } from "vitest";
import { buildEarningsEventRow, type EarningsRecord } from "./earningsEvents.js";
import { calendarRowToRecord } from "./earningsSource.js";
import { fiscalPeriod, releaseOn } from "./edgar.js";
import { parseCalendarCsv, AlphaVantageLimitError } from "./alphavantage.js";
import type { AvCalendarRow } from "./alphavantage.js";

function make(over: Partial<EarningsRecord>): EarningsRecord {
  return {
    date: "2026-07-15",
    exactTime: "16:05:00",
    session: null,
    confirmed: true,
    period: "Q3",
    periodYear: 2026,
    epsEstimate: 1.23,
    source: "edgar",
    ...over,
  };
}

describe("buildEarningsEventRow", () => {
  it("exact time → precision 'exact', DST-correct UTC, null session", () => {
    const r = buildEarningsEventRow("A1", make({}));
    expect(r.time_precision).toBe("exact");
    expect(r.session).toBeNull();
    expect(r.earnings_at).toBe("2026-07-15T20:05:00.000Z"); // 16:05 EDT = 20:05 UTC
    expect(r.expected_eps).toBe(1.23);
    expect(r.period).toBe("Q3");
    expect(r.period_year).toBe(2026);
    expect(r.is_confirmed).toBe(true);
  });

  it("session time → precision 'session' with default clock", () => {
    const r = buildEarningsEventRow("A1", make({ exactTime: null, session: "amc", confirmed: false }));
    expect(r.time_precision).toBe("session");
    expect(r.session).toBe("amc");
    expect(r.earnings_at).toBe("2026-07-15T20:00:00.000Z"); // 16:00 EDT default
  });
});

describe("fiscalPeriod", () => {
  it("uses the company's fiscal year (Apple ends late Sep)", () => {
    expect(fiscalPeriod("2026-09-30", "0926")).toEqual({ period: "Q4", periodYear: 2026 });
    expect(fiscalPeriod("2026-12-31", "0926")).toEqual({ period: "Q1", periodYear: 2027 });
  });

  it("handles a January year end (NVIDIA)", () => {
    expect(fiscalPeriod("2026-10-31", "0125")).toEqual({ period: "Q3", periodYear: 2027 });
  });

  it("treats a first-week year end as the previous month", () => {
    expect(fiscalPeriod("2026-12-31", "0102")).toEqual({ period: "Q4", periodYear: 2026 });
  });

  it("falls back to calendar quarters", () => {
    expect(fiscalPeriod("2026-03-31", null)).toEqual({ period: "Q1", periodYear: 2026 });
    expect(fiscalPeriod("2026-12-31", null)).toEqual({ period: "Q4", periodYear: 2026 });
  });
});

describe("releaseOn", () => {
  const releases = ["2026-10-29T20:05:12.000Z", "2026-10-22T13:07:12.000Z"];
  it("matches by ET calendar day", () => {
    expect(releaseOn(releases, "2026-10-29")).toBe("2026-10-29T20:05:12.000Z");
    expect(releaseOn(releases, "2026-10-28")).toBeNull();
  });
  it("uses the ET day, not the UTC day", () => {
    // 01:00 UTC on the 30th is 21:00 ET on the 29th.
    expect(releaseOn(["2026-10-30T01:00:00.000Z"], "2026-10-29")).toBe("2026-10-30T01:00:00.000Z");
  });
});

describe("parseCalendarCsv", () => {
  it("parses quoted names and the time-of-day column", () => {
    const rows = parseCalendarCsv(
      "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\r\n" +
        'ARLP,"ALLIANCE RESOURCE PARTNERS, L.P.",2026-10-26,2026-09-30,0.82,USD,pre-market\r\n' +
        "NVDA,NVIDIA CORP,2026-11-18,2026-10-31,,USD,\r\n",
    );
    expect(rows[0]).toMatchObject({ symbol: "ARLP", name: "ALLIANCE RESOURCE PARTNERS, L.P.", estimate: 0.82, timeOfTheDay: "pre-market" });
    expect(rows[1]).toMatchObject({ symbol: "NVDA", estimate: null, timeOfTheDay: "" });
  });

  it("throws on a JSON limit notice", () => {
    expect(() => parseCalendarCsv('{"Information": "rate limit"}')).toThrow(AlphaVantageLimitError);
  });
});

describe("calendarRowToRecord", () => {
  const row: AvCalendarRow = {
    symbol: "AAPL", name: "Apple", reportDate: "2026-10-29", fiscalDateEnding: "2026-09-30",
    estimate: 1.9, currency: "USD", timeOfTheDay: "post-market",
  };

  it("before release: session slot, unconfirmed, fiscal label", () => {
    const rec = calendarRowToRecord(row, { fiscalYearEnd: "0926", earningsReleases: [] });
    expect(rec).toMatchObject({ exactTime: null, session: "amc", confirmed: false, period: "Q4", periodYear: 2026, source: "alphavantage" });
  });

  it("after release: exact ET time from EDGAR", () => {
    const rec = calendarRowToRecord(row, { fiscalYearEnd: "0926", earningsReleases: ["2026-10-29T20:30:28.000Z"] });
    expect(rec).toMatchObject({ exactTime: "16:30:28", confirmed: true, source: "edgar" });
  });
});
