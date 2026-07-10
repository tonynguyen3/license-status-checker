import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import { SaxesParser } from "saxes";
import { daysUntil } from "./date-utils.js";
import { Logger } from "./logger.js";
import type { CourseFrequency, OutputPaths, ProgressReporter, Tradesman } from "./types.js";

const require = createRequire(import.meta.url);
type CellValue = ExcelJS.CellValue | undefined;
const SUPPORTED_WORKSHEET_NAMES = ["Plumbers", "Plumber Trainees", "Electricians"] as const;
const SUPPORTED_WORKSHEET_NAME_SET = new Set(SUPPORTED_WORKSHEET_NAMES.map((name) => normalizeWorksheetName(name)));

interface ReadSpreadsheetOptions {
  worksheetName?: string;
  onProgress?: ProgressReporter;
}

interface StreamingWorksheetReader {
  name: string;
  [Symbol.asyncIterator](): AsyncGenerator<ExcelJS.Row>;
}

interface WorkbookStreamMetadata {
  workbookRels: Array<{ Id: string; Target: string }>;
  model: {
    sheets: Array<{ id: number; name: string; rId: string; state?: string }>;
  };
}

interface ZipDirectory {
  files: Array<{
    path: string;
    buffer(): Promise<Buffer>;
  }>;
}

export function asText(value: CellValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === "object" && "text" in value) return String(value.text).trim();
  if (typeof value === "object" && "result" in value) return asText(value.result);
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

export function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export async function readWashingtonSpreadsheet(
  inputPath: string,
  logger: Logger,
  outputPaths: OutputPaths,
  options: ReadSpreadsheetOptions = {}
): Promise<Tradesman[]> {
  const tradesmen: Tradesman[] = [];
  for await (const tradesman of readEligibleTradesmen(inputPath, logger, outputPaths, options)) {
    tradesmen.push(tradesman);
  }

  return tradesmen;
}

export async function* readEligibleTradesmen(
  inputPath: string,
  logger: Logger,
  outputPaths: OutputPaths,
  options: ReadSpreadsheetOptions = {}
): AsyncGenerator<Tradesman> {
  logger.writeToConsole("The program is now reading the spreadsheet.\n-----");
  options.onProgress?.({ type: "spreadsheet_loading", message: "Loading the input spreadsheet." });

  validateRequestedWorksheet(options.worksheetName);

  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(inputPath, {
    worksheets: "emit",
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    entries: "ignore"
  });
  await primeWorkbookReaderMetadata(workbook, inputPath);

  let errorCount = 0;
  let rowsRead = 0;
  let eligibleCount = 0;
  let foundRequestedWorksheet = false;

  if (options.worksheetName) {
    logger.writeToConsole(`Only reading worksheet "${options.worksheetName}".`);
  }

  options.onProgress?.({
    type: "spreadsheet_loaded",
    message: "Loaded the workbook. Streaming supported worksheet rows now."
  });

  for await (const worksheetReader of workbook) {
    const worksheet = worksheetReader as unknown as StreamingWorksheetReader;
    if (!shouldReadWorksheet(worksheet.name, options.worksheetName)) continue;

    if (options.worksheetName) {
      foundRequestedWorksheet = true;
    }

    options.onProgress?.({
      type: "worksheet_started",
      message: `Reading worksheet "${worksheet.name}".`,
      current: rowsRead
    });

    const worksheetStartEligible = eligibleCount;
    const worksheetStartErrors = errorCount;

    for await (const row of worksheet) {
      if (row.number === 1) continue;

      rowsRead++;
      if (rowsRead === 1 || rowsRead % 100 === 0) {
        options.onProgress?.({
          type: "spreadsheet_row",
          message: `Read ${rowsRead} spreadsheet row(s). Eligible so far: ${eligibleCount}. Skipped/logged so far: ${errorCount}.`,
          current: rowsRead
        });
      }

      const rowLocation = `${worksheet.name}!${row.number}`;
      if (!row.hasValues) {
        await logger.writeErrorsToLog(`Skipped ${rowLocation}: row has no values.`, outputPaths.exceptionLogPath);
        errorCount++;
        continue;
      }

      const licenseNumber = asText(row.getCell(2).value);
      const expirationDate = asText(row.getCell(9).value);

      if (!licenseNumber || !expirationDate) {
        await logger.writeErrorsToLog(
          `Skipped ${rowLocation}: this tradesman has either no license number or no expiration date.`,
          outputPaths.exceptionLogPath
        );
        errorCount++;
        continue;
      }

      const parsedExpiration = parseDate(expirationDate);
      if (!parsedExpiration) {
        await logger.writeErrorsToLog(
          `Skipped ${rowLocation} (${licenseNumber}): expiration date could not be parsed: ${expirationDate}`,
          outputPaths.exceptionLogPath
        );
        errorCount++;
        continue;
      }

      const daysTillExpiration = daysUntil(parsedExpiration);
      if (daysTillExpiration > 90) {
        await logger.writeErrorsToLog(
          `Skipped ${rowLocation} (${licenseNumber}): expiration date is greater than 90 days away.`,
          outputPaths.greaterThan90LogPath
        );
        errorCount++;
        continue;
      }

      if (daysTillExpiration < 0) {
        await logger.writeErrorsToLog(
          `Skipped ${rowLocation} (${licenseNumber}): expiration date is in the past.`,
          outputPaths.expiredLogPath
        );
        errorCount++;
        continue;
      }

      yield {
        licenseType: asText(row.getCell(1).value),
        licenseNumber,
        name: asText(row.getCell(3).value),
        address1: asText(row.getCell(4).value),
        address2: asText(row.getCell(5).value),
        city: asText(row.getCell(6).value),
        state: asText(row.getCell(7).value),
        zip: asText(row.getCell(8).value),
        expirationDate
      };
      eligibleCount++;
    }

    options.onProgress?.({
      type: "worksheet_complete",
      message: `Finished worksheet "${worksheet.name}". Eligible: ${eligibleCount - worksheetStartEligible}. Skipped/logged: ${errorCount - worksheetStartErrors}.`,
      current: rowsRead
    });
  }

  if (options.worksheetName && !foundRequestedWorksheet) {
    throw new Error(`Worksheet "${options.worksheetName}" was not found. Supported worksheets: ${supportedWorksheetNamesForMessage()}`);
  }

  logger.writeToConsole(
    `The program has finished reading the spreadsheet.\nThere were ${errorCount} error(s), recorded in the logs.\nIt will now check ${eligibleCount} license(s).\n-----`
  );
  options.onProgress?.({
    type: "spreadsheet_complete",
    message: `Spreadsheet read complete. ${eligibleCount} license(s) are eligible for website checks.`,
    current: rowsRead,
    total: eligibleCount
  });
}

