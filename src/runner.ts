import { appendFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Logger } from "./logger.js";
import { PipelineStore } from "./pipeline-store.js";
import type { PipelineStorage, WorkItem } from "./pipeline-storage.js";
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
  input?: string;
  outDir: string;
  runId?: string;
  worksheet?: string;
  headed: boolean;
  slowMo: number;
  checkDelayMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  retryBackoffMultiplier?: number;
  limit?: number;
  resumeAfterLicenseNumber?: string;
  resumedFromRunId?: string;
  resumeSourceOutDir?: string;
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

export interface StageResult {
  outputPaths: OutputPaths;
}

interface RunContext {
  options: RunOptions;
  outputPaths: OutputPaths;
  store: PipelineStorage;
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
      retryAttempts: options.retryAttempts ?? 1,
      retryDelayMs: options.retryDelayMs ?? 5000,
      retryBackoffMultiplier: options.retryBackoffMultiplier ?? 2,
      limit: options.limit,
      resumeAfterLicenseNumber: options.resumeAfterLicenseNumber,
      resumedFromRunId: options.resumedFromRunId,
      resumeSourceOutDir: options.resumeSourceOutDir
    }
  });
  await runState.writeInitial();
  const reportProgress: ProgressReporter = (update) => {
    options.onProgress?.(update);
    void runState.recordProgress(update);
  };
  const logger = new Logger(reportProgress);

  if (!options.input || !existsSync(options.input)) {
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

export async function importPipelineWorkItems(options: RunOptions): Promise<ImportStageResult & StageResult> {
  if (!options.input || !existsSync(options.input)) {
    throw new Error(`Input spreadsheet not found: ${options.input}`);
  }
  const context = await createStageContext(options);
  context.logger.logStart();
  const result = await importWorkItems(context);
  await ensureLogFiles(context.outputPaths);
  return { ...result, outputPaths: context.outputPaths };
}

export async function processPipelineQueue(options: RunOptions): Promise<LookupStageResult & StageResult> {
  const context = await createStageContext(options);
  const result = await processLookupQueue(context);
  await context.store.writeCourseFrequencies(result.courseFrequencies);
  await ensureLogFiles(context.outputPaths);
  return { ...result, outputPaths: context.outputPaths };
}

export async function generatePipelineReports(options: Pick<RunOptions, "outDir" | "runId" | "worksheet" | "headed" | "slowMo" | "checkDelayMs" | "retryAttempts" | "retryDelayMs" | "retryBackoffMultiplier" | "limit">): Promise<ReportStageResult & StageResult> {
  const outputPaths = buildOutputPaths(options.outDir);
  const result = await regenerateReportsFromStore(outputPaths);
  return { ...result, outputPaths };
}

async function createStageContext(options: RunOptions): Promise<RunContext> {
  const outputPaths = buildOutputPaths(options.outDir);
  const runState = new RunStateWriter(outputPaths.runStatePath, {
    id: options.runId,
    runOptions: {
      worksheet: options.worksheet,
      headed: options.headed,
      slowMo: options.slowMo,
      checkDelayMs: options.checkDelayMs ?? 1500,
      retryAttempts: options.retryAttempts ?? 1,
      retryDelayMs: options.retryDelayMs ?? 5000,
      retryBackoffMultiplier: options.retryBackoffMultiplier ?? 2,
      limit: options.limit,
      resumeAfterLicenseNumber: options.resumeAfterLicenseNumber,
      resumedFromRunId: options.resumedFromRunId,
      resumeSourceOutDir: options.resumeSourceOutDir
    }
  });
  await runState.writeInitial();
  const reportProgress: ProgressReporter = (update) => {
    options.onProgress?.(update);
    void runState.recordProgress(update);
  };
  return {
    options,
    outputPaths,
    store: new PipelineStore(outputPaths),
    runState,
    logger: new Logger(reportProgress),
    reportProgress
  };
}

async function importWorkItems(context: RunContext): Promise<ImportStageResult> {
  const { options, outputPaths, store, logger, reportProgress } = context;
  await store.initialize();
  reportProgress({
    type: "import_started",
    message: options.resumeSourceOutDir
      ? "Stage 1 of 3: loading remaining work items from the previous run's durable queue."
      : "Stage 1 of 3: importing eligible spreadsheet rows into a durable work queue.",
    files: {
      workItems: outputPaths.workItemsPath,
      lookupResults: outputPaths.lookupResultsPath,
      courseFrequenciesJson: outputPaths.courseFrequenciesJsonPath
    }
  });

  if (options.resumeSourceOutDir) {
    const queuedCount = await importRemainingWorkItemsFromPreviousRun(context, options.resumeSourceOutDir);
    if (queuedCount !== undefined) {
      reportProgress({
      type: "import_complete",
      message: `Stage 1 complete. Queued ${queuedCount} remaining website lookup work item(s) from the previous run.`,
      current: queuedCount,
      total: queuedCount,
      queuedCount
      });
      return { queuedCount };
    }
  }

  let queuedCount = 0;
  if (!options.input) {
    throw new Error("Input spreadsheet is required for import stage.");
  }

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
    total: queuedCount,
    queuedCount
  });

  return { queuedCount };
}

