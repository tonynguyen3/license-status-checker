import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type Browser, type Page } from "playwright";
import { daysUntil } from "./date-utils.js";
import { getHoursNeeded } from "./hours.js";
import { Logger } from "./logger.js";
import { parseReportedCourses, courseExclusionReason, type CourseListRow } from "./continuing-education.js";
import { evaluateTraineeAffidavits, type AffidavitRow } from "./trainee-affidavits.js";
import type { BucketedResult, CheckerOptions, CourseFrequency, OutputPaths, Tradesman } from "./types.js";

interface CheckRunResult {
  send: Tradesman[];
  doNotSend: Tradesman[];
  courseFrequencies: CourseFrequency[];
  canceled: boolean;
}

class WashingtonRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WashingtonRateLimitError";
  }
}

interface LicenseTiming {
  timestamp: string;
  licenseNumber: string;
  outcome: "success" | "error" | "rate_limited";
  bucket?: string;
  httpStatus?: number;
  totalMs: number;
  navigationMs: number;
  rateLimitProbeMs: number;
  expirationMs: number;
  statusMs: number;
  tradeMs: number;
  coursesCountMs: number;
  creditsMs: number;
  courseFrequencyMs: number;
  slowestPhase: string;
  slowestPhaseMs: number;
  hiccup: string;
  message: string;
}

const TIMING_HICCUP_TOTAL_MS = 10_000;
const TIMING_HICCUP_NAVIGATION_MS = 8_000;
const TIMING_HICCUP_PHASE_MS = 5_000;

export class WashingtonLicenseChecker {
  private readonly courseCounts = new Map<string, { courseName: string; courseCode: string; frequency: number }>();

  constructor(
    private readonly logger: Logger,
    private readonly outputPaths: OutputPaths,
    private readonly options: CheckerOptions
  ) {}

  async checkLicenses(tradesmen: Tradesman[]): Promise<CheckRunResult> {
    const limitedTradesmen = this.options.limit ? tradesmen.slice(0, this.options.limit) : tradesmen;
    if (this.options.isCanceled?.()) {
      this.options.onProgress?.({
        type: "checks_canceled",
        message: "Run was stopped before website checks started.",
        current: 0,
        total: limitedTradesmen.length,
        remaining: limitedTradesmen.length
      });
      return {
        send: [],
        doNotSend: [],
        courseFrequencies: [],
        canceled: true
      };
    }

    const browser = await chromium.launch({
      headless: !this.options.headed,
      slowMo: this.options.slowMo
    });

    try {
      const page = await browser.newPage();
      const results: BucketedResult[] = [];
      const total = limitedTradesmen.length;
      let sendCount = 0;
      let doNotSendCount = 0;
      let errorCount = 0;
      let canceled = false;

      this.options.onProgress?.({
        type: "checks_started",
        message: `Starting ${total} website check(s).`,
        current: 0,
        total,
        remaining: total
      });

      for (let index = 0; index < limitedTradesmen.length; index++) {
        if (this.options.isCanceled?.()) {
          canceled = true;
          this.options.onProgress?.({
            type: "checks_canceled",
            message: `Run stopped after ${index} of ${total} website check(s). Partial output files will be written.`,
            current: index,
            total,
            remaining: total - index
          });
          break;
        }

        const tradesman = limitedTradesmen[index];
        const current = index + 1;

        this.options.onProgress?.({
          type: "license_check_started",
          message: `Checking license ${current} of ${total}: ${tradesman.licenseNumber}.`,
          current: index,
          total,
          remaining: total - index,
          licenseNumber: tradesman.licenseNumber
        });

        try {
          const result = await this.checkSingleLicense(page, tradesman);
          results.push(result);
          if (result.bucket === "send") {
            sendCount++;
          } else {
            doNotSendCount++;
          }
          this.options.onProgress?.({
            type: "license_check_complete",
            message: `Finished license ${current} of ${total}: ${tradesman.licenseNumber} -> ${formatBucket(result.bucket)}.`,
            current,
            total,
            remaining: total - current,
            licenseNumber: tradesman.licenseNumber
          });
        } catch (error) {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          console.log(`There was an error with ${tradesman.licenseNumber}.`);
          await this.logger.writeErrorsToLog(
            `License ${tradesman.licenseNumber}\n${message}\nThere was a Playwright error.`,
            this.outputPaths.exceptionLogPath
          );
          errorCount++;
          this.options.onProgress?.({
            type: "license_check_error",
            message: `Error checking license ${current} of ${total}: ${tradesman.licenseNumber}.`,
            current,
            total,
            remaining: total - current,
            licenseNumber: tradesman.licenseNumber
          });

          if (error instanceof WashingtonRateLimitError) {
            canceled = true;
            this.options.onProgress?.({
              type: "rate_limited",
              message:
                "Washington site returned a rate-limit response. The run stopped before checking more licenses.",
              current,
              total,
              remaining: total - current
            });
            break;
          }
        }

        if (current === total || current % 50 === 0) {
          this.options.onProgress?.({
            type: "checks_progress",
            message: `Checked ${current} of ${total} license(s). Send: ${sendCount}. DoNotSend: ${doNotSendCount}. Errors: ${errorCount}.`,
            current,
            total,
            remaining: total - current
          });
        }

        if (current < total && !canceled) {
          await this.pauseBetweenChecks();
        }
      }

      this.options.onProgress?.({
        type: canceled ? "checks_canceled" : "checks_complete",
        message: canceled ? "Website checks stopped by request." : `Finished ${total} website check(s).`,
        current: canceled ? sendCount + doNotSendCount + errorCount : total,
        total,
        remaining: canceled ? total - sendCount - doNotSendCount - errorCount : 0
      });

      return {
        send: results.filter((result) => result.bucket === "send").map((result) => result.tradesman),
        doNotSend: results.filter((result) => result.bucket === "doNotSend").map((result) => result.tradesman),
        courseFrequencies: [...this.courseCounts.values()],
        canceled
      };
    } finally {
      await closeBrowser(browser);
    }
  }

