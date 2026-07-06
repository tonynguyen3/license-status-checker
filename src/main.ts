import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Logger } from "./logger.js";
import { buildOutputPaths } from "./paths.js";
import { readWashingtonSpreadsheet, writeCourseFrequencies, writeTradesmenWorkbook } from "./spreadsheet.js";
import { WashingtonLicenseChecker } from "./washington-checker.js";

interface CliArgs {
  input: string;
  outDir: string;
  headed: boolean;
  slowMo: number;
  limit?: number;
}

function readArgs(argv: string[]): CliArgs {
  const args = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, true);
    } else {
      args.set(key, next);
      i++;
    }
  }

  const outDir = String(args.get("out-dir") ?? "Files");
  const input = String(args.get("input") ?? resolve(outDir, "ListToCheck.xlsx"));
  const limitValue = args.get("limit");

  return {
    input: resolve(input),
    outDir: resolve(outDir),
    headed: args.get("headed") === true,
    slowMo: Number(args.get("slow-mo") ?? 0),
    limit: typeof limitValue === "string" ? Number(limitValue) : undefined
  };
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const logger = new Logger();
  const outputPaths = buildOutputPaths(args.outDir);

  if (!existsSync(args.input)) {
    throw new Error(`Input spreadsheet not found: ${args.input}`);
  }

  logger.logStart();

  const tradesmen = await readWashingtonSpreadsheet(args.input, logger, outputPaths);
  const checker = new WashingtonLicenseChecker(logger, outputPaths, {
    headed: args.headed,
    slowMo: args.slowMo,
    limit: args.limit
  });

  const result = await checker.checkLicenses(tradesmen);

  await writeTradesmenWorkbook(result.send, outputPaths.sendPath);
  await writeTradesmenWorkbook(result.doNotSend, outputPaths.doNotSendPath);
  await writeCourseFrequencies(result.courseFrequencies, outputPaths.coursesAlreadyTakenPath);

  console.log(`Wrote ${result.send.length} row(s) to ${outputPaths.sendPath}`);
  console.log(`Wrote ${result.doNotSend.length} row(s) to ${outputPaths.doNotSendPath}`);
  console.log(`Wrote ${result.courseFrequencies.length} course frequency row(s) to ${outputPaths.coursesAlreadyTakenPath}`);

  logger.logEnd();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