async function importRemainingWorkItemsFromPreviousRun(context: RunContext, sourceOutDir: string): Promise<number | undefined> {
  const { options, store } = context;
  const sourceStore = new PipelineStore(buildOutputPaths(sourceOutDir));
  const sourceWorkItems = await sourceStore.readWorkItems();
  if (sourceWorkItems.length === 0) {
    return undefined;
  }

  const sourceResults = await sourceStore.readLookupResults();
  const completedIds = new Set(sourceResults.map((result) => result.workItemId).filter((id): id is number => id !== undefined));
  const checkpointId = findCheckpointWorkItemId(sourceWorkItems, options.resumeAfterLicenseNumber);
  const queuedItems = sourceWorkItems.filter((item) => item.id > checkpointId && !completedIds.has(item.id));

  let queuedCount = 0;
  for (const item of queuedItems) {
    queuedCount++;
    const tradesman: Tradesman = {
      ...item.tradesman,
      workItemId: queuedCount
    };
    await store.appendWorkItem({
      id: queuedCount,
      tradesman,
      status: "queued",
      createdAt: new Date().toISOString()
    });
  }

  return queuedCount;
}

function findCheckpointWorkItemId(workItems: { id: number; tradesman: Tradesman }[], licenseNumber?: string): number {
  if (!licenseNumber) return 0;
  const normalized = licenseNumber.trim().toUpperCase();
  const checkpoint = workItems.find((item) => item.tradesman.licenseNumber.trim().toUpperCase() === normalized);
  return checkpoint?.id ?? 0;
}

async function* claimedTradesmen(
  store: PipelineStorage,
  workerId: string,
  claimedByLicense: Map<string, WorkItem>,
  limit?: number
): AsyncGenerator<Tradesman> {
  let claimedCount = 0;
  while (limit === undefined || claimedCount < limit) {
    if (store.isPauseRequested()) return;

    const item = await store.claimNextWorkItem(workerId);
    if (!item) return;

    claimedCount++;
    const tradesman = {
      ...item.tradesman,
      workItemId: item.id
    };
    claimedByLicense.set(normalizeLicenseNumber(tradesman.licenseNumber), item);
    yield tradesman;
  }
}

function normalizeLicenseNumber(licenseNumber: string | undefined): string {
  return licenseNumber?.trim().toUpperCase() ?? "";
}

