import { appendFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Logger } from "./logger.js";
import { buildOutputPaths } from "./paths.js";
import { RunStateWriter } from "./run-state.js";
import {
  readEligibleTradesmen,
  StreamingTradesmenCsvWriter,
  writeCourseFrequencies,
  writeTradesmenWorkbookFromCsv
} from "./spreadsheet.js";
import type { OutputPaths, ProgressReporter } from "./types.js";
import { WashingtonLicenseChecker } from "./washington-checker.js";

export interface RunOptions {
  input: string;
  outDir: string;
  runId?: string;
  worksheet?: string;
  headed: boolean;
  slowMo: number;
  checkDelayMs?: number;
  limit?: number;
  resumeAfterLicenseNumber?: string;
  resumedFromRunId?: string;
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
  const outputPaths = buildOutputPaths(options.outDir);
  const runState = new RunStateWriter(outputPaths.runStatePath, {
    id: options.runId,
    runOptions: {
      worksheet: options.worksheet,
      headed: options.headed,
      slowMo: options.slowMo,
      checkDelayMs: options.checkDelayMs ?? 1500,
      limit: options.limit,
      resumeAfterLicenseNumber: options.resumeAfterLicenseNumber,
      resumedFromRunId: options.resumedFromRunId
    }
  });
  await runState.writeInitial();
  const reportProgress: ProgressReporter = (update) => {
    options.onProgress?.(update);
    void runState.recordProgress(update);
  };
  const logger = new Logger(reportProgress);

  if (!existsSync(options.input)) {
    throw new Error(`Input spreadsheet not found: ${options.input}`);
  }

  logger.logStart();

  const sendWriter = await StreamingTradesmenCsvWriter.create(outputPaths.sendCsvPath);
  const doNotSendWriter = await StreamingTradesmenCsvWriter.create(outputPaths.doNotSendCsvPath);
  reportProgress({
    type: "output",
    message: `Live pipe-delimited CSV outputs are ready: ${outputPaths.sendCsvPath} and ${outputPaths.doNotSendCsvPath}`,
    files: {
      sendCsv: outputPaths.sendCsvPath,
      doNotSendCsv: outputPaths.doNotSendCsvPath
    }
  });

  let result: Awaited<ReturnType<WashingtonLicenseChecker["checkLicenses"]>> | undefined;
  try {
    const checker = new WashingtonLicenseChecker(logger, outputPaths, {
      headed: options.headed,
      slowMo: options.slowMo,
      checkDelayMs: options.checkDelayMs ?? 1500,
      limit: options.limit,
      onProgress: reportProgress,
      onResult: async (checkedResult) => {
        if (checkedResult.bucket === "send") {
          await sendWriter.add(checkedResult.tradesman);
        } else {
          await doNotSendWriter.add(checkedResult.tradesman);
        }
        await runState.recordResult(checkedResult.bucket, checkedResult.tradesman);
      },
      isCanceled: options.isCanceled
    });

    const tradesmen = readEligibleTradesmen(options.input, logger, outputPaths, {
      worksheetName: options.worksheet,
      skipUntilAfterLicenseNumber: options.resumeAfterLicenseNumber,
      onProgress: reportProgress
    });
    result = await checker.checkLicenses(tradesmen);
  } finally {
    sendWriter.commit();
    doNotSendWriter.commit();
    await ensureLogFiles(outputPaths);
  }

  if (!result) {
    throw new Error("Washington check did not return a result.");
  }

  await Promise.all([
    writeTradesmenWorkbookFromCsv(outputPaths.sendCsvPath, outputPaths.sendPath),
    writeTradesmenWorkbookFromCsv(outputPaths.doNotSendCsvPath, outputPaths.doNotSendPath),
    writeCourseFrequencies(result.courseFrequencies, outputPaths.coursesAlreadyTakenPath)
  ]);
  await runState.recordFinal({
    canceled: result.canceled,
    outputPaths
  });

  const sendMessage = `Wrote ${sendWriter.count} row(s) to ${outputPaths.sendPath}`;
  const doNotSendMessage = `Wrote ${doNotSendWriter.count} row(s) to ${outputPaths.doNotSendPath}`;
  const courseMessage = `Wrote ${result.courseFrequencies.length} course frequency row(s) to ${outputPaths.coursesAlreadyTakenPath}`;
  console.log(sendMessage);
  console.log(doNotSendMessage);
  console.log(courseMessage);
  reportProgress({ type: "output", message: sendMessage, files: { send: outputPaths.sendPath } });
  reportProgress({ type: "output", message: doNotSendMessage, files: { doNotSend: outputPaths.doNotSendPath } });
  reportProgress({
    type: "output",
    message: courseMessage,
    files: { coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath }
  });

  logger.logEnd();

  return {
    sendCount: sendWriter.count,
    doNotSendCount: doNotSendWriter.count,
    courseFrequencyCount: result.courseFrequencies.length,
    outputPaths,
    canceled: result.canceled
  };
}

async function ensureLogFiles(outputPaths: OutputPaths): Promise<void> {
  await Promise.all([
    appendFile(outputPaths.expiredLogPath, "", "utf8"),
    ensureLogMessage(outputPaths.greaterThan90LogPath, "No entries greater than 90 days.\n"),
    ensureLogMessage(outputPaths.exceptionLogPath, "There were no exceptions.\n")
  ]);
}

async function ensureLogMessage(path: string, message: string): Promise<void> {
  await appendFile(path, "", "utf8");
  const fileStat = await stat(path);
  if (fileStat.size === 0) {
    await writeFile(path, message, "utf8");
  }
}
