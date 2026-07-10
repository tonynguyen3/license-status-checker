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

type TradesmanSource = Iterable<Tradesman> | AsyncIterable<Tradesman>;

class WashingtonRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WashingtonRateLimitError";
  }
}

export class WashingtonLicenseChecker {
  private readonly courseCounts = new Map<string, { courseName: string; courseCode: string; frequency: number }>();

  constructor(
    private readonly logger: Logger,
    private readonly outputPaths: OutputPaths,
    private readonly options: CheckerOptions
  ) {}

  async checkLicenses(tradesmen: TradesmanSource): Promise<CheckRunResult> {
    const total = knownTotal(tradesmen, this.options.limit);
    if (this.options.isCanceled?.()) {
      this.options.onProgress?.({
        type: "checks_canceled",
        message: "Run was stopped before website checks started.",
        current: 0,
        total,
        remaining: total
      });
      return {
        send: [],
        doNotSend: [],
        courseFrequencies: [],
        canceled: true
      };
    }

    let browser: Browser | undefined;
    let page: Page | undefined;

    try {
      const results: BucketedResult[] = [];
      const shouldCollectResults = this.options.onResult === undefined;
      let sendCount = 0;
      let doNotSendCount = 0;
      let errorCount = 0;
      let canceled = false;
      let checkedCount = 0;
      let checksStarted = false;

      for await (const tradesman of limitedTradesmen(tradesmen, this.options.limit)) {
        if (this.options.isCanceled?.()) {
          canceled = true;
          this.options.onProgress?.({
            type: "checks_canceled",
            message: `Run stopped after ${checkedCount}${total === undefined ? "" : ` of ${total}`} website check(s). Partial output files will be written.`,
            current: checkedCount,
            total,
            remaining: remainingChecks(total, checkedCount)
          });
          break;
        }

        if (!browser || !page) {
          browser = await chromium.launch({
            headless: !this.options.headed,
            slowMo: this.options.slowMo
          });
          page = await browser.newPage();
          checksStarted = true;
          this.options.onProgress?.({
            type: "checks_started",
            message: total === undefined
              ? "Starting website checks as eligible spreadsheet rows stream in."
              : `Starting ${total} website check(s).`,
            current: 0,
            total,
            remaining: total
          });
        }

        if (checkedCount > 0) {
          await this.pauseBetweenChecks();
          if (this.options.isCanceled?.()) {
            canceled = true;
            this.options.onProgress?.({
              type: "checks_canceled",
              message: `Run stopped after ${checkedCount}${total === undefined ? "" : ` of ${total}`} website check(s). Partial output files will be written.`,
              current: checkedCount,
              total,
              remaining: remainingChecks(total, checkedCount)
            });
            break;
          }
        }

        checkedCount++;

        try {
          const result = await this.checkLicense(page, tradesman);
          if (shouldCollectResults) {
            results.push(result);
          }
          await this.options.onResult?.(result);
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
              current: checkedCount,
              total,
              remaining: remainingChecks(total, checkedCount)
            });
            break;
          }
        }