async function processLookupQueue(context: RunContext): Promise<LookupStageResult> {
  const { options, outputPaths, store, logger, runState, reportProgress } = context;
  await store.acquireWorkerLock();
  const startedAt = new Date().toISOString();
  const workerId = `${process.pid}-${startedAt}`;
  let remainingWorkItems: WorkItem[] = [];
  const claimedByLicense = new Map<string, WorkItem>();
  let workerStatus: "running" | "paused" | "rate_limited" | "completed" | "failed" = "running";
  let sendCount = 0;
  let doNotSendCount = 0;
  let errorCount = 0;
  let rateLimited = false;

  try {
    await store.releaseStaleClaims(30 * 60 * 1000);
    await store.requeueFailedWorkItems(3);
    const workItems = await store.readWorkItems();
    const existingResults = await store.readLookupResults();
    const completedIds = new Set(existingResults.map((result) => result.workItemId).filter((id): id is number => id !== undefined));
    await Promise.all(workItems.filter((item) => completedIds.has(item.id) && item.status !== "completed").map((item) => store.completeWorkItem(item.id)));
    remainingWorkItems = workItems.filter((item) => item.status !== "completed" && !completedIds.has(item.id));
    workerStatus = store.isPauseRequested() ? "paused" : "running";
    await store.writeWorkerStatus({
      status: workerStatus,
      pid: process.pid,
      startedAt,
      heartbeatAt: startedAt,
      checked: 0,
      remaining: remainingWorkItems.length,
      errors: 0,
      message: workerStatus === "paused" ? "Worker is paused before starting website lookups." : "Worker started."
    });

    if (workerStatus === "paused") {
      return {
        sendCount: 0,
        doNotSendCount: 0,
        errorCount: 0,
        courseFrequencies: [],
        canceled: true
      };
    }

    reportProgress({
      type: "lookup_started",
      message: `Stage 2 of 3: processing ${remainingWorkItems.length} queued website lookup item(s).`,
      current: 0,
      total: remainingWorkItems.length,
      remaining: remainingWorkItems.length
    });

    const checker = new WashingtonLicenseChecker(logger, outputPaths, {
      headed: options.headed,
      slowMo: options.slowMo,
      checkDelayMs: options.checkDelayMs ?? 1500,
      retryAttempts: options.retryAttempts ?? 1,
      retryDelayMs: options.retryDelayMs ?? 5000,
      retryBackoffMultiplier: options.retryBackoffMultiplier ?? 2,
      limit: options.limit,
      onProgress: (update) => {
        reportProgress(update);
        if (update.errorCount !== undefined) errorCount = update.errorCount;
        if (update.type === "rate_limited") {
          rateLimited = true;
          workerStatus = "rate_limited";
        }
        if ((update.type === "website_check_error" || update.type === "rate_limited") && update.licenseNumber) {
          const claimed = claimedByLicense.get(normalizeLicenseNumber(update.licenseNumber));
          if (claimed) {
            void store.failWorkItem(claimed.id, update.message);
          }
        }
        void store.writeWorkerStatus({
          status: workerStatus,
          pid: process.pid,
          startedAt,
          heartbeatAt: new Date().toISOString(),
          checked: update.current ?? 0,
          remaining: update.remaining ?? 0,
          errors: update.errorCount ?? errorCount,
          message: update.message
        });
      },
      onResult: async (checkedResult: BucketedResult) => {
        await store.appendLookupResult(checkedResult);
        if (checkedResult.tradesman.workItemId !== undefined) {
          await store.completeWorkItem(checkedResult.tradesman.workItemId);
        }
        if (checkedResult.bucket === "send") {
          sendCount++;
        } else {
          doNotSendCount++;
        }
        await runState.recordResult(checkedResult.bucket, checkedResult.tradesman);
      },
      isCanceled: () => options.isCanceled?.() === true || store.isPauseRequested()
    });

    const result = await checker.checkLicenses(claimedTradesmen(store, workerId, claimedByLicense, options.limit));
    if (store.isPauseRequested() && result.canceled) {
      workerStatus = "paused";
    } else if (rateLimited) {
      workerStatus = "rate_limited";
    } else {
      workerStatus = result.canceled ? "paused" : "completed";
    }
    await store.writeCourseFrequencies(result.courseFrequencies);
    await store.writeWorkerStatus({
      status: workerStatus,
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      checked: sendCount + doNotSendCount + errorCount,
      remaining: result.canceled ? Math.max(0, remainingWorkItems.length - (sendCount + doNotSendCount + errorCount)) : 0,
      errors: errorCount,
      message: workerStatus === "completed" ? "Worker completed queued website lookups." : "Worker stopped before completing all queued lookups."
    });

    return {
      sendCount,
      doNotSendCount,
      errorCount,
      courseFrequencies: result.courseFrequencies,
      canceled: result.canceled
    };
  } catch (error) {
    await store.writeWorkerStatus({
      status: "failed",
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      checked: sendCount + doNotSendCount + errorCount,
      remaining: Math.max(0, remainingWorkItems.length - (sendCount + doNotSendCount + errorCount)),
      errors: errorCount,
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    await store.releaseWorkerLock();
  }
}

async function generateReports(context: RunContext, lookupResult: LookupStageResult): Promise<ReportStageResult> {
  const { outputPaths, store, reportProgress } = context;
  reportProgress({
    type: "reports_started",
    message: "Stage 3 of 3: generating CSV, Excel, and summary reports from durable lookup results."
  });

  const result = await regenerateReportsFromStore(outputPaths, lookupResult.courseFrequencies);

  reportProgress({
    type: "reports_complete",
    message: `Stage 3 complete. Generated reports from ${result.lookupResultCount} stored lookup result(s).`,
    sendCount: result.sendCount,
    doNotSendCount: result.doNotSendCount,
    lookupResultCount: result.lookupResultCount,
    courseFrequencyCount: result.courseFrequencyCount,
    files: {
      sendCsv: outputPaths.sendCsvPath,
      doNotSendCsv: outputPaths.doNotSendCsvPath,
      send: outputPaths.sendPath,
      doNotSend: outputPaths.doNotSendPath,
      coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath
    }
  });

  return {
    sendCount: result.sendCount,
    doNotSendCount: result.doNotSendCount,
    courseFrequencyCount: result.courseFrequencyCount
  };
}

export async function regenerateReportsFromStore(
  outputPaths: OutputPaths,
  fallbackCourseFrequencies: CourseFrequency[] = []
): Promise<ReportStageResult & { lookupResultCount: number }> {
  const store = new PipelineStore(outputPaths);
  const results = await store.readLookupResults();
  const sendTradesmen = results.filter((result) => result.bucket === "send").map((result) => result.tradesman);
  const doNotSendTradesmen = results.filter((result) => result.bucket === "doNotSend").map((result) => result.tradesman);
  const courseFrequencies = await store.readCourseFrequencies();
  const courses = courseFrequencies.length > 0 ? courseFrequencies : fallbackCourseFrequencies;

  await Promise.all([
    writeTradesmenCsv(sendTradesmen, outputPaths.sendCsvPath),
    writeTradesmenCsv(doNotSendTradesmen, outputPaths.doNotSendCsvPath),
    writeTradesmenWorkbook(sendTradesmen, outputPaths.sendPath),
    writeTradesmenWorkbook(doNotSendTradesmen, outputPaths.doNotSendPath),
    writeCourseFrequencies(courses, outputPaths.coursesAlreadyTakenPath)
  ]);

  return {
    sendCount: sendTradesmen.length,
    doNotSendCount: doNotSendTradesmen.length,
    courseFrequencyCount: courses.length,
    lookupResultCount: results.length
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
