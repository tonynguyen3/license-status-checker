import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { readArgs } from "../src/cli.js";
import { readWashingtonSpreadsheet, writeTradesmenWorkbook } from "../src/spreadsheet.js";
import { buildOutputPaths } from "../src/paths.js";
import { Logger } from "../src/logger.js";
import { WashingtonLicenseChecker } from "../src/washington-checker.js";
import type { BucketedResult, Tradesman } from "../src/types.js";
import { baseline } from "./baseline-outreach.js";

// Replay captured pages with all network traffic blocked, comparing the same records.
const args = readArgs(process.argv.slice(2));
const replayIndex = process.argv.indexOf("--replay-from");
if (replayIndex < 0) throw new Error("Provide --replay-from with a captured run directory. This script is offline only.");
const replayDir = process.argv[replayIndex + 1];
await mkdir(args.outDir, { recursive: true });
const paths = buildOutputPaths(args.outDir);
const eligible = await readWashingtonSpreadsheet(args.input, new Logger(), paths, { worksheetName: args.worksheet });
const byLicense = new Map(eligible.map(person => [person.licenseNumber, person]));
const timing = (await readFile(join(replayDir, "timings.txt"), "utf8")).trim().split("\n");
const pageCount = (await readdir(join(replayDir, "pages"))).filter(name => /^\d+\.html$/.test(name)).length;
const checker = new WashingtonLicenseChecker(new Logger(), paths, { headed: false, slowMo: 0, checkDelayMs: 0 });
const internal = checker as unknown as { checkSingleLicense(page: Page, tradesman: Tradesman): Promise<BucketedResult> };
const browser = await chromium.launch({ headless: true });
const rows: Array<{ license: string; oldBucket: string; newBucket: string; reason: string }> = [];
const newSend: Tradesman[] = [], newDoNotSend: Tradesman[] = [], oldSend: Tradesman[] = [], oldDoNotSend: Tradesman[] = [];
let html = "";
try {
  const page = await browser.newPage();
  await page.route("**/*", async route => {
    if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()) {
      await route.fulfill({ status: 200, contentType: "text/html", body: html });
    } else await route.abort();
  });
  for (let i = 0; i < Math.min(pageCount, args.limit ?? pageCount); i++) {
    const license = timing[i].split("|")[1];
    const tradesman = byLicense.get(license);
    if (!tradesman) throw new Error(`Saved license no longer eligible: ${license}`);
    const previous = { ...tradesman };
    html = (await readFile(join(replayDir, "pages", `${i + 1}.html`), "utf8")).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    await page.setContent(html);
    const oldBucket = await baseline(page);
    // Captured HTML can contain collapsed/hidden sections that were revealed by scripts.
    // Rebuild a plain fixture from the captured values so innerText sees the same data.
    const saved = await page.evaluate(`(() => {
      const text = selector => document.querySelector(selector)?.textContent?.trim() || "";
      return { expiration: text("#ExpirationDate"), effective: text("#EffectiveDate"), status: text("#StatusDescription strong"), trade: text("#LicenseType"),
        courses: document.querySelector("#Courses")?.outerHTML || "", affidavit: document.querySelector("#AffidavitHours")?.outerHTML || "" };
    })()`) as { expiration: string; effective: string; status: string; trade: string; courses: string; affidavit: string };
    const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    html = `<span id="ExpirationDate">${escape(saved.expiration)}</span><span id="EffectiveDate">${escape(saved.effective)}</span>
      <span id="LicenseType">${escape(saved.trade)}</span><span id="StatusDescription"><strong>${escape(saved.status)}</strong></span>
      ${saved.courses}${saved.affidavit}`.replace(/\sstyle="[^"]*"/gi, "");
    let newBucket = "error";
    let reason = "Saved website page has missing license data.";
    if (oldBucket !== "error") {
      try {
        const result = await internal.checkSingleLicense(page, tradesman);
        newBucket = result.bucket;
        reason = tradesman.decisionReason ?? "";
        (newBucket === "send" ? newSend : newDoNotSend).push(tradesman);
      } catch (error) { reason = String(error); }
    }
    if (oldBucket === "send") oldSend.push(previous);
    if (oldBucket === "doNotSend") oldDoNotSend.push(previous);
    if (newBucket === "error") await new Logger().writeErrorsToLog(`${license}: ${reason}`, paths.exceptionLogPath);
    rows.push({ license, oldBucket, newBucket, reason });
    console.log(`Replay ${i + 1}/${pageCount}: old=${oldBucket}, new=${newBucket}. ${reason}`);
  }
} finally { await browser.close(); }
await writeTradesmenWorkbook(newSend, paths.sendPath);
await writeTradesmenWorkbook(newDoNotSend, paths.doNotSendPath);
await writeTradesmenWorkbook(oldSend, join(args.outDir, "Baseline-Send.xlsx"));
await writeTradesmenWorkbook(oldDoNotSend, join(args.outDir, "Baseline-DoNotSend.xlsx"));
const summary = {
  input: args.input, worksheet: args.worksheet, compared: rows.length, replayDir, liveRequests: 0,
  old: { send: oldSend.length, doNotSend: oldDoNotSend.length, errors: rows.filter(row => row.oldBucket === "error").length },
  new: { send: newSend.length, doNotSend: newDoNotSend.length, errors: rows.filter(row => row.newBucket === "error").length },
  changed: rows.filter(row => row.oldBucket !== row.newBucket), rows
};
await writeFile(join(args.outDir, "comparison.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