  private async checkSingleLicense(page: Page, tradesman: Tradesman): Promise<BucketedResult> {
    const startedAt = performance.now();
    const timing: LicenseTiming = {
      timestamp: new Date().toISOString(),
      licenseNumber: tradesman.licenseNumber,
      outcome: "error",
      totalMs: 0,
      navigationMs: 0,
      rateLimitProbeMs: 0,
      expirationMs: 0,
      statusMs: 0,
      tradeMs: 0,
      coursesCountMs: 0,
      creditsMs: 0,
      courseFrequencyMs: 0,
      slowestPhase: "",
      slowestPhaseMs: 0,
      hiccup: "",
      message: ""
    };

    try {
      const response = await timePhase(timing, "navigationMs", () => page.goto(
        `https://secure.lni.wa.gov/verify/Detail.aspx?UBI=&LIC=${encodeURIComponent(tradesman.licenseNumber)}&SAW=`,
        { waitUntil: "load" }
      ));

      if (!response) {
        throw new Error(`Washington site did not return an HTTP response for ${tradesman.licenseNumber}.`);
      }

      const httpStatus = response.status();
      timing.httpStatus = httpStatus;
      if (httpStatus === 429) {
        throw new WashingtonRateLimitError(
          `Washington site returned HTTP 429 rate limit for ${tradesman.licenseNumber}.`
        );
      }

      if (httpStatus >= 400) {
        throw new Error(`Washington site returned HTTP ${httpStatus} for ${tradesman.licenseNumber}.`);
      }

      await timePhase(timing, "rateLimitProbeMs", () => this.throwIfRateLimitPage(page, tradesman));

      const expiration = await timePhase(timing, "expirationMs", () => this.checkExpirationDate(page));
      if (expiration.invalid) {
        const result = this.doNotSend(tradesman, `${tradesman.licenseNumber} is not a valid license.`);
        timing.outcome = "success";
        timing.bucket = result.bucket;
        timing.message = tradesman.notSendReason ?? "Invalid license.";
        return result;
      }

      tradesman.liveExpirationDate = expiration.date.toLocaleDateString();
      const inputExpiration = new Date(tradesman.expirationDate ?? "");
      if (Number.isNaN(inputExpiration.getTime())) throw new Error("Input expiration date is missing or invalid.");
      const dateChange = daysUntil(expiration.date, inputExpiration);
      tradesman.expirationComparison = dateChange > 0 ? "Advanced" : dateChange < 0 ? "Earlier" : "Unchanged";
      // The manually produced input can be stale. Any advanced expiration excludes outreach.
      if (dateChange !== 0 || expiration.days > 90 || expiration.days < 0) {
        const reason = dateChange > 0
          ? `Likely renewed: expiration advanced from ${tradesman.expirationDate} to ${tradesman.liveExpirationDate}.`
          : dateChange < 0 ? `Live expiration ${tradesman.liveExpirationDate} is earlier than input ${tradesman.expirationDate}; review required.`
          : expiration.days < 0 ? "Live license expiration is in the past."
          : "Live expiration is more than 90 days away.";
        const result = this.doNotSend(tradesman, `${tradesman.licenseNumber}: ${reason}`);
        timing.outcome = "success";
        timing.bucket = result.bucket;
        timing.message = tradesman.notSendReason ?? "Likely renewed.";
        return result;
      }

      const status = await timePhase(timing, "statusMs", () => this.readLicenseStatus(page, tradesman));
      if (status !== "active") {
        // L&I may spell superseded as "Superceded". The old license was likely
        // replaced after progression from trainee/apprentice to journeyman.
        const superseded = status === "superceded" || status === "superseded";
        const reason = superseded
          ? `${tradesman.licenseNumber}: website status ${tradesman.licenseStatus}; license likely replaced after progression from trainee/apprentice to journeyman.`
          : `${tradesman.licenseNumber} is not active (website status: ${tradesman.licenseStatus}).`;
        const result = this.doNotSend(tradesman, reason);
        timing.outcome = "success";
        timing.bucket = result.bucket;
        timing.message = tradesman.notSendReason ?? "Not active.";
        return result;
      }

      await page.waitForFunction('document.querySelector("#LicenseType")?.textContent?.trim()', undefined, { timeout: 10_000 });
      const trade = (await timePhase(timing, "tradeMs", () => page.locator("#LicenseType").textContent({ timeout: 10_000 })))?.trim() ?? "";
      tradesman.trade = trade;
      tradesman.hoursNeeded = getHoursNeeded(trade);

      const courseSnapshot = await timePhase(timing, "creditsMs", () => page.evaluate(`(() => {
        const section = document.querySelector("#Courses");
        const clean = value => (value || "").replace(/\\s+/g, " ").trim();
        // A single row can contain both Completed and Course code; read every label.
        return { text: clean(section?.textContent), rows: Array.from(section?.querySelectorAll("#coursesList label") || []).map(label => {
          let sibling = label.nextElementSibling;
          let value = "";
          while (sibling && sibling.tagName !== "LABEL") {
            const span = sibling.matches("span") ? sibling : sibling.querySelector("span");
            if (span) { value = clean(span.textContent); break; }
            sibling = sibling.nextElementSibling;
          }
          return { label: clean(label.textContent), value };
        }) };
      })()`)) as { text: string; rows: CourseListRow[] };
      const courses = parseReportedCourses(courseSnapshot.rows, courseSnapshot.text);
      const numberOfCredits = courses.reduce((sum, course) => sum + course.hours, 0);
      tradesman.hoursCompleted = numberOfCredits;
      tradesman.reportedCourses = courses.map(course => `${course.title} [${course.code || "no code"}; ${course.completed}; ${course.hours} hours]`).join(" | ");
      tradesman.ceClassification = !courses.length ? "No courses reported"
        : courses.every(course => course.firstAidOnly) ? "First aid only" : "Other CE reported";
      console.log(`${tradesman.licenseNumber} has completed ${tradesman.hoursCompleted} credits and needs ${tradesman.hoursNeeded}`);

      for (const course of courses) {
        if (course.code) this.recordCourseFrequency(course.title, course.code);
      }
      const exclusion = courseExclusionReason(trade, courses);
      if (exclusion) {
        const result = this.doNotSend(tradesman, `${tradesman.licenseNumber}: ${exclusion}`);
        timing.outcome = "success";
        timing.bucket = result.bucket;
        timing.message = tradesman.notSendReason ?? "Some credits already.";
        return result;
      }

      // The first-aid exception is only for Plumbers and Electricians, not trainees.
      if (trade === "Plumber Trainee") {
        const affidavit = await page.evaluate(`(() => {
          const clean = value => (value || "").trim();
          const table = document.querySelector("#AffidavitHours table");
          const headers = Array.from(table?.querySelectorAll("thead td, thead th") || []).map(cell => clean(cell.textContent).toLowerCase());
          const rows = Array.from(table?.querySelectorAll("tbody tr") || []).map(row => {
            const cells = Array.from(row.querySelectorAll("td"));
            const value = header => clean(cells[headers.indexOf(header)]?.textContent);
            return { hoursReported: value("hours reported"), fromDate: value("from date"), toDate: value("to date") };
          });
          return { effective: clean(document.querySelector("#EffectiveDate")?.textContent), expiration: clean(document.querySelector("#ExpirationDate")?.textContent), rows };
        })()`) as { effective: string; expiration: string; rows: AffidavitRow[] };
        const decision = evaluateTraineeAffidavits(affidavit.rows, affidavit.effective, affidavit.expiration);
        Object.assign(tradesman, {
          affidavitFromDate: decision.fromDate, affidavitToDate: decision.toDate,
          affidavitHoursReported: decision.hoursReported, affidavitWholeWeeks: decision.wholeWeeks,
          affidavitHoursPerWeek: decision.hoursPerWeek, affidavitDecision: decision.reason
        });
        const result: BucketedResult = decision.eligible ? { bucket: "send", tradesman }
          : this.doNotSend(tradesman, `${tradesman.licenseNumber}: ${decision.reason}`);
        tradesman.decisionReason = decision.reason;
        timing.outcome = "success";
        timing.bucket = result.bucket;
        timing.message = decision.reason;
        return result;
      }

      timing.outcome = "success";
      timing.bucket = "send";
      tradesman.decisionReason = courses.length ? "Only first-aid courses reported; send." : "No CE courses reported; send.";
      timing.message = tradesman.decisionReason;
      return { bucket: "send", tradesman };
    } catch (error) {
      timing.outcome = error instanceof WashingtonRateLimitError ? "rate_limited" : "error";
      timing.message = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      timing.totalMs = roundedMs(performance.now() - startedAt);
      const slowest = slowestTimingPhase(timing);
      timing.slowestPhase = slowest.phase;
      timing.slowestPhaseMs = slowest.ms;
      timing.hiccup = timingHiccup(timing);
      await this.writeTiming(timing);
      if (timing.hiccup) {
        this.options.onProgress?.({
          type: "timing_hiccup",
          message: `Timing hiccup for ${tradesman.licenseNumber}: ${timing.totalMs} ms total; slowest phase ${timing.slowestPhase} ${timing.slowestPhaseMs} ms. ${timing.hiccup}`,
          licenseNumber: tradesman.licenseNumber
        });
      }
    }
  }