        if (checkedCount % 50 === 0 || checkedCount === total) {
          this.options.onProgress?.({
            type: "checks_progress",
            message: `Checked ${checkedCount}${total === undefined ? "" : ` of ${total}`} license(s). Send: ${sendCount}. DoNotSend: ${doNotSendCount}. Errors: ${errorCount}.`,
            current: checkedCount,
            total,
            remaining: remainingChecks(total, checkedCount)
          });
        }
      }

      this.options.onProgress?.({
        type: canceled ? "checks_canceled" : "checks_complete",
        message: canceled
          ? "Website checks stopped by request."
          : checksStarted
            ? `Finished ${checkedCount}${total === undefined ? "" : ` of ${total}`} website check(s).`
            : "There were no eligible licenses to check.",
        current: checkedCount,
        total,
        remaining: canceled ? remainingChecks(total, checkedCount) : 0
      });

      return {
        send: results.filter((result) => result.bucket === "send").map((result) => result.tradesman),
        doNotSend: results.filter((result) => result.bucket === "doNotSend").map((result) => result.tradesman),
        courseFrequencies: [...this.courseCounts.values()],
        canceled
      };
    } finally {
      if (browser) {
        await closeBrowser(browser);
      }
    }
  }

  async checkLicense(page: Page, tradesman: Tradesman): Promise<BucketedResult> {
    const response = await page.goto(
      `https://secure.lni.wa.gov/verify/Detail.aspx?UBI=&LIC=${encodeURIComponent(tradesman.licenseNumber)}&SAW=`,
      { waitUntil: "load" }
    );

    if (!response) {
      throw new Error(`Washington site did not return an HTTP response for ${tradesman.licenseNumber}.`);
    }

    const httpStatus = response.status();
    if (httpStatus === 429) {
      throw new WashingtonRateLimitError(
        `Washington site returned HTTP 429 rate limit for ${tradesman.licenseNumber}.`
      );
    }

    if (httpStatus >= 400) {
      throw new Error(`Washington site returned HTTP ${httpStatus} for ${tradesman.licenseNumber}.`);
    }

    await this.throwIfRateLimitPage(page, tradesman);

    const expiration = await this.checkExpirationDate(page);
    if (expiration.days === -1) {
      return this.doNotSend(tradesman, `${tradesman.licenseNumber} is not a valid license.`);
    }

    if (expiration.days > 90) {
      tradesman.expirationDate = expiration.date.toLocaleDateString();
      return this.doNotSend(tradesman, `${tradesman.licenseNumber} has likely already renewed.`);
    }

    const status = await page.locator("#StatusDescription strong").innerText({ timeout: 10_000 });
    if (status.trim() !== "Active") {
      return this.doNotSend(tradesman, `${tradesman.licenseNumber} is not active.`);
    }

    const trade = (await page.locator("#LicenseType").innerText({ timeout: 10_000 })).trim();
    tradesman.trade = trade;
    tradesman.hoursNeeded = getHoursNeeded(trade);

    const hasCoursesSection = await page.locator("#Courses").count();
    if (hasCoursesSection === 0) {
      return { bucket: "send", tradesman };
    }

    const numberOfCredits = await this.sumCompletedCredits(page);
    tradesman.hoursCompleted = numberOfCredits;
    console.log(`${tradesman.licenseNumber} has completed ${tradesman.hoursCompleted} credits and needs ${tradesman.hoursNeeded}`);

    if (numberOfCredits > 0) {
      await this.recordCourseFrequencies(page);
    }

    if ((tradesman.hoursNeeded ?? 0) <= numberOfCredits) {
      return this.doNotSend(tradesman, ` | ${tradesman.licenseNumber} has enough credits.`);
    }

    if (numberOfCredits > 0) {
      return this.doNotSend(tradesman, ` | ${tradesman.licenseNumber} has some credits already.`);
    }

    return { bucket: "send", tradesman };
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

function knownTotal(tradesmen: TradesmanSource, limit?: number): number | undefined {
  if (!Array.isArray(tradesmen)) return limit;
  return limit === undefined ? tradesmen.length : Math.min(tradesmen.length, limit);
}

async function* limitedTradesmen(tradesmen: TradesmanSource, limit?: number): AsyncGenerator<Tradesman> {
  let count = 0;
  for await (const tradesman of toAsyncIterable(tradesmen)) {
    if (limit !== undefined && count >= limit) break;
    count++;
    yield tradesman;
  }
}

async function* toAsyncIterable(tradesmen: TradesmanSource): AsyncGenerator<Tradesman> {
  for await (const tradesman of tradesmen) {
    yield tradesman;
  }
}

function remainingChecks(total: number | undefined, current: number): number | undefined {
  return total === undefined ? undefined : Math.max(0, total - current);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
