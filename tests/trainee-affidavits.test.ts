import { describe, expect, it } from "vitest";
import { evaluateTraineeAffidavits } from "../src/trainee-affidavits.js";

const today = new Date(2025, 9, 7);
const row = { hoursReported: "1400", fromDate: "02/24/2024", toDate: "02/23/2025" };
const evaluate = (rows = [row], effective = "02/24/2022", expiration = "04/17/2026", now = today) =>
  evaluateTraineeAffidavits(rows, effective, expiration, now);

describe("trainee affidavit activity", () => {
  it("uses reported rather than approved hours and discards leftover days", () => {
    expect(evaluate()).toMatchObject({ eligible: true, wholeWeeks: 52, hoursReported: 1400, hoursPerWeek: 26.92 });
  });
  it("accepts exactly 20 hours per week and rejects anything below", () => {
    expect(evaluate([{ ...row, hoursReported: "1040" }]).eligible).toBe(true);
    expect(evaluate([{ ...row, hoursReported: "1039" }]).eligible).toBe(false);
  });
  it("accepts the 365-day boundary but rejects the next day", () => {
    expect(evaluate([row], undefined, undefined, new Date(2026, 1, 23)).eligible).toBe(true);
    expect(evaluate([row], undefined, undefined, new Date(2026, 1, 24)).reason).toContain("365 days old");
  });
  it("uses 365 days rather than a calendar anniversary across leap years", () => {
    const leapRow = { ...row, fromDate: "03/01/2022", toDate: "03/01/2023" };
    expect(evaluate([leapRow], undefined, undefined, new Date(2024, 1, 29)).eligible).toBe(true);
    expect(evaluate([leapRow], undefined, undefined, new Date(2024, 2, 1)).reason).toContain("365 days old");
  });
  it("rejects the screenshot license on the current run date", () => {
    expect(evaluate([row], undefined, undefined, new Date(2026, 9, 7)).reason).toContain("effective/expiration");
  });
  it("allows From Date before the effective date when To Date is within the license period", () => {
    expect(evaluate([row], "03/01/2024").eligible).toBe(true);
  });
  it("requires To Date within the license dates", () => {
    expect(evaluate([row], "03/01/2025").reason).toContain("To Date is outside");
    expect(evaluate([row], undefined, "02/22/2025", new Date(2025, 1, 20)).eligible).toBe(false);
  });
  it("uses the latest period rather than an older high-hour period", () => {
    expect(evaluate([row, { hoursReported: "100", fromDate: "03/01/2025", toDate: "09/01/2025" }]).eligible).toBe(false);
  });
  it("totals multiple employers for the same latest period", () => {
    expect(evaluate([{ ...row, hoursReported: "600" }, { ...row, hoursReported: "500" }])).toMatchObject({ eligible: true, hoursReported: 1100 });
  });
  it("rejects missing, malformed, future, and too-short records", () => {
    expect(evaluate([]).eligible).toBe(false);
    for (const changed of [
      { toDate: "02/30/2025" }, { hoursReported: "" }, { hoursReported: "-1" },
      { fromDate: "bad" }, { fromDate: "02/22/2025" },
      { fromDate: "10/01/2025", toDate: "11/01/2025" }
    ]) expect(evaluate([{ ...row, ...changed }]).eligible).toBe(false);
  });
});
