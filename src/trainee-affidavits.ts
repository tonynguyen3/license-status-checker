export interface AffidavitRow {
  hoursReported: string;
  fromDate: string;
  toDate: string;
}

interface AffidavitDecision {
  eligible: boolean;
  reason: string;
  fromDate?: string;
  toDate?: string;
  hoursReported?: number;
  wholeWeeks?: number;
  hoursPerWeek?: number;
}

function calendarDate(text: string): number | undefined {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!match) return undefined;
  const [, month, day, year] = match.map(Number);
  const value = Date.UTC(year, month - 1, day);
  const date = new Date(value);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? value : undefined;
}

export function evaluateTraineeAffidavits(
  rows: AffidavitRow[], effectiveText: string, expirationText: string, today = new Date()
): AffidavitDecision {
  const effective = calendarDate(effectiveText);
  const expiration = calendarDate(expirationText);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const reject = (reason: string): AffidavitDecision => ({ eligible: false, reason });
  if (effective === undefined || expiration === undefined || effective > expiration) {
    return reject("License effective/expiration dates are missing or invalid.");
  }
  if (now < effective || now > expiration) return reject("License is outside its effective/expiration period.");
  if (!rows.length) return reject("No affidavit hours reported.");

  const parsed = rows.map(row => ({
    ...row, from: calendarDate(row.fromDate), to: calendarDate(row.toDate),
    hours: row.hoursReported.trim() ? Number(row.hoursReported.replace(/,/g, "")) : NaN
  }));
  // Do not fall back to an older affidavit when a newer row cannot be interpreted.
  if (parsed.some(row => row.to === undefined)) return reject("An affidavit To Date is missing or invalid.");
  parsed.sort((a, b) => b.to! - a.to! || (b.from ?? 0) - (a.from ?? 0));
  const latest = parsed[0];
  // Employers can report separately for the same period; total those reported hours.
  const period = parsed.filter(row => row.to === latest.to && row.from === latest.from);
  const hoursReported = period.reduce((sum, row) => sum + row.hours, 0);
  if (latest.from === undefined || latest.from >= latest.to! || period.some(row => !Number.isFinite(row.hours) || row.hours < 0)) {
    return reject("Latest affidavit dates or reported hours are invalid.");
  }
  const wholeWeeks = Math.floor((latest.to! - latest.from) / (7 * 24 * 60 * 60 * 1000));
  const details = { fromDate: latest.fromDate, toDate: latest.toDate, hoursReported, wholeWeeks };
  const fail = (reason: string): AffidavitDecision => ({ eligible: false, reason, ...details });
  // Only To Date must fall within the license period; From Date is used for the average.
  if (latest.to! < effective || latest.to! > expiration) return fail("Latest affidavit To Date is outside the license effective/expiration period.");
  if (latest.to! > now) return fail("Latest affidavit To Date is in the future.");
  // Compare calendar days in UTC so daylight-saving changes do not shift the boundary.
  const cutoff = now - 365 * 24 * 60 * 60 * 1000;
  if (latest.to! < cutoff) return fail("Latest affidavit To Date is more than 365 days old.");
  if (wholeWeeks < 1) return fail("Latest affidavit period contains fewer than one whole week.");
  // Discard leftover days as requested: a 365-day period is 52 weeks.
  const average = hoursReported / wholeWeeks;
  return {
    ...details, hoursPerWeek: Math.round(average * 100) / 100,
    eligible: average >= 20,
    reason: average >= 20 ? "Recent affidavit reports at least 20 hours per week."
      : "Latest affidavit reports fewer than 20 hours per week."
  };
}