  private async writeTiming(timing: LicenseTiming): Promise<void> {
    await mkdir(dirname(this.outputPaths.timingLogPath), { recursive: true });
    await appendFile(this.outputPaths.timingLogPath, `${timingLine(timing)}\n`, "utf8");
  }

  private async readLicenseStatus(page: Page, tradesman: Tradesman): Promise<string> {
    const snapshot = () => page.evaluate(`(() => {
      const element = document.querySelector("#StatusDescription strong");
      return { raw: element?.textContent?.trim() || "", rendered: element?.innerText?.trim() || "",
        description: document.querySelector("#StatusDescription")?.textContent?.trim() || "", readyState: document.readyState };
    })()`) as Promise<{ raw: string; rendered: string; description: string; readyState: string }>;
    const initial = await snapshot();
    try {
      // Element attachment/load events do not guarantee populated data. Read DOM text
      // instead of rendered text, which can be altered by CSS or collapsed sections.
      await page.waitForFunction('document.querySelector("#StatusDescription strong")?.textContent?.trim()', undefined, { timeout: 10_000 });
    } catch {
      await this.captureStatusEvidence(page, tradesman, { initial, final: await snapshot(), error: "Status stayed blank for 10 seconds." });
      throw new Error(`License ${tradesman.licenseNumber}: website status stayed blank or missing; not classified as inactive. Evidence: ${tradesman.statusEvidence}`);
    }
    const final = await snapshot();
    tradesman.licenseStatus = final.raw;
    const normalized = final.raw.toLowerCase().replace(/[.\s]+$/g, "").replace(/\s+/g, " ");
    const recognized = ["active", "inactive", "expired", "suspended", "revoked", "cancelled", "canceled", "terminated", "closed", "not active", "superceded", "superseded"];
    const needsScreenshot = normalized !== "active" || initial.raw !== final.raw || final.rendered !== final.raw;
    if (needsScreenshot) {
      await this.captureStatusEvidence(page, tradesman, { initial, final, normalized });
    } else {
      await appendFile(join(dirname(this.outputPaths.timingLogPath), "status-diagnostics.jsonl"), `${JSON.stringify({ license: tradesman.licenseNumber, url: page.url(), timestamp: new Date().toISOString(), initial, final, normalized })}\n`);
    }
    if (!recognized.includes(normalized)) {
      throw new Error(`License ${tradesman.licenseNumber}: unrecognized website status ${JSON.stringify(final.raw)}; review required. Evidence: ${tradesman.statusEvidence}`);
    }
    return normalized;
  }

