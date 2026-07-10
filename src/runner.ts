import { appendFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Logger } from "./logger.js";
import { PipelineStore } from "./pipeline-store.js";
import { buildOutputPaths } from "./paths.js";
import { RunStateWriter } from "./run-state.js";
import {
  readEligibleTradesmen,
  writeCourseFrequencies,
  writeTradesmenCsv,
  writeTradesmenWorkbook
} from "./spreadsheet.js";
import type { BucketedResult, CourseFrequency, OutputPaths, ProgressReporter, Tradesman } from "./types.js";
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

interface RunContext {
  options: RunOptions;
  outputPaths: OutputPaths;
  store: PipelineStore;
  runState: RunStateWriter;
  logger: Logger;
  reportProgress: ProgressReporter;
}

interface ImportStageResult {
  queuedCount: number;
}

interface LookupStageResult {
  sendCount: number;
  doNotSendCount: number;
  errorCount: number;
  courseFrequencies: CourseFrequency[];
  canceled: boolean;
}

interface ReportStageResult {
  sendCount: number;
  doNotSendCount: number;
  courseFrequencyCount: number;
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
  const store = new PipelineStore(outputPaths);
  const context: RunContext = {
    options,
    outputPaths,
    store,
    runState,
    logger,
    reportProgress
  };

  let lookupResult: LookupStageResult | undefined;
  let reportResult: ReportStageResult | undefined;
  try {
    await importWorkItems(context);
    lookupResult = await processLookupQueue(context);
  } finally {
    await ensureLogFiles(outputPaths);
  }

  if (!lookupResult) {
    throw new Error("Washington check did not return a result.");
  }

  reportResult = await generateReports(context, lookupResult);
  await runState.recordFinal({
    canceled: lookupResult.canceled,
    outputPaths
  });

  const sendMessage = `Wrote ${reportResult.sendCount} row(s) to ${outputPaths.sendPath}`;
  const doNotSendMessage = `Wrote ${reportResult.doNotSendCount} row(s) to ${outputPaths.doNotSendPath}`;
  const courseMessage = `Wrote ${reportResult.courseFrequencyCount} course frequency row(s) to ${outputPaths.coursesAlreadyTakenPath}`;
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
    sendCount: reportResult.sendCount,
    doNotSendCount: reportResult.doNotSendCount,
    courseFrequencyCount: reportResult.courseFrequencyCount,
    outputPaths,
    canceled: lookupResult.canceled
  };
}

async function importWorkItems(context: RunContext): Promise<ImportStageResult> {
  const { options, outputPaths, store, logger, reportProgress } = context;
  await store.initialize();
  reportProgress({
    type: "import_started",
    message: "Stage 1 of 3: importing eligible spreadsheet rows into a durable work queue.",
    files: {
      workItems: outputPaths.workItemsPath,
      lookupResults: outputPaths.lookupResultsPath,
      courseFrequenciesJson: outputPaths.courseFrequenciesJsonPath
    }
  });

  let queuedCount = 0;
  const tradesmen = readEligibleTradesmen(options.input, logger, outputPaths, {
    worksheetName: options.worksheet,
    skipUntilAfterLicenseNumber: options.resumeAfterLicenseNumber,
    onProgress: reportProgress
  });

  for await (const tradesman of tradesmen) {
    queuedCount++;
    const queuedTradesman: Tradesman = {
      ...tradesman,
      workItemId: queuedCount
    };
    await store.appendWorkItem({
      id: queuedCount,
      tradesman: queuedTradesman,
      status: "queued",
      createdAt: new Date().toISOString()
    });
  }

  reportProgress({
    type: "import_complete",
    message: `Stage 1 complete. Queued ${queuedCount} website lookup work item(s).`,
    current: queuedCount,
    total: queuedCount
  });

  return { queuedCount };
}

async function processLookupQueue(context: RunContext): Promise<LookupStageResult> {
  const { options, outputPaths, store, logger, runState, reportProgress } = context;
  const workItems = await store.readWorkItems();
  reportProgress({
    type: "lookup_started",
    message: `Stage 2 of 3: processing ${workItems.length} queued website lookup item(s).`,
    current: 0,
    total: workItems.length,
    remaining: workItems.length
  });

  let sendCount = 0;
  let doNotSendCount = 0;
  const checker = new WashingtonLicenseChecker(logger, outputPaths, {
    headed: options.headed,
    slowMo: options.slowMo,
    checkDelayMs: options.checkDelayMs ?? 1500,
    limit: options.limit,
    onProgress: reportProgress,
    onResult: async (checkedResult: BucketedResult) => {
      await store.appendLookupResult(checkedResult);
      if (checkedResult.bucket === "send") {
        sendCount++;
      } else {
        doNotSendCount++;
      }
      await runState.recordResult(checkedResult.bucket, checkedResult.tradesman);
    },
    isCanceled: options.isCanceled
  });

  const result = await checker.checkLicenses(workItems.map((item) => item.tradesman));
  await store.writeCourseFrequencies(result.courseFrequencies);

  return {
    sendCount,
    doNotSendCount,
    errorCount: 0,
    courseFrequencies: result.courseFrequencies,
    canceled: result.canceled
  };
}

async function generateReports(context: RunContext, lookupResult: LookupStageResult): Promise<ReportStageResult> {
  const { outputPaths, store, reportProgress } = context;
  reportProgress({
    type: "reports_started",
    message: "Stage 3 of 3: generating CSV, Excel, and summary reports from durable lookup results."
  });

  const results = await store.readLookupResults();
  const sendTradesmen = results.filter((result) => result.bucket === "send").map((result) => result.tradesman);
  const doNotSendTradesmen = results.filter((result) => result.bucket === "doNotSend").map((result) => result.tradesman);
  const courseFrequencies = await store.readCourseFrequencies();
  const courses = courseFrequencies.length > 0 ? courseFrequencies : lookupResult.courseFrequencies;

  await Promise.all([
    writeTradesmenCsv(sendTradesmen, outputPaths.sendCsvPath),
    writeTradesmenCsv(doNotSendTradesmen, outputPaths.doNotSendCsvPath),
    writeTradesmenWorkbook(sendTradesmen, outputPaths.sendPath),
    writeTradesmenWorkbook(doNotSendTradesmen, outputPaths.doNotSendPath),
    writeCourseFrequencies(courses, outputPaths.coursesAlreadyTakenPath)
  ]);

  reportProgress({
    type: "reports_complete",
    message: `Stage 3 complete. Generated reports from ${results.length} stored lookup result(s).`,
    files: {
      sendCsv: outputPaths.sendCsvPath,
      doNotSendCsv: outputPaths.doNotSendCsvPath,
      send: outputPaths.sendPath,
      doNotSend: outputPaths.doNotSendPath,
      coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath
    }
  });

  return {
    sendCount: sendTradesmen.length,
    doNotSendCount: doNotSendTradesmen.length,
    courseFrequencyCount: courses.length
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
