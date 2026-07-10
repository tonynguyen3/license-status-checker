import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildOutputPaths } from "../src/paths.js";
import {
  asText,
  readEligibleTradesmen,
  readTradesmenCsv,
  readTradesmenWorkbook,
  readWashingtonSpreadsheet,
  parseDate,
  StreamingTradesmenCsvWriter,
  StreamingTradesmenWorkbookWriter
} from "../src/spreadsheet.js";

class TestLogger {
  readonly consoleMessages: string[] = [];

  logStart(): void {}

  logEnd(): void {}

  writeToConsole(message: string): void {
    this.consoleMessages.push(message);
  }

  async writeErrorsToLog(message: string, path: string): Promise<void> {
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${message}\n`, "utf8");
  }
}

function addHeader(worksheet: ExcelJS.Worksheet): void {
  worksheet.addRow([
    "License Type",
    "License Number",
    "Name",
    "Address1",
    "Address2",
    "City",
    "State",
    "Zip",
    "ExpirationDate"
  ]);
}

function dateDaysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

describe("asText", () => {
  it("normalizes blank and date cell values", () => {
    expect(asText("  ")).toBeUndefined();
    expect(asText(new Date(2026, 6, 6))).toBe("7/6/2026");
  });
});

describe("parseDate", () => {
  it("handles Excel serial date values from streamed worksheet cells", () => {
    expect(parseDate("46225.5")?.toISOString().slice(0, 10)).toBe("2026-07-22");
  });
});

describe("readWashingtonSpreadsheet", () => {
  it("keeps eligible rows and logs skipped rows with worksheet locations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const inputPath = join(dir, "ListToCheck.xlsx");
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Electricians");
    addHeader(worksheet);
    worksheet.addRow(["EL", "LIC-1", "Ada", "1 Main", "", "Seattle", "WA", "98101", dateDaysFromNow(30)]);
    worksheet.addRow(["EL", "", "Missing", "1 Main", "", "Seattle", "WA", "98101", dateDaysFromNow(30)]);
    worksheet.addRow(["EL", "LIC-OLD", "Old", "1 Main", "", "Seattle", "WA", "98101", dateDaysFromNow(-1)]);
    worksheet.addRow(["EL", "LIC-FAR", "Far", "1 Main", "", "Seattle", "WA", "98101", dateDaysFromNow(120)]);
    await workbook.xlsx.writeFile(inputPath);

    const logger = new TestLogger();
    const tradesmen = await readWashingtonSpreadsheet(inputPath, logger, outputPaths);

    expect(tradesmen).toEqual([
      expect.objectContaining({
        licenseNumber: "LIC-1",
        name: "Ada",
        expirationDate: dateDaysFromNow(30),
        sourceWorksheet: "Electricians",
        sourceRowNumber: 2,
        sourceLocation: "Electricians!2"
      })
    ]);

    await expect(readFile(outputPaths.exceptionLogPath, "utf8")).resolves.toContain("Skipped Electricians!3");
    await expect(readFile(outputPaths.expiredLogPath, "utf8")).resolves.toContain("Skipped Electricians!4 (LIC-OLD)");
    await expect(readFile(outputPaths.greaterThan90LogPath, "utf8")).resolves.toContain("Skipped Electricians!5 (LIC-FAR)");
  });

  it("ignores unsupported worksheets when reading all worksheets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const inputPath = join(dir, "ListToCheck.xlsx");
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const workbook = new ExcelJS.Workbook();
    const electricians = workbook.addWorksheet("Electricians");
    const roofers = workbook.addWorksheet("Roofers");
    addHeader(electricians);
    addHeader(roofers);
    electricians.addRow(["EL", "EL-1", "Eli", "1 Main", "", "Seattle", "WA", "98101", dateDaysFromNow(30)]);
    roofers.addRow(["RF", "RF-1", "Roo", "2 Main", "", "Tacoma", "WA", "98402", dateDaysFromNow(30)]);
    await workbook.xlsx.writeFile(inputPath);

    const logger = new TestLogger();
    const tradesmen = await readWashingtonSpreadsheet(inputPath, logger, outputPaths);

    expect(tradesmen).toEqual([
      expect.objectContaining({
        licenseNumber: "EL-1",
        name: "Eli"
      })
    ]);
  });

  it("reads only the requested worksheet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const inputPath = join(dir, "ListToCheck.xlsx");
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const workbook = new ExcelJS.Workbook();
    const electricians = workbook.addWorksheet("Electricians");
    const plumbers = workbook.addWorksheet("Plumbers");
    addHeader(electricians);
    addHeader(plumbers);
    electricians.addRow(["EL", "EL-1", "Eli", "1 Main", "", "Seattle", "WA", "98101", dateDaysFromNow(30)]);
    plumbers.addRow(["PL", "PL-1", "Pat", "2 Main", "", "Tacoma", "WA", "98402", dateDaysFromNow(30)]);
    await workbook.xlsx.writeFile(inputPath);

    const logger = new TestLogger();
    const tradesmen = await readWashingtonSpreadsheet(inputPath, logger, outputPaths, {
      worksheetName: "electricians"
    });

    expect(tradesmen).toEqual([
      expect.objectContaining({
        licenseNumber: "EL-1",
        name: "Eli"
      })
    ]);
    expect(logger.consoleMessages).toContain('Only reading worksheet "electricians".');
  });

  it("throws a helpful error when the requested worksheet does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const inputPath = join(dir, "ListToCheck.xlsx");
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const workbook = new ExcelJS.Workbook();
    addHeader(workbook.addWorksheet("Electricians"));
    addHeader(workbook.addWorksheet("Plumbers"));
    await workbook.xlsx.writeFile(inputPath);

    const logger = new TestLogger();
    await expect(
      readWashingtonSpreadsheet(inputPath, logger, outputPaths, {
        worksheetName: "Roofers"
      })
    ).rejects.toThrow('Worksheet "Roofers" is not supported. Supported worksheets: "Plumbers", "Plumber Trainees", "Electricians"');
  });
});

describe("readEligibleTradesmen", () => {
  it("streams eligible rows without requiring callers to hold the full workbook result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const inputPath = join(dir, "ListToCheck.xlsx");
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const workbook = new ExcelJS.Workbook();
    const electricians = workbook.addWorksheet("Electricians");
    addHeader(electricians);
    electricians.addRow(["EL", "EL-1", "Eli", "1 Main", "", "Seattle", "WA", "98101", dateDaysFromNow(30)]);
    electricians.addRow(["EL", "EL-OLD", "Old", "1 Main", "", "Seattle", "WA", "98101", dateDaysFromNow(-1)]);
    electricians.addRow(["EL", "EL-2", "Elle", "3 Main", "", "Everett", "WA", "98201", dateDaysFromNow(45)]);
    await workbook.xlsx.writeFile(inputPath);

    const logger = new TestLogger();
    const streamed = [];

    for await (const tradesman of readEligibleTradesmen(inputPath, logger, outputPaths)) {
      streamed.push(tradesman);
    }

    expect(streamed.map((tradesman) => tradesman.licenseNumber)).toEqual(["EL-1", "EL-2"]);
    await expect(readFile(outputPaths.expiredLogPath, "utf8")).resolves.toContain("Skipped Electricians!3 (EL-OLD)");
    expect(logger.consoleMessages.at(-1)).toContain("It will now check 2 license(s).");
  });

  it("can resume by streaming only eligible rows after a checkpoint license", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const inputPath = join(dir, "ListToCheck.xlsx");
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const workbook = new ExcelJS.Workbook();
    const electricians = workbook.addWorksheet("Electricians");
    addHeader(electricians);
    electricians.addRow(["EL", "EL-1", "Eli", "1 Main", "", "Seattle", "WA", "98101", dateDaysFromNow(30)]);
    electricians.addRow(["EL", "EL-2", "Elle", "2 Main", "", "Everett", "WA", "98201", dateDaysFromNow(45)]);
    electricians.addRow(["EL", "EL-3", "Ellis", "3 Main", "", "Tacoma", "WA", "98401", dateDaysFromNow(46)]);
    await workbook.xlsx.writeFile(inputPath);

    const logger = new TestLogger();
    const streamed = [];

    for await (const tradesman of readEligibleTradesmen(inputPath, logger, outputPaths, {
      skipUntilAfterLicenseNumber: "EL-2"
    })) {
      streamed.push(tradesman);
    }

    expect(streamed.map((tradesman) => tradesman.licenseNumber)).toEqual(["EL-3"]);
  });

  it("fails resume when the checkpoint license is not found in eligible rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const inputPath = join(dir, "ListToCheck.xlsx");
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const workbook = new ExcelJS.Workbook();
    const electricians = workbook.addWorksheet("Electricians");
    addHeader(electricians);
    electricians.addRow(["EL", "EL-1", "Eli", "1 Main", "", "Seattle", "WA", "98101", dateDaysFromNow(30)]);
    await workbook.xlsx.writeFile(inputPath);

    const logger = new TestLogger();
    const stream = readEligibleTradesmen(inputPath, logger, outputPaths, {
      skipUntilAfterLicenseNumber: "EL-MISSING"
    });

    await expect(async () => {
      for await (const _tradesman of stream) {
        // Exhaust the stream to trigger checkpoint validation.
      }
    }).rejects.toThrow('Resume checkpoint license "EL-MISSING" was not found in the eligible spreadsheet rows.');
  });
});

describe("StreamingTradesmenWorkbookWriter", () => {
  it("writes rows incrementally to an xlsx workbook", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const outputPath = join(dir, "Send.xlsx");
    const writer = await StreamingTradesmenWorkbookWriter.create(outputPath);

    writer.add({
      licenseType: "EL",
      licenseNumber: "EL-1",
      name: "Eli",
      expirationDate: dateDaysFromNow(30),
      trade: "Electrician",
      hoursNeeded: 24,
      sourceWorksheet: "Electricians",
      sourceRowNumber: 42,
      sourceLocation: "Electricians!42"
    });
    await writer.commit();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const worksheet = workbook.getWorksheet("mySheet");

    expect(writer.count).toBe(1);
    expect(worksheet?.getRow(1).getCell(2).value).toBe("License Number");
    expect(worksheet?.getRow(2).getCell(2).value).toBe("EL-1");
    expect(worksheet?.getRow(2).getCell(3).value).toBe("Eli");
  });

  it("reads rows back from a tradesmen output workbook", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const outputPath = join(dir, "Send.xlsx");
    const writer = await StreamingTradesmenWorkbookWriter.create(outputPath);

    writer.add({
      licenseType: "EL",
      licenseNumber: "EL-1",
      name: "Eli",
      expirationDate: dateDaysFromNow(30),
      trade: "Electrician",
      hoursNeeded: 24,
      sourceWorksheet: "Electricians",
      sourceRowNumber: 42,
      sourceLocation: "Electricians!42"
    });
    await writer.commit();

    await expect(readTradesmenWorkbook(outputPath)).resolves.toEqual([
      expect.objectContaining({
        licenseNumber: "EL-1",
        name: "Eli",
        trade: "Electrician",
        hoursNeeded: 24,
        sourceWorksheet: "Electricians",
        sourceRowNumber: 42,
        sourceLocation: "Electricians!42"
      })
    ]);
  });

  it("creates a valid workbook when no rows are written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const outputPath = join(dir, "DoNotSend.xlsx");
    const writer = await StreamingTradesmenWorkbookWriter.create(outputPath);

    await writer.commit();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const worksheet = workbook.getWorksheet("mySheet");

    expect(writer.count).toBe(0);
    expect(worksheet?.getRow(1).getCell(2).value).toBe("License Number");
    expect(worksheet?.rowCount).toBe(1);
  });
});

describe("StreamingTradesmenCsvWriter", () => {
  it("writes pipe-delimited CSV rows and reads them back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const outputPath = join(dir, "Send.csv");
    const writer = await StreamingTradesmenCsvWriter.create(outputPath);

    await writer.add({
      licenseType: "EL",
      licenseNumber: "EL-1",
      name: "Eli | Electric",
      expirationDate: dateDaysFromNow(30),
      trade: "Electrician",
      hoursNeeded: 24,
      notSendReason: 'Already has "some" credits',
      sourceWorksheet: "Electricians",
      sourceRowNumber: 42,
      sourceLocation: "Electricians!42"
    });
    writer.commit();

    const content = await readFile(outputPath, "utf8");

    expect(writer.count).toBe(1);
    expect(content).toContain("License Type|License Number|Name");
    expect(content).toContain('"Eli | Electric"');
    expect(content).toContain('"Already has ""some"" credits"');
    await expect(readTradesmenCsv(outputPath)).resolves.toEqual([
      expect.objectContaining({
        licenseNumber: "EL-1",
        name: "Eli | Electric",
        trade: "Electrician",
        hoursNeeded: 24,
        notSendReason: 'Already has "some" credits',
        sourceWorksheet: "Electricians",
        sourceRowNumber: 42,
        sourceLocation: "Electricians!42"
      })
    ]);
  });
});