function validateRequestedWorksheet(worksheetName?: string): void {
  if (!worksheetName) return;

  const normalizedName = normalizeWorksheetName(worksheetName);
  if (!SUPPORTED_WORKSHEET_NAME_SET.has(normalizedName)) {
    throw new Error(`Worksheet "${worksheetName}" is not supported. Supported worksheets: ${supportedWorksheetNamesForMessage()}`);
  }
}

function shouldReadWorksheet(sheetName: string, worksheetName?: string): boolean {
  const normalizedSheetName = normalizeWorksheetName(sheetName);
  if (worksheetName) return normalizedSheetName === normalizeWorksheetName(worksheetName);
  return SUPPORTED_WORKSHEET_NAME_SET.has(normalizedSheetName);
}

function supportedWorksheetNamesForMessage(): string {
  return SUPPORTED_WORKSHEET_NAMES.map((name) => `"${name}"`).join(", ");
}

async function primeWorkbookReaderMetadata(workbook: ExcelJS.stream.xlsx.WorkbookReader, inputPath: string): Promise<void> {
  const metadata = await readWorkbookStreamMetadata(inputPath);
  const workbookWithMetadata = workbook as unknown as {
    workbookRels?: WorkbookStreamMetadata["workbookRels"];
    model?: WorkbookStreamMetadata["model"];
  };
  workbookWithMetadata.workbookRels = metadata.workbookRels;
  workbookWithMetadata.model = metadata.model;
}

async function readWorkbookStreamMetadata(inputPath: string): Promise<WorkbookStreamMetadata> {
  const [workbookXml, relationshipsXml] = await Promise.all([
    readZipEntryText(inputPath, "xl/workbook.xml"),
    readZipEntryText(inputPath, "xl/_rels/workbook.xml.rels")
  ]);

  if (!workbookXml || !relationshipsXml) {
    throw new Error("Input workbook is missing required worksheet metadata.");
  }

  return {
    workbookRels: parseWorkbookRelationships(relationshipsXml),
    model: {
      sheets: parseWorkbookSheets(workbookXml)
    }
  };
}

async function readZipEntryText(inputPath: string, entryPath: string): Promise<string | undefined> {
  const unzipper = require("unzipper") as {
    Open: {
      file(path: string): Promise<ZipDirectory>;
    };
  };
  const directory = await unzipper.Open.file(inputPath);
  const entry = directory.files.find((file) => file.path === entryPath);
  if (!entry) return undefined;
  return (await entry.buffer()).toString("utf8");
}

function parseWorkbookSheets(xml: string): WorkbookStreamMetadata["model"]["sheets"] {
  const sheets: WorkbookStreamMetadata["model"]["sheets"] = [];
  const parser = new SaxesParser({ xmlns: false });

  parser.on("opentag", (tag) => {
    if (tag.name !== "sheet") return;

    const attributes = tag.attributes as Record<string, string>;
    const sheetId = Number(attributes.sheetId);
    const name = attributes.name;
    const rId = attributes["r:id"];

    if (!name || !rId || !Number.isFinite(sheetId)) return;

    sheets.push({
      id: sheetId,
      name,
      rId,
      state: attributes.state
    });
  });
  parser.write(xml).close();

  return sheets;
}

function parseWorkbookRelationships(xml: string): WorkbookStreamMetadata["workbookRels"] {
  const relationships: WorkbookStreamMetadata["workbookRels"] = [];
  const parser = new SaxesParser({ xmlns: false });

  parser.on("opentag", (tag) => {
    if (tag.name !== "Relationship") return;

    const attributes = tag.attributes as Record<string, string>;
    const Id = attributes.Id;
    const Target = normalizeWorkbookRelationshipTarget(attributes.Target);
    if (!Id || !Target) return;

    relationships.push({ Id, Target });
  });
  parser.write(xml).close();

  return relationships;
}

function normalizeWorkbookRelationshipTarget(target: string | undefined): string | undefined {
  return target
    ?.replace(/^\/?xl\//, "")
    .replace(/^\//, "");
}

function normalizeWorksheetName(name: string): string {
  return name.trim().toLowerCase();
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
