import { describe, it, expect } from "vitest";
import { reportState } from "./earningsStatus.js";

// 16:00 EDT after-close slot.
const slot = "2026-07-15T20:00:00.000Z";
const at = (iso: string) => new Date(iso);

describe("reportState", () => {
  const unconfirmed = { earnings_at: slot, time_precision: "session" as const, is_confirmed: false };

  it("is upcoming before the slot", () => {
    expect(reportState(unconfirmed, at("2026-07-15T19:59:59Z")).status).toBe("upcoming");
  });

  it("is reporting soon from the slot until the window closes", () => {
    expect(reportState(unconfirmed, at(slot)).status).toBe("reportingSoon");
    expect(reportState(unconfirmed, at("2026-07-15T22:59:59Z")).status).toBe("reportingSoon");
  });

  it("is presumed reported once the window closes with no filing", () => {
    const s = reportState(unconfirmed, at("2026-07-15T23:00:00Z"));
    expect(s.status).toBe("presumedReported");
    expect(s.reportedAt).toBeNull();
  });

  it("is reported at the stamped filing time, whatever the clock", () => {
    const stamped = { earnings_at: "2026-07-15T20:04:31.000Z", time_precision: "exact" as const, is_confirmed: true };
    for (const now of ["2026-07-15T12:00:00Z", "2026-07-15T20:10:00Z", "2026-07-17T00:00:00Z"]) {
      const s = reportState(stamped, at(now));
      expect(s.status).toBe("reported");
      expect(s.reportedAt).toBe("2026-07-15T20:04:31.000Z");
    }
  });

  it("sends the window so the app can move between states on its own clock", () => {
    const s = reportState(unconfirmed, at("2026-07-15T12:00:00Z"));
    expect(s.windowStart).toBe(slot);
    expect(s.windowEnd).toBe("2026-07-15T23:00:00.000Z");
  });
});
