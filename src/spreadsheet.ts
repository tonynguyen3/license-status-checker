import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import { daysUntil } from "./date-utils.js";
import { Logger } from "./logger.js";
import type { CourseFrequency, OutputPaths, Tradesman } from "./types.js";

type CellValue = ExcelJS.CellValue | undefined;

function asText(value: CellValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "text" in value) return String(value.text).trim();
  if (typeof value === "object" && "result" in value) return asText(value.result);
  return String(value).trim();
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export async function readWashingtonSpreadsheet(
  inputPath: string,
  logger: Logger,
  outputPaths: OutputPaths
): Promise<Tradesman[]> {
  logger.writeToConsole("The program is now reading the spreadsheet.\n-----");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const tradesmen: Tradesman[] = [];
  let errorCount = 0;

  for (const worksheet of workbook.worksheets) {
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      if (!row.hasValues) continue;

      const licenseNumber = asText(row.getCell(2).value);
      const expirationDate = asText(row.getCell(9).value);

      if (!licenseNumber || !expirationDate) {
        await logger.writeErrorsToLog(
          "This tradesman has either no license number or no expiration date.",
          outputPaths.exceptionLogPath
        );
        errorCount++;
        continue;
      }

      const parsedExpiration = parseDate(expirationDate);
      if (!parsedExpiration) {
        await logger.writeErrorsToLog(
          `${licenseNumber}'s expiration date could not be parsed: ${expirationDate}`,
          outputPaths.exceptionLogPath
        );
        errorCount++;
        continue;
      }

      const daysTillExpiration = daysUntil(parsedExpiration);
      if (daysTillExpiration > 90) {
        await logger.writeErrorsToLog(
          `${licenseNumber}'s expiration date is greater than 90.`,
          outputPaths.greaterThan90LogPath
        );
        errorCount++;
        continue;
      }

      if (daysTillExpiration < 0) {
        await logger.writeErrorsToLog(
          `${licenseNumber}'s expiration date is in the past.`,
          outputPaths.expiredLogPath
        );
        errorCount++;
        continue;
      }

      tradesmen.push({
        licenseType: asText(row.getCell(1).value),
        licenseNumber,
        name: asText(row.getCell(3).value),
        address1: asText(row.getCell(4).value),
        address2: asText(row.getCell(5).value),
        city: asText(row.getCell(6).value),
        state: asText(row.getCell(7).value),
        zip: asText(row.getCell(8).value),
        expirationDate
      });
    }
  }

  logger.writeToConsole(
    `The program has finished reading the spreadsheet.\nThere were ${errorCount} error(s), recorded in the logs.\nIt will now check ${tradesmen.length} license(s).\n-----`
  );

  return tradesmen;
}

function tradesmanRows(tradesmen: Tradesman[]): Record<string, string | number | undefined>[] {
  return tradesmen.map((tradesman) => ({
    "License Type": tradesman.licenseType,
    "License Number": tradesman.licenseNumber,
    Name: tradesman.name,
    Address1: tradesman.address1,
    Address2: tradesman.address2,
    City: tradesman.city,
    State: tradesman.state,
    Zip: tradesman.zip,
    ExpirationDate: tradesman.expirationDate,
    NotSendReason: tradesman.notSendReason,
    Trade: tradesman.trade,
    HoursNeeded: tradesman.hoursNeeded,
    HoursCompleted: tradesman.hoursCompleted
  }));
}

export async function writeTradesmenWorkbook(tradesmen: Tradesman[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("mySheet");
  const rows = tradesmanRows(tradesmen);
  worksheet.columns = Object.keys(rows[0] ?? tradesmanRows([emptyTradesman()])[0]).map((key) => ({
    header: key,
    key,
    width: Math.max(14, key.length + 2)
  }));
  worksheet.addRows(rows);
  await workbook.xlsx.writeFile(path);
}

export async function writeCourseFrequencies(courses: CourseFrequency[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("mySheet");
  worksheet.columns = [
    { header: "Course Name", key: "Course Name", width: 40 },
    { header: "Course Code", key: "Course Code", width: 18 },
    { header: "Frequency", key: "Frequency", width: 12 }
  ];
  worksheet.addRows(
    courses.map((course) => ({
      "Course Name": course.courseName,
      "Course Code": course.courseCode,
      Frequency: course.frequency
    }))
  );
  await workbook.xlsx.writeFile(path);
}

function emptyTradesman(): Tradesman {
  return {
    licenseNumber: ""
  };
}
