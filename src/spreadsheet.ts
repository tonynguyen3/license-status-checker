import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  skipUntilAfterLicenseNumber?: string;
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
  const serialDate = parseExcelSerialDate(value);
  if (serialDate) return serialDate;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseExcelSerialDate(value: string): Date | undefined {
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;

  const serial = Number(text);
  if (!Number.isFinite(serial) || serial < 1 || serial > 100000) return undefined;

  const excelEpoch = Date.UTC(1899, 11, 30);
  const utcDate = new Date(excelEpoch + Math.floor(serial) * 24 * 60 * 60 * 1000);
  return new Date(utcDate.getUTCFullYear(), utcDate.getUTCMonth(), utcDate.getUTCDate());
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
  const resumeAfterLicenseNumber = options.skipUntilAfterLicenseNumber?.trim();
  let skippingForResume = resumeAfterLicenseNumber !== undefined && resumeAfterLicenseNumber.length > 0;
  let skippedForResume = 0;

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
          message: `Read ${rowsRead} spreadsheet row(s). Current location: ${worksheet.name}!${row.number}. Eligible so far: ${eligibleCount}. Skipped/logged so far: ${errorCount}.`,
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

      if (skippingForResume) {
        skippedForResume++;
        if (normalizeLicenseNumber(licenseNumber) === normalizeLicenseNumber(resumeAfterLicenseNumber)) {
          skippingForResume = false;
          options.onProgress?.({
            type: "resume_checkpoint_found",
            message: `Resume checkpoint ${licenseNumber} found after skipping ${skippedForResume} eligible row(s). Continuing with the next eligible row.`,
            current: rowsRead
          });
        }
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
        expirationDate: parsedExpiration.toLocaleDateString(),
        sourceWorksheet: worksheet.name,
        sourceRowNumber: row.number,
        sourceLocation: rowLocation
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

  if (skippingForResume && resumeAfterLicenseNumber) {
    throw new Error(`Resume checkpoint license "${resumeAfterLicenseNumber}" was not found in the eligible spreadsheet rows.`);
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

function normalizeLicenseNumber(licenseNumber: string | undefined): string {
  return licenseNumber?.trim().toUpperCase() ?? "";
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
  return tradesmen.map(tradesmanRow);
}

function tradesmanRow(tradesman: Tradesman): Record<string, string | number | undefined> {
  return {
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
    HoursCompleted: tradesman.hoursCompleted,
    SourceWorksheet: tradesman.sourceWorksheet,
    SourceRow: tradesman.sourceRowNumber,
    SourceLocation: tradesman.sourceLocation
  };
}

const TRADESMAN_COLUMNS = Object.keys(tradesmanRow(emptyTradesman())).map((key) => ({
  header: key,
  key,
  width: Math.max(14, key.length + 2)
}));

export async function writeTradesmenWorkbook(tradesmen: Tradesman[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("mySheet");
  const rows = tradesmanRows(tradesmen);
  worksheet.columns = TRADESMAN_COLUMNS;
  worksheet.addRows(rows);
  await workbook.xlsx.writeFile(path);
}

export async function writeTradesmenWorkbookFromCsv(csvPath: string, workbookPath: string): Promise<void> {
  const tradesmen = await readTradesmenCsv(csvPath);
  await writeTradesmenWorkbook(tradesmen, workbookPath);
}

export async function readTradesmenWorkbook(path: string): Promise<Tradesman[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const tradesmen: Tradesman[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const licenseNumber = asText(row.getCell(2).value);
    if (!licenseNumber) return;

    tradesmen.push({
      licenseType: asText(row.getCell(1).value),
      licenseNumber,
      name: asText(row.getCell(3).value),
      address1: asText(row.getCell(4).value),
      address2: asText(row.getCell(5).value),
      city: asText(row.getCell(6).value),
      state: asText(row.getCell(7).value),
      zip: asText(row.getCell(8).value),
      expirationDate: asText(row.getCell(9).value),
      notSendReason: asText(row.getCell(10).value),
      trade: asText(row.getCell(11).value),
      hoursNeeded: asNumber(row.getCell(12).value),
      hoursCompleted: asNumber(row.getCell(13).value),
      sourceWorksheet: asText(row.getCell(14).value),
      sourceRowNumber: asNumber(row.getCell(15).value),
      sourceLocation: asText(row.getCell(16).value)
    });
  });

  return tradesmen;
}

export async function readTradesmenCsv(path: string): Promise<Tradesman[]> {
  const content = await readFile(path, "utf8");
  const rows = parsePipeDelimited(content);
  if (rows.length === 0) return [];

  const [headers, ...dataRows] = rows;
  const columnIndex = new Map(headers.map((header, index) => [header, index]));
  const value = (row: string[], header: string): string | undefined => {
    const index = columnIndex.get(header);
    if (index === undefined) return undefined;
    return row[index] || undefined;
  };

  return dataRows
    .map((row): Tradesman | undefined => {
      const licenseNumber = value(row, "License Number");
      if (!licenseNumber) return undefined;

      return {
        licenseType: value(row, "License Type"),
        licenseNumber,
        name: value(row, "Name"),
        address1: value(row, "Address1"),
        address2: value(row, "Address2"),
        city: value(row, "City"),
        state: value(row, "State"),
        zip: value(row, "Zip"),
        expirationDate: value(row, "ExpirationDate"),
        notSendReason: value(row, "NotSendReason"),
        trade: value(row, "Trade"),
        hoursNeeded: asNumber(value(row, "HoursNeeded")),
        hoursCompleted: asNumber(value(row, "HoursCompleted")),
        sourceWorksheet: value(row, "SourceWorksheet"),
        sourceRowNumber: asNumber(value(row, "SourceRow")),
        sourceLocation: value(row, "SourceLocation")
      } satisfies Tradesman;
    })
    .filter((tradesman): tradesman is Tradesman => tradesman !== undefined);
}

function asNumber(value: CellValue): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  const text = asText(value);
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

export class StreamingTradesmenWorkbookWriter {
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private readonly worksheet: ExcelJS.Worksheet;
  private committed = false;
  count = 0;

  private constructor(path: string) {
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path,
      useSharedStrings: false,
      useStyles: false
    });
    this.worksheet = this.workbook.addWorksheet("mySheet");
    this.worksheet.columns = TRADESMAN_COLUMNS;
    this.worksheet.getRow(1).commit();
  }

  static async create(path: string): Promise<StreamingTradesmenWorkbookWriter> {
    await mkdir(dirname(path), { recursive: true });
    return new StreamingTradesmenWorkbookWriter(path);
  }

  add(tradesman: Tradesman): void {
    if (this.committed) {
      throw new Error("Cannot write to a committed workbook.");
    }

    this.worksheet.addRow(tradesmanRow(tradesman)).commit();
    this.count++;
  }

  async commit(): Promise<void> {
    if (this.committed) return;
    this.committed = true;
    this.worksheet.commit();
    await this.workbook.commit();
  }
}

export class StreamingTradesmenCsvWriter {
  private committed = false;
  count = 0;

  private constructor(private readonly path: string) {}

  static async create(path: string): Promise<StreamingTradesmenCsvWriter> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${TRADESMAN_COLUMNS.map((column) => pipeDelimitedCell(column.header)).join("|")}\n`, "utf8");
    return new StreamingTradesmenCsvWriter(path);
  }

  async add(tradesman: Tradesman): Promise<void> {
    if (this.committed) {
      throw new Error("Cannot write to a committed CSV.");
    }

    const row = tradesmanRow(tradesman);
    const line = TRADESMAN_COLUMNS.map((column) => pipeDelimitedCell(row[column.key])).join("|");
    await appendFile(this.path, `${line}\n`, "utf8");
    this.count++;
  }

  commit(): void {
    this.committed = true;
  }
}

function pipeDelimitedCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!/[|\n"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parsePipeDelimited(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === "|") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
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
