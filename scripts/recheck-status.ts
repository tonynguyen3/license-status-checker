import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { readArgs } from "../src/cli.js";
import { readWashingtonSpreadsheet, writeTradesmenWorkbook } from "../src/spreadsheet.js";
import { buildOutputPaths } from "../src/paths.js";
import { Logger } from "../src/logger.js";
import { WashingtonLicenseChecker } from "../src/washington-checker.js";
import type { BucketedResult, Tradesman } from "../src/types.js";

const args = readArgs(process.argv.slice(2));
const targets = ["DAHLSA*814JC", "HERRIJD796DC", "WOMACJ*045M9", "HICKEK*077CC"];
await mkdir(args.outDir, { recursive: true });
const paths = buildOutputPaths(args.outDir);
const candidates = (await readWashingtonSpreadsheet(args.input, new Logger(), paths, { worksheetName: "Plumbers" })).filter(person => targets.includes(person.licenseNumber));
if (candidates.length !== targets.length) throw new Error("All four spot-check licenses must be present and eligible.");
const checker = new WashingtonLicenseChecker(new Logger(), paths, { headed: false, slowMo: 0, checkDelayMs: args.checkDelayMs });
const internal = checker as unknown as { checkSingleLicense(page: Page, person: Tradesman): Promise<BucketedResult> };
const browser = await chromium.launch({ headless: true });
const send: Tradesman[] = [], doNotSend: Tradesman[] = [];
const results: unknown[] = [];
let navigations = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/*", async route => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      if (navigations >= 8) { await route.abort(); return; }
      navigations++;
    }
    await route.continue();
  });
  for (const person of candidates) {
    let error = "", bucket = "error";
    try {
      const result = await internal.checkSingleLicense(page, person);
      bucket = result.bucket;
      (bucket === "send" ? send : doNotSend).push(person);
    } catch (caught) { error = String(caught); }
    const stem = join(args.outDir, encodeURIComponent(person.licenseNumber).replace(/\*/g, "%2A"));
    await page.screenshot({ path: `${stem}.png`, fullPage: true });
    await writeFile(`${stem}.html`, await page.content());
    const status = await page.evaluate(`(() => {
      const e = document.querySelector("#StatusDescription strong");
      return { raw: e?.textContent, rendered: e?.innerText, transform: e ? getComputedStyle(e).textTransform : null };
    })()`);
    results.push({ license: person.licenseNumber, bucket, reason: person.decisionReason, error, status, screenshot: `${stem}.png` });
    console.log(JSON.stringify(results[results.length - 1]));
    if (/429|rate.?limit|F5/i.test(error)) break;
    await page.waitForTimeout(args.checkDelayMs);
  }
} finally { await browser.close(); }
await writeTradesmenWorkbook(send, paths.sendPath);
await writeTradesmenWorkbook(doNotSend, paths.doNotSendPath);
await writeFile(join(args.outDir, "recheck.json"), JSON.stringify({ navigations, results }, null, 2));