  private async captureStatusEvidence(page: Page, tradesman: Tradesman, details: unknown): Promise<void> {
    const directory = join(dirname(this.outputPaths.timingLogPath), "status-evidence");
    await mkdir(directory, { recursive: true });
    const stem = join(directory, encodeURIComponent(tradesman.licenseNumber).replace(/\*/g, "%2A"));
    tradesman.statusEvidence = `${stem}.png`;
    const errors: string[] = [];
    try { await page.screenshot({ path: `${stem}.png`, fullPage: true, timeout: 10_000 }); }
    catch (error) { errors.push(`Screenshot failed: ${String(error)}`); }
    try { await writeFile(`${stem}.html`, await page.content()); }
    catch (error) { errors.push(`HTML capture failed: ${String(error)}`); }
    await writeFile(`${stem}.json`, JSON.stringify({ license: tradesman.licenseNumber, url: page.url(), timestamp: new Date().toISOString(), details, errors }, null, 2));
  }

  private async pauseBetweenChecks(): Promise<void> {
    const delayMs = Math.max(0, this.options.checkDelayMs);
    if (delayMs === 0) return;

    const sleepChunkMs = 250;
    let remainingMs = delayMs;
    while (remainingMs > 0) {
      if (this.options.isCanceled?.()) return;
      await sleep(Math.min(sleepChunkMs, remainingMs));
      remainingMs -= sleepChunkMs;
    }
  }

