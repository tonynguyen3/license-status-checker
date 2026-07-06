import { describe, expect, it } from "vitest";
import { daysUntil } from "../src/date-utils.js";

describe("daysUntil", () => {
  it("compares calendar dates instead of clock time", () => {
    expect(daysUntil(new Date(2026, 6, 7, 0, 1), new Date(2026, 6, 6, 23, 59))).toBe(1);
  });

  it("handles same day, future, and past dates", () => {
    const today = new Date(2026, 6, 6, 12);

    expect(daysUntil(new Date(2026, 6, 6, 1), today)).toBe(0);
    expect(daysUntil(new Date(2026, 9, 4, 1), today)).toBe(90);
    expect(daysUntil(new Date(2026, 6, 5, 23), today)).toBe(-1);
  });
});
