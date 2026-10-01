import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type Browser, type Page } from "playwright";
import { daysUntil } from "./date-utils.js";
import { getHoursNeeded } from "./hours.js";
import { Logger } from "./logger.js";
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

        try {
          const result = await this.checkSingleLicense(page, tradesman);
          results.push(result);
          if (result.bucket === "send") {
            sendCount++;
          } else {
            doNotSendCount++;
          }
        } catch (error) {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          console.log(`There was an error with ${tradesman.licenseNumber}.`);
          await this.logger.writeErrorsToLog(
            `License ${tradesman.licenseNumber}\n${message}\nThere was a Playwright error.`,
            this.outputPaths.exceptionLogPath
          );
          errorCount++;

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
      if (expiration.days === -1) {
        const result = this.doNotSend(tradesman, `${tradesman.licenseNumber} is not a valid license.`);
        timing.outcome = "success";
        timing.bucket = result.bucket;
        timing.message = tradesman.notSendReason ?? "Invalid license.";
        return result;
      }

      if (expiration.days > 90) {
        tradesman.expirationDate = expiration.date.toLocaleDateString();
        const result = this.doNotSend(tradesman, `${tradesman.licenseNumber} has likely already renewed.`);
        timing.outcome = "success";
        timing.bucket = result.bucket;
        timing.message = tradesman.notSendReason ?? "Likely renewed.";
        return result;
      }

      const status = await timePhase(timing, "statusMs", () => page.locator("#StatusDescription strong").innerText({ timeout: 10_000 }));
      if (status.trim() !== "Active") {
        const result = this.doNotSend(tradesman, `${tradesman.licenseNumber} is not active.`);
        timing.outcome = "success";
        timing.bucket = result.bucket;
        timing.message = tradesman.notSendReason ?? "Not active.";
        return result;
      }

      const trade = (await timePhase(timing, "tradeMs", () => page.locator("#LicenseType").innerText({ timeout: 10_000 }))).trim();
      tradesman.trade = trade;
      tradesman.hoursNeeded = getHoursNeeded(trade);

      const hasCoursesSection = await timePhase(timing, "coursesCountMs", () => page.locator("#Courses").count());
      if (hasCoursesSection === 0) {
        timing.outcome = "success";
        timing.bucket = "send";
        timing.message = "No courses section found; send.";
        return { bucket: "send", tradesman };
      }

      const numberOfCredits = await timePhase(timing, "creditsMs", () => this.sumCompletedCredits(page));
      tradesman.hoursCompleted = numberOfCredits;
      console.log(`${tradesman.licenseNumber} has completed ${tradesman.hoursCompleted} credits and needs ${tradesman.hoursNeeded}`);

      if (numberOfCredits > 0) {
        await timePhase(timing, "courseFrequencyMs", () => this.recordCourseFrequencies(page));
      }

      if ((tradesman.hoursNeeded ?? 0) <= numberOfCredits) {
        const result = this.doNotSend(tradesman, ` | ${tradesman.licenseNumber} has enough credits.`);
        timing.outcome = "success";
        timing.bucket = result.bucket;
        timing.message = tradesman.notSendReason ?? "Enough credits.";
        return result;
      }

      if (numberOfCredits > 0) {
        const result = this.doNotSend(tradesman, ` | ${tradesman.licenseNumber} has some credits already.`);
        timing.outcome = "success";
        timing.bucket = result.bucket;
        timing.message = tradesman.notSendReason ?? "Some credits already.";
        return result;
      }

      timing.outcome = "success";
      timing.bucket = "send";
      timing.message = "No completed credits; send.";
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

  private async checkExpirationDate(page: Page): Promise<{ days: number; date: Date }> {
    if (page.url() === "https://secure.lni.wa.gov/verify/default.aspx#ErrorMsg") {
      return { days: -1, date: new Date(0) };
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

  private async sumCompletedCredits(page: Page): Promise<number> {
    const potentialCredits = page.locator("xpath=//span[contains(text(),'.00')]");
    const count = await potentialCredits.count();
    let total = 0;

    for (let i = 0; i < count; i++) {
      let text = (await potentialCredits.nth(i).innerText()).trim();
      if (text.includes("$")) continue;

      const firstSpace = text.indexOf(" ");
      if (firstSpace > 0) {
        text = text.slice(0, firstSpace);
      }

      const parsed = Number.parseFloat(text);
      if (!Number.isNaN(parsed)) {
        total += parsed;
      }
    }

    return total;
  }

  private async recordCourseFrequencies(page: Page): Promise<void> {
    const courseBlocks = page.locator("#coursesList .itemSingleCol");
    const count = await courseBlocks.count();

    for (let i = 0; i < count; i++) {
      const block = courseBlocks.nth(i);

      try {
        const nameLabel = block.locator("label");
        const labelText = (await nameLabel.innerText()).trim();
        const sibling = block.locator("xpath=following-sibling::div").locator("xpath=following-sibling::div");
        const codeLabel = sibling.locator("label");
        const codeLabelText = (await codeLabel.innerText()).trim();

        if (labelText !== "Course title" || codeLabelText !== "Course code") continue;

        const courseName = (await nameLabel.locator("xpath=following-sibling::span").innerText()).trim();
        const courseCode = (await codeLabel.locator("xpath=following-sibling::span").innerText()).trim();
        const key = `${courseName}\u0000${courseCode}`;
        const existing = this.courseCounts.get(key);

        if (existing) {
          existing.frequency++;
        } else {
          this.courseCounts.set(key, { courseName, courseCode, frequency: 1 });
        }
      } catch {
        continue;
      }
    }
  }

  private doNotSend(tradesman: Tradesman, reason: string): BucketedResult {
    console.log(reason);
    tradesman.notSendReason = reason;
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
