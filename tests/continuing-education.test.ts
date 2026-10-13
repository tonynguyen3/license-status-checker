import { describe, expect, it } from "vitest";
import { isFirstAidOnly, parseReportedCourses, courseExclusionReason } from "../src/continuing-education.js";

function course(title = "First Aid/CPR/AED", hours = "4.00 FA") {
  return parseReportedCourses([
    { label: "Course title", value: title }, { label: "Completed", value: "10/01/2026" },
    { label: "Course code", value: "WA2026-123" }, { label: "Course Hours", value: hours },
    { label: "", value: "" }
  ], "Continuing education");
}

describe("course-aware outreach", () => {
  it("recognizes First Aid anywhere in titles regardless of provider, case, or separators", () => {
    for (const title of ["First Aid", "First-Aid Training", "CPR & First Aid", "Adult First Aid/CPR/AED",
      "ASHI Basic First Aid/Adult CPR-AED", "Provider FIRST AID Certification", "First   Aid", "First\u00a0Aid",
      "First\u2011Aid", "First Aid and Electrical Code"]) expect(isFirstAidOnly(title)).toBe(true);
    for (const title of ["CPR", "AED", "Plumbing Safety", "First Aids", "FirstAid", "First Aidful"]) expect(isFirstAidOnly(title)).toBe(false);
  });
  it("allows first aid only for Electricians and Plumbers, but preserves the trainee credit exclusion", () => {
    expect(courseExclusionReason("Electrician", course())).toBeUndefined();
    expect(courseExclusionReason("Plumber", course())).toBeUndefined();
    expect(courseExclusionReason("Plumber Trainee", course())).toContain("CE credits");
    expect(courseExclusionReason("Plumber", course("ASHI Basic First Aid/Adult CPR-AED"))).toBeUndefined();
  });
  it("excludes other courses alone or mixed with first aid", () => {
    const other = course("Electrical Code", "1.50 NEC");
    for (const trade of ["Electrician", "Plumber"]) {
      expect(courseExclusionReason(trade, other)).toContain("Non-first-aid");
      expect(courseExclusionReason(trade, [...course(), ...other])).toContain("Non-first-aid");
    }
  });
  it("counts multiple credit categories and fractions in the course hours field", () => {
    expect(course("Pumps", "4.00 IRE,4.00 IRP")[0].hours).toBe(8);
    expect(course("Code", "1.50 NEC,0.75 RCW")[0].hours).toBe(2.25);
  });
  it("requires explicit no-credits text when there are no courses", () => {
    expect(parseReportedCourses([], "No continuing education credits have been reported for the next/current renewal.")).toEqual([]);
    expect(() => parseReportedCourses([], "")).toThrow("Could not confirm");
    expect(() => parseReportedCourses([], "Loading")).toThrow();
  });
  it("logs incomplete courses rather than treating them as no credits", () => {
    expect(() => course("", "4.00")).toThrow();
    expect(() => course("First Aid", "pending")).toThrow();
  });
});