  private async throwIfRateLimitPage(page: Page, tradesman: Tradesman): Promise<void> {
    let bodyText = "";
    try {
      bodyText = (await page.locator("body").innerText({ timeout: 1_000 })).toLowerCase();
    } catch {
      return;
    }

    const looksRateLimited =
      bodyText.includes("too many requests") ||
      bodyText.includes("rate limit") ||
      bodyText.includes("the requested url was rejected") ||
      (bodyText.includes("support id") && bodyText.includes("request"));

    if (looksRateLimited) {
      throw new WashingtonRateLimitError(
        `Washington site appears to be showing an F5/rate-limit page for ${tradesman.licenseNumber}.`
      );
    }
  }

  private async checkExpirationDate(page: Page): Promise<{ days: number; date: Date; invalid?: boolean }> {
    if (page.url() === "https://secure.lni.wa.gov/verify/default.aspx#ErrorMsg") {
      return { days: -1, date: new Date(0), invalid: true };
    }

    const expirationElement = page.locator("#ExpirationDate");
    await expirationElement.waitFor({ state: "attached", timeout: 10_000 });

    let expirationText = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      expirationText = (await expirationElement.textContent())?.trim() ?? "";
      if (expirationText) break;
      await page.waitForTimeout(250);
    }

    const expirationDate = new Date(expirationText);
    if (Number.isNaN(expirationDate.getTime())) {
      throw new Error(`Could not parse expiration date: ${expirationText}`);
    }

