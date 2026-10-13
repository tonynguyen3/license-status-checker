import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WashingtonLicenseChecker } from "../src/washington-checker.js";
import { Logger } from "../src/logger.js";
import { buildOutputPaths } from "../src/paths.js";
import type { BucketedResult, Tradesman } from "../src/types.js";

describe("website decisions using local HTML fixtures", () => {
  let browser: Browser;
  let page: Page;
  let directory: string;
  let html: string;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 12));
    directory = await mkdtemp(join(tmpdir(), "checker-decisions-"));
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    // Every request is fulfilled locally; these tests never contact Washington.
    await page.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  });
  afterAll(async () => {
    vi.useRealTimers();
    await browser?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function check(options: { trade?: string; expiration?: string; inputExpiration?: string; status?: string; courses?: string; affidavit?: string; extra?: string } = {}) {
    html = `<span id="ExpirationDate">${options.expiration ?? "11/01/2026"}</span>
      <span id="EffectiveDate">01/01/2025</span><span id="LicenseType">${options.trade ?? "Plumber"}</span>
      <span id="StatusDescription"><strong>${options.status ?? "Active"}</strong></span>
      <span>999.00 unrelated</span>
      ${options.courses ?? '<div id="Courses">No continuing education credits have been reported for the next/current renewal.</div>'}
      ${options.affidavit ?? ""}${options.extra ?? ""}`;
    const checker = new WashingtonLicenseChecker(new Logger(), buildOutputPaths(directory), { headed: false, slowMo: 0, checkDelayMs: 0 });
    const tradesman: Tradesman = { licenseNumber: "FIXTURE", expirationDate: options.inputExpiration ?? "11/01/2026" };
    // Exercise the full per-license Playwright path without starting a bulk run.
    const internal = checker as unknown as { checkSingleLicense(page: Page, tradesman: Tradesman): Promise<BucketedResult> };
    return internal.checkSingleLicense(page, tradesman);
  }
  const courses = (title: string, hours = "4.00 FA") => `<div id="Courses"><div id="coursesList">
    <div><label>Course title</label><span>${title}</span></div>
    <div><label>Completed</label><span>10/01/2026</span><label>Course code</label><span>WA2026-123</span></div>
    <div><label>Course Hours</label><span>${hours}</span></div><div></div></div></div>`;
  it("sends no-course and first-aid-only Plumbers and Electricians", async () => {
    for (const trade of ["Plumber", "Electrician"]) {
      expect((await check({ trade })).bucket).toBe("send");
      const result = await check({ trade, courses: courses("First Aid/CPR") });
      expect(result.bucket).toBe("send");
      expect(result.tradesman.hoursCompleted).toBe(4);
      expect(result.tradesman.ceClassification).toBe("First aid only");
      expect(result.tradesman.reportedCourses).toContain("WA2026-123");
    }
  });
  it("excludes non-first-aid courses", async () => {
    expect((await check({ courses: courses("Plumbing Code", "1.50 CODE") })).bucket).toBe("doNotSend");
  });
  it("sends an ASHI first-aid-only Plumber using Hudson's reported course title", async () => {
    const result = await check({ courses: courses("ASHI Basic First Aid/Adult CPR-AED", "4.00 IRP") });
    expect(result.bucket).toBe("send");
    expect(result.tradesman.ceClassification).toBe("First aid only");
    expect(result.tradesman.hoursCompleted).toBe(4);
  });
  it("records renewal even when the changed date is still within 90 days", async () => {
    const result = await check({ expiration: "11/02/2026" });
    expect(result.bucket).toBe("doNotSend");
    expect(result.tradesman.expirationDate).toBe("11/01/2026");
    expect(result.tradesman.liveExpirationDate).toBe("11/2/2026");
    expect(result.tradesman.notSendReason).toContain("Likely renewed");
  });
  it("excludes advanced, earlier, and expired live dates", async () => {
    expect((await check({ expiration: "11/01/2029" })).tradesman.expirationComparison).toBe("Advanced");
    expect((await check({ expiration: "10/31/2026" })).tradesman.notSendReason).toContain("earlier");
    const result = await check({ expiration: "10/11/2026", inputExpiration: "10/11/2026" });
    expect(result.tradesman.notSendReason).toContain("in the past");
    expect(result.tradesman.notSendReason).not.toContain("not a valid");
  });
  it("excludes inactive licenses", async () => {
    const result = await check({ status: "Inactive" });
    expect(result.bucket).toBe("doNotSend");
    expect(result.tradesman.licenseStatus).toBe("Inactive");
    expect(result.tradesman.statusEvidence).toContain(".png");
    expect((await readFile(result.tradesman.statusEvidence!)).subarray(0, 4).toString("hex")).toBe("89504e47");
  });
  it("handles CSS-transformed and hidden Active statuses without excluding them", async () => {
    const result = await check({ extra: '<style>#StatusDescription {text-transform:uppercase}</style>' });
    expect(result.bucket).toBe("send");
    expect(result.tradesman.licenseStatus).toBe("Active");
    expect((await check({ extra: '<style>#StatusDescription {display:none}</style>' })).bucket).toBe("send");
  });
  it("classifies both superseded spellings as Do Not Send with a likely-progression explanation", async () => {
    for (const status of ["Superceded", "Superseded", "SUPERCeded."]) {
      const result = await check({ status });
      expect(result.bucket).toBe("doNotSend");
      expect(result.tradesman.licenseStatus).toBe(status);
      expect(result.tradesman.notSendReason).toContain("likely replaced");
      expect(result.tradesman.notSendReason).toContain("trainee/apprentice to journeyman");
    }
  });
  it("waits for delayed status text instead of classifying blank as inactive", async () => {
    expect((await check({ status: "", extra: '<script>setTimeout(() => document.querySelector("#StatusDescription strong").textContent = "Active", 300)</script>' })).bucket).toBe("send");
  });
  it("normalizes case and punctuation and rejects unknown status", async () => {
    expect((await check({ status: "ACTIVE." })).bucket).toBe("send");
    await expect(check({ status: "Loading" })).rejects.toThrow("unrecognized website status");
  });
  it("records evidence and throws rather than bucketing a permanently blank status", async () => {
    await expect(check({ status: "" })).rejects.toThrow("not classified as inactive");
  }, 15_000);
  it("throws for missing and malformed CE sections", async () => {
    await expect(check({ courses: "" })).rejects.toThrow("Could not confirm");
    await expect(check({ courses: courses("First Aid", "pending") })).rejects.toThrow("incomplete");
  });
  it("keeps the trainee CE exclusion and affidavit requirements", async () => {
    expect((await check({ trade: "Plumber Trainee", courses: courses("First Aid") })).bucket).toBe("doNotSend");
    expect((await check({ trade: "Plumber Trainee" })).tradesman.notSendReason).toContain("No affidavit");
    const affidavit = `<div id="AffidavitHours"><table><thead><tr><td>Employer</td><td>Hours reported</td><td>Hours approved</td><td>From date</td><td>To date</td></tr></thead>
      <tbody><tr><td>Fixture</td><td>1400</td><td>1105</td><td>09/01/2024</td><td>09/01/2025</td></tr></tbody></table></div>`;
    expect((await check({ trade: "Plumber Trainee", affidavit })).bucket).toBe("doNotSend");
    expect((await check({ trade: "Plumber Trainee", affidavit: affidavit.replaceAll("09/01/2024", "09/01/2025").replace("<td>09/01/2025</td></tr>", "<td>09/01/2026</td></tr>") })).bucket).toBe("send");
  });
});
