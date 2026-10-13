import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { readArgs } from "../src/cli.js";
import { readWashingtonSpreadsheet, writeTradesmenWorkbook } from "../src/spreadsheet.js";
import { buildOutputPaths } from "../src/paths.js";
import { Logger } from "../src/logger.js";
import { WashingtonLicenseChecker } from "../src/washington-checker.js";
import type { BucketedResult, Tradesman } from "../src/types.js";
import { baseline } from "./baseline-outreach.js";

const args = readArgs(process.argv.slice(2));
if (!args.limit || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 35) throw new Error("Use --limit 1 through 35.");
await mkdir(join(args.outDir, "pages"), { recursive: true });
const paths = buildOutputPaths(args.outDir);
const all = await readWashingtonSpreadsheet(args.input, new Logger(), paths, { worksheetName: args.worksheet });
const candidates = all.slice(0, args.limit);
const checker = new WashingtonLicenseChecker(new Logger(), paths, { headed: false, slowMo: 0, checkDelayMs: args.checkDelayMs });
const internal = checker as unknown as { checkSingleLicense(page: Page, tradesman: Tradesman): Promise<BucketedResult> };
const browser = await chromium.launch({ headless: true });
const newSend: Tradesman[] = [], newDoNotSend: Tradesman[] = [], oldSend: Tradesman[] = [], oldDoNotSend: Tradesman[] = [];
const rows: Array<{ license: string; oldBucket: string; newBucket: string; reason: string }> = [];
let navigations = 0, consecutiveErrors = 0;
let stopReason = "Sample completed.";
try {
  const page = await browser.newPage();
  await page.route("**/*", async route => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      if (navigations >= 35) { await route.abort(); return; }
      navigations++;
    }
    await route.continue();
  });
  for (let i = 0; i < candidates.length && navigations < 35; i++) {
    const person = candidates[i], previous = { ...person };
    let newBucket = "error", oldBucket = "error", reason = "";
    try {
      const result = await internal.checkSingleLicense(page, person);
      newBucket = result.bucket;
      reason = person.decisionReason ?? "";
      (newBucket === "send" ? newSend : newDoNotSend).push(person);
      consecutiveErrors = 0;
    } catch (error) {
      reason = String(error);
      consecutiveErrors++;
      await new Logger().writeErrorsToLog(`${person.licenseNumber}: ${reason}`, paths.exceptionLogPath);
    }
    const limited = /429|rate.?limit|F5/i.test(reason);
    await writeFile(join(args.outDir, "pages", `${i + 1}.html`), await page.content());
    if (!limited) {
      try { oldBucket = await baseline(page); } catch { /* Keep failed parses out of both buckets. */ }
    }
    if (oldBucket === "send") oldSend.push(previous);
    if (oldBucket === "doNotSend") oldDoNotSend.push(previous);
    rows.push({ license: person.licenseNumber, oldBucket, newBucket, reason });
    // Persist each completed result so an interrupted run is still auditable.
    await writeFile(join(args.outDir, "comparison-rows.json"), JSON.stringify(rows, null, 2));
    console.log(`Compared ${i + 1}/${candidates.length}: old=${oldBucket}, new=${newBucket}. ${reason}`);
    if (limited) { stopReason = "Stopped on rate limiting."; break; }
    if (consecutiveErrors >= 3) { stopReason = "Stopped after three consecutive website errors."; break; }
    if (i + 1 < candidates.length) await page.waitForTimeout(args.checkDelayMs);
  }
  if (navigations >= 35) stopReason = "Reached navigation cap.";
} finally { await browser.close(); }
await writeTradesmenWorkbook(newSend, paths.sendPath);
await writeTradesmenWorkbook(newDoNotSend, paths.doNotSendPath);
await writeTradesmenWorkbook(oldSend, join(args.outDir, "Baseline-Send.xlsx"));
await writeTradesmenWorkbook(oldDoNotSend, join(args.outDir, "Baseline-DoNotSend.xlsx"));
const summary = {
  input: args.input, worksheet: args.worksheet, eligible: all.length, requested: args.limit, compared: rows.length, navigations, stopReason,
  old: { send: oldSend.length, doNotSend: oldDoNotSend.length, errors: rows.filter(row => row.oldBucket === "error").length },
  new: { send: newSend.length, doNotSend: newDoNotSend.length, errors: rows.filter(row => row.newBucket === "error").length },
  changed: rows.filter(row => row.oldBucket !== row.newBucket), rows
};
await writeFile(join(args.outDir, "comparison.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