    return { days: daysUntil(expirationDate), date: expirationDate };
  }

  private recordCourseFrequency(courseName: string, courseCode: string): void {
    const key = `${courseName}\u0000${courseCode}`;
    const existing = this.courseCounts.get(key);

    if (existing) {
      existing.frequency++;
    } else {
      this.courseCounts.set(key, { courseName, courseCode, frequency: 1 });
    }
  }

  private doNotSend(tradesman: Tradesman, reason: string): BucketedResult {
    console.log(reason);
    tradesman.notSendReason = reason;
    tradesman.decisionReason = reason;
    return { bucket: "doNotSend", tradesman };
  }
}

async function closeBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // The run is already finished; browser cleanup failures should not hide output.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timePhase<T>(
  timing: LicenseTiming,
  key: keyof Pick<
    LicenseTiming,
    | "navigationMs"
    | "rateLimitProbeMs"
    | "expirationMs"
    | "statusMs"
    | "tradeMs"
    | "coursesCountMs"
    | "creditsMs"
    | "courseFrequencyMs"
  >,
  action: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await action();
  } finally {
    timing[key] += roundedMs(performance.now() - startedAt);
  }
}

function slowestTimingPhase(timing: LicenseTiming): { phase: string; ms: number } {
  const phases = [
    ["navigation", timing.navigationMs],
    ["rateLimitProbe", timing.rateLimitProbeMs],
    ["expiration", timing.expirationMs],
    ["status", timing.statusMs],
    ["trade", timing.tradeMs],
    ["coursesCount", timing.coursesCountMs],
    ["credits", timing.creditsMs],
    ["courseFrequency", timing.courseFrequencyMs]
  ] as const;

  return phases.reduce(
    (slowest, [phase, ms]) => ms > slowest.ms ? { phase, ms } : slowest,
    { phase: "none", ms: 0 }
  );
}

function timingHiccup(timing: LicenseTiming): string {
  const reasons: string[] = [];
  if (timing.totalMs >= TIMING_HICCUP_TOTAL_MS) {
    reasons.push(`total >= ${TIMING_HICCUP_TOTAL_MS} ms`);
  }
  if (timing.navigationMs >= TIMING_HICCUP_NAVIGATION_MS) {
    reasons.push(`navigation >= ${TIMING_HICCUP_NAVIGATION_MS} ms`);
  }
  if (timing.slowestPhaseMs >= TIMING_HICCUP_PHASE_MS) {
    reasons.push(`${timing.slowestPhase} >= ${TIMING_HICCUP_PHASE_MS} ms`);
  }
  if (timing.outcome !== "success") {
    reasons.push(`outcome=${timing.outcome}`);
  }
  return reasons.join("; ");
}

function formatBucket(bucket: BucketedResult["bucket"]): string {
  return bucket === "send" ? "Send" : "Do-not-send";
}

function timingLine(timing: LicenseTiming): string {
  return [
    timing.timestamp,
    timing.licenseNumber,
    timing.outcome,
    timing.bucket ?? "",
    timing.httpStatus ?? "",
    timing.totalMs,
    timing.navigationMs,
    timing.rateLimitProbeMs,
    timing.expirationMs,
    timing.statusMs,
    timing.tradeMs,
    timing.coursesCountMs,
    timing.creditsMs,
    timing.courseFrequencyMs,
    timing.slowestPhase,
    timing.slowestPhaseMs,
    timing.hiccup,
    timing.message
  ].map(formatTimingField).join("|");
}

function formatTimingField(value: unknown): string {
  return String(value)
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "/")
    .trim();
}

function roundedMs(value: number): number {
  return Math.round(value);
}
