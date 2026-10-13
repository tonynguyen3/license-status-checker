import type { Page } from "playwright";
import { daysUntil } from "../src/date-utils.js";
import { getHoursNeeded } from "../src/hours.js";
import { evaluateTraineeAffidavits } from "../src/trainee-affidavits.js";
import type { AffidavitRow } from "../src/trainee-affidavits.js";

export async function baseline(page: Page): Promise<string> {
  if (page.url().endsWith("default.aspx#ErrorMsg")) return "doNotSend";
  const snapshot = await page.evaluate(`(() => {
    const text = selector => document.querySelector(selector)?.textContent?.trim() || "";
    const hours = Array.from(document.querySelectorAll("span"))
      .filter(span => Array.from(span.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.includes(".00")))
      .map(span => span.textContent?.trim() || "")
      .filter(value => !value.includes("$"))
      .reduce((sum, value) => sum + (Number.parseFloat(value.split(" ")[0]) || 0), 0);
    const rows = Array.from(document.querySelectorAll("#AffidavitHours tbody tr")).map(row => {
      const cells = Array.from(row.querySelectorAll("td"));
      return { hoursReported: cells[1]?.textContent?.trim() || "", fromDate: cells[3]?.textContent?.trim() || "", toDate: cells[4]?.textContent?.trim() || "" };
    });
    return { expiration: text("#ExpirationDate"), effective: text("#EffectiveDate"), status: text("#StatusDescription strong"), trade: text("#LicenseType"), hasCourses: !!document.querySelector("#Courses"), hours, rows };
  })()`) as { expiration: string; effective: string; status: string; trade: string; hasCourses: boolean; hours: number; rows: AffidavitRow[] };
  const date = new Date(snapshot.expiration);
  if (!snapshot.expiration || Number.isNaN(date.getTime())) return "error";
  const days = daysUntil(date);
  if (days === -1 || days > 90) return "doNotSend";
  if (!snapshot.status) return "error";
  if (snapshot.status !== "Active") return "doNotSend";
  if (!snapshot.hasCourses && snapshot.trade !== "Plumber Trainee") return "send";
  if (snapshot.hours >= getHoursNeeded(snapshot.trade) || snapshot.hours > 0) return "doNotSend";
  if (snapshot.trade === "Plumber Trainee") {
    return evaluateTraineeAffidavits(snapshot.rows, snapshot.effective, snapshot.expiration).eligible ? "send" : "doNotSend";
  }
  return "send";
}
