import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildOutputPaths } from "../src/paths.js";
import { asText, readWashingtonSpreadsheet } from "../src/spreadsheet.js";

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

describe("asText", () => {
  it("normalizes blank and date cell values", () => {
    expect(asText("  ")).toBeUndefined();
    expect(asText(new Date(2026, 6, 6))).toBe("7/6/2026");
  });
});

describe("readWashingtonSpreadsheet", () => {
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

  it("keeps eligible rows and logs skipped rows with worksheet locations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const inputPath = join(dir, "ListToCheck.xlsx");
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Licenses");
    addHeader(worksheet);
    worksheet.addRow(["EL", "LIC-1", "Ada", "1 Main", "", "Seattle", "WA", "98101", "7/20/2026"]);
    worksheet.addRow(["EL", "", "Missing", "1 Main", "", "Seattle", "WA", "98101", "7/20/2026"]);
    worksheet.addRow(["EL", "LIC-OLD", "Old", "1 Main", "", "Seattle", "WA", "98101", "1/1/2020"]);
    worksheet.addRow(["EL", "LIC-FAR", "Far", "1 Main", "", "Seattle", "WA", "98101", "1/1/2030"]);
    await workbook.xlsx.writeFile(inputPath);

    const logger = new TestLogger();
    const tradesmen = await readWashingtonSpreadsheet(inputPath, logger, outputPaths);

    expect(tradesmen).toEqual([
      expect.objectContaining({
        licenseNumber: "LIC-1",
        name: "Ada",
        expirationDate: "7/20/2026"
      })
    ]);

    await expect(readFile(outputPaths.exceptionLogPath, "utf8")).resolves.toContain("Skipped Licenses!3");
    await expect(readFile(outputPaths.expiredLogPath, "utf8")).resolves.toContain("Skipped Licenses!4 (LIC-OLD)");
    await expect(readFile(outputPaths.greaterThan90LogPath, "utf8")).resolves.toContain("Skipped Licenses!5 (LIC-FAR)");
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
    electricians.addRow(["EL", "EL-1", "Eli", "1 Main", "", "Seattle", "WA", "98101", "7/20/2026"]);
    plumbers.addRow(["PL", "PL-1", "Pat", "2 Main", "", "Tacoma", "WA", "98402", "7/20/2026"]);
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
    ).rejects.toThrow('Worksheet "Roofers" was not found. Available worksheets: "Electricians", "Plumbers"');
  });
});
