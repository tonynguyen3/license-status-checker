import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Logger } from "./logger.js";
import { buildOutputPaths } from "./paths.js";
import { readWashingtonSpreadsheet, writeCourseFrequencies, writeTradesmenWorkbook } from "./spreadsheet.js";
import type { OutputPaths, ProgressReporter } from "./types.js";
import { WashingtonLicenseChecker } from "./washington-checker.js";

export interface RunOptions {
  input: string;
  outDir: string;
  worksheet?: string;
  headed: boolean;
  slowMo: number;
  limit?: number;
  onProgress?: ProgressReporter;
  isCanceled?: () => boolean;
}

export interface RunResult {
  sendCount: number;
  doNotSendCount: number;
  courseFrequencyCount: number;
  outputPaths: OutputPaths;
  canceled: boolean;
}

export async function runWashingtonCheck(options: RunOptions): Promise<RunResult> {
  const logger = new Logger(options.onProgress);
  const outputPaths = buildOutputPaths(options.outDir);

  if (!existsSync(options.input)) {
    throw new Error(`Input spreadsheet not found: ${options.input}`);
  }

  logger.logStart();

  const tradesmen = await readWashingtonSpreadsheet(options.input, logger, outputPaths, {
    worksheetName: options.worksheet,
    onProgress: options.onProgress
  });
  const checker = new WashingtonLicenseChecker(logger, outputPaths, {
    headed: options.headed,
    slowMo: options.slowMo,
    limit: options.limit,
    onProgress: options.onProgress,
    isCanceled: options.isCanceled
  });

  const result = await checker.checkLicenses(tradesmen);

  await writeTradesmenWorkbook(result.send, outputPaths.sendPath);
  await writeTradesmenWorkbook(result.doNotSend, outputPaths.doNotSendPath);
  await writeCourseFrequencies(result.courseFrequencies, outputPaths.coursesAlreadyTakenPath);
  await ensureLogFiles(outputPaths);

  const sendMessage = `Wrote ${result.send.length} row(s) to ${outputPaths.sendPath}`;
  const doNotSendMessage = `Wrote ${result.doNotSend.length} row(s) to ${outputPaths.doNotSendPath}`;
  const courseMessage = `Wrote ${result.courseFrequencies.length} course frequency row(s) to ${outputPaths.coursesAlreadyTakenPath}`;
  console.log(sendMessage);
  console.log(doNotSendMessage);
  console.log(courseMessage);
  options.onProgress?.({ type: "output", message: sendMessage, files: { send: outputPaths.sendPath } });
  options.onProgress?.({ type: "output", message: doNotSendMessage, files: { doNotSend: outputPaths.doNotSendPath } });
  options.onProgress?.({
    type: "output",
    message: courseMessage,
    files: { coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath }
  });

  logger.logEnd();

  return {
    sendCount: result.send.length,
    doNotSendCount: result.doNotSend.length,
    courseFrequencyCount: result.courseFrequencies.length,
    outputPaths,
    canceled: result.canceled
  };
}

async function ensureLogFiles(outputPaths: OutputPaths): Promise<void> {
  await Promise.all([
    appendFile(outputPaths.expiredLogPath, "", "utf8"),
    appendFile(outputPaths.greaterThan90LogPath, "", "utf8"),
    appendFile(outputPaths.exceptionLogPath, "", "utf8")
  ]);
}
