import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import ExcelJS from "exceljs";
import { emailConfigured, emailRunResults } from "./email.js";
import { loadEnvFile } from "./env.js";
import { findInputWorkbookEmail, imapConfigured } from "./imap-input.js";
import { PipelineStore } from "./pipeline-store.js";
import type { WorkerStatus } from "./pipeline-storage.js";
import { buildOutputPaths } from "./paths.js";
import type { DurableRunState } from "./run-state.js";
import { regenerateReportsFromStore, runWashingtonCheck } from "./runner.js";
import { readTradesmenWorkbook, writeTradesmenWorkbook } from "./spreadsheet.js";
import type { OutputPaths, ProgressUpdate } from "./types.js";

loadEnvFile();

const port = Number(process.env.PORT ?? 3000);
const rootDir = resolve("Files", "web-runs");
const emailPollLogPath = resolve("Files", "email-poll.log");
const appIconPath = resolve("docs", "license-status-checker-icon.png");
const uploads = new Map<string, UploadedWorkbook>();
const runs = new Map<string, WebRun>();
const emailPollState: EmailPollStatus = {
  enabled: false,
  running: false,
  logPath: emailPollLogPath
};
let emailPollTimer: ReturnType<typeof setTimeout> | undefined;

interface UploadedWorkbook {
  id: string;
  path: string;
  originalName: string;
  worksheets: string[];
}

interface WebRun {
  id: string;
  status: "running" | "complete" | "canceled" | "error";
  outputDir: string;
  events: ProgressUpdate[];
  clients: Set<ServerResponse>;
  cancelRequested: boolean;
  outputPaths?: OutputPaths;
  error?: string;
}

interface RunStartOptions {
  worksheet?: string;
  headed: boolean;
  checkDelayMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
  limit?: number;
  resumeAfterLicenseNumber?: string;
  resumedFromRunId?: string;
  resumeSourceOutDir?: string;
}

interface EmailPollConfig {
  enabled: boolean;
  time?: string;
  worksheet?: string;
  headed: boolean;
  checkDelayMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
  limit?: number;
  baseUrl: string;
}

interface EmailPollStatus {
  enabled: boolean;
  scheduledTime?: string;
  nextCheckAt?: string;
  lastCheckedAt?: string;
  lastResult?: string;
  lastRunId?: string;
  running: boolean;
  logPath: string;
}

type CombinedWorkbookKind = "send" | "doNotSend";

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, pageHtml());
      return;
    }

    if (request.method === "GET" && url.pathname === "/app-icon.png") {
      await sendPngFile(response, appIconPath);
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      await handleRunsPage(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/latest-run") {
      await handleLatestRun(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      await handleUpload(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/check-email") {
      await handleCheckEmail(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/email-poll/status") {
      sendJson(response, 200, emailPollState);
      return;
    }

    if (request.method === "POST" && url.pathname === "/email-poll/enable") {
      await handleEnableEmailPoll(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/email-poll/disable") {
      await handleDisableEmailPoll(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/run") {
      await handleRun(request, response);
      return;
    }

    const cancelMatch = url.pathname.match(/^\/runs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      handleCancel(cancelMatch[1], response);
      return;
    }

    const deleteMatch = url.pathname.match(/^\/runs\/([^/]+)\/delete$/);
    if (request.method === "POST" && deleteMatch) {
      await handleDeleteRun(deleteMatch[1], response);
      return;
    }

    const resumeMatch = url.pathname.match(/^\/runs\/([^/]+)\/resume$/);
    if (request.method === "POST" && resumeMatch) {
      await handleResumeRun(resumeMatch[1], request, response);
      return;
    }

    const regenerateMatch = url.pathname.match(/^\/runs\/([^/]+)\/regenerate-reports$/);
    if (request.method === "POST" && regenerateMatch) {
      await handleRegenerateReports(regenerateMatch[1], response);
      return;
    }

    const pauseWorkerMatch = url.pathname.match(/^\/runs\/([^/]+)\/worker\/pause$/);
    if (request.method === "POST" && pauseWorkerMatch) {
      await handleWorkerPause(pauseWorkerMatch[1], response);
      return;
    }

    const resumeWorkerMatch = url.pathname.match(/^\/runs\/([^/]+)\/worker\/resume$/);
    if (request.method === "POST" && resumeWorkerMatch) {
      await handleWorkerResume(resumeWorkerMatch[1], response);
      return;
    }

    const combinedMatch = url.pathname.match(/^\/runs\/([^/]+)\/combined\/(send|doNotSend)$/);
    if (request.method === "GET" && combinedMatch) {
      await handleCombinedRunWorkbook(combinedMatch[1], combinedMatch[2] as CombinedWorkbookKind, response);
      return;
    }

    const eventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      handleEvents(eventsMatch[1], response);
      return;
    }

    const filesMatch = url.pathname.match(/^\/runs\/([^/]+)\/files\/([^/]+)$/);
    if (request.method === "GET" && filesMatch) {
      await handleFile(filesMatch[1], filesMatch[2], response, url.searchParams.get("download") === "1");
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, () => {
  console.log(`Web interface running at http://localhost:${port}`);
  startEmailPollScheduler();
});

async function handleUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const contentType = request.headers["content-type"] ?? "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!boundaryMatch) {
    sendJson(response, 400, { error: "Expected multipart form data." });
    return;
  }

  const body = await readRequestBody(request);
  const file = parseMultipartFile(body, boundaryMatch[1] ?? boundaryMatch[2]);
  if (!file) {
    sendJson(response, 400, { error: "No workbook file was uploaded." });
    return;
  }

  const uploaded = await saveUploadedWorkbook(file.filename, file.data);
  sendJson(response, 200, uploaded);
}

async function handleCheckEmail(response: ServerResponse): Promise<void> {
  if (!imapConfigured()) {
    sendJson(response, 400, { error: "IMAP settings are not configured." });
    return;
  }

  const workbook = await findInputWorkbookEmail();
  if (!workbook) {
    sendJson(response, 404, { error: "No matching unread email with an input workbook was found." });
    return;
  }

  const uploaded = await saveUploadedWorkbook(workbook.filename, workbook.content);
  sendJson(response, 200, {
    ...uploaded,
    email: {
      from: workbook.from,
      subject: workbook.subject,
      messageId: workbook.messageId
    }
  });
}

async function saveUploadedWorkbook(originalName: string, content: Buffer): Promise<UploadedWorkbook> {
  const uploadId = createRunFolderName();
  const uploadDir = join(rootDir, uploadId);
  const inputPath = join(uploadDir, "ListToCheck.xlsx");
  await mkdir(uploadDir, { recursive: true });
  await writeFile(inputPath, content);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const uploaded: UploadedWorkbook = {
    id: uploadId,
    path: inputPath,
    originalName,
    worksheets: workbook.worksheets.map((worksheet) => worksheet.name)
  };
  uploads.set(uploadId, uploaded);
  return uploaded;
}

async function handleRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = JSON.parse((await readRequestBody(request)).toString("utf8")) as {
    uploadId?: string;
    worksheet?: string;
    limit?: number;
    headed?: boolean;
    checkDelaySeconds?: number;
  };

  const upload = body.uploadId ? uploads.get(body.uploadId) : undefined;
  if (!upload) {
    sendJson(response, 400, { error: "Upload a workbook before starting a run." });
    return;
  }

  const run = startRun(upload, {
    worksheet: body.worksheet || undefined,
    headed: body.headed === true,
    checkDelayMs:
      Number.isFinite(body.checkDelaySeconds) && body.checkDelaySeconds !== undefined && body.checkDelaySeconds >= 0
        ? Math.round(body.checkDelaySeconds * 1000)
        : 1500,
    retryAttempts: 1,
    retryDelayMs: 5000,
    retryBackoffMultiplier: 2,
    limit: Number.isFinite(body.limit) && body.limit && body.limit > 0 ? body.limit : undefined
  }, requestBaseUrl(request));

  sendJson(response, 200, { runId: run.id });
}

async function handleResumeRun(sourceRunId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const activeSourceRun = runs.get(sourceRunId);
  if (activeSourceRun?.status === "running") {
    sendJson(response, 409, { error: "This run is still running. Stop it before starting a resumed run." });
    return;
  }

  const sourceRunDir = runDirectory(sourceRunId);
  if (!sourceRunDir) {
    sendJson(response, 400, { error: "Invalid run id." });
    return;
  }

  const sourceInputPath = join(sourceRunDir, "ListToCheck.xlsx");
  try {
    const inputStat = await stat(sourceInputPath);
    if (!inputStat.isFile()) {
      sendJson(response, 404, { error: "Original input workbook is not available for this run." });
      return;
    }
  } catch {
    sendJson(response, 404, { error: "Original input workbook is not available for this run." });
    return;
  }

  const sourceOutputPaths = await outputPathsForRun(sourceRunId);
  if (!sourceOutputPaths) {
    sendJson(response, 404, { error: "Run output is not available yet." });
    return;
  }

  const sourceState = await readRunState(sourceOutputPaths.runStatePath);
  if (!sourceState) {
    sendJson(response, 400, { error: "This run does not have durable state to resume from." });
    return;
  }

  if (sourceState.phase === "complete") {
    sendJson(response, 409, { error: "This run already completed successfully." });
    return;
  }

  const resumeAfterLicenseNumber = sourceState.checkpoint?.licenseNumber;
  if (!resumeAfterLicenseNumber) {
    sendJson(response, 400, { error: "This run does not have a checked license checkpoint yet." });
    return;
  }

  const upload = await copyWorkbookForResume(sourceInputPath, sourceRunId);
  const run = startRun(upload, {
    worksheet: sourceState.runOptions?.worksheet,
    headed: sourceState.runOptions?.headed ?? false,
    checkDelayMs: sourceState.runOptions?.checkDelayMs ?? 1500,
    retryAttempts: sourceState.runOptions?.retryAttempts ?? 1,
    retryDelayMs: sourceState.runOptions?.retryDelayMs ?? 5000,
    retryBackoffMultiplier: sourceState.runOptions?.retryBackoffMultiplier ?? 2,
    limit: sourceState.runOptions?.limit,
    resumeAfterLicenseNumber,
    resumedFromRunId: sourceRunId,
    resumeSourceOutDir: dirname(sourceOutputPaths.runStatePath)
  }, requestBaseUrl(request));

  sendJson(response, 200, { runId: run.id, resumedFromRunId: sourceRunId });
}

function startRun(upload: UploadedWorkbook, options: RunStartOptions, baseUrl: string, onFinished?: (run: WebRun) => void): WebRun {
  const runId = upload.id;
  const outputDir = join(dirname(upload.path), "output");
  const outputPaths = buildOutputPaths(outputDir);
  const run: WebRun = {
    id: runId,
    status: "running",
    outputDir,
    outputPaths,
    events: [],
    clients: new Set(),
    cancelRequested: false
  };
  runs.set(runId, run);

  void runWashingtonCheck({
    input: upload.path,
    outDir: outputDir,
    runId,
    worksheet: options.worksheet,
    headed: options.headed,
    slowMo: 0,
    checkDelayMs: options.checkDelayMs,
    retryAttempts: options.retryAttempts,
    retryDelayMs: options.retryDelayMs,
    retryBackoffMultiplier: options.retryBackoffMultiplier,
    limit: options.limit,
    resumeAfterLicenseNumber: options.resumeAfterLicenseNumber,
    resumedFromRunId: options.resumedFromRunId,
    resumeSourceOutDir: options.resumeSourceOutDir,
    onProgress: (update) => emit(run, update.files ? { ...update, files: fileLinks(run.id, outputPaths) } : update),
    isCanceled: () => run.cancelRequested
  })
    .then(async (result) => {
      run.status = result.canceled ? "canceled" : "complete";
      run.outputPaths = result.outputPaths;
      await maybeEmailResults(run, result, baseUrl);
      emit(run, {
        type: result.canceled ? "run_canceled" : "run_complete",
        message: result.canceled ? "Run stopped. Partial output files are ready." : "Run complete. Output files are ready.",
        files: fileLinks(run.id, result.outputPaths)
      });
      closeClients(run);
    })
    .catch((error) => {
      run.status = "error";
      run.error = error instanceof Error ? error.message : String(error);
      emit(run, { type: "run_error", message: run.error });
      closeClients(run);
    })
    .finally(() => {
      onFinished?.(run);
    });

  return run;
}

async function copyWorkbookForResume(sourceInputPath: string, sourceRunId: string): Promise<UploadedWorkbook> {
  const uploadId = createRunFolderName();
  const uploadDir = join(rootDir, uploadId);
  const inputPath = join(uploadDir, "ListToCheck.xlsx");
  await mkdir(uploadDir, { recursive: true });
  await copyFile(sourceInputPath, inputPath);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const uploaded: UploadedWorkbook = {
    id: uploadId,
    path: inputPath,
    originalName: `Resume of ${sourceRunId}`,
    worksheets: workbook.worksheets.map((worksheet) => worksheet.name)
  };
  uploads.set(uploadId, uploaded);
  return uploaded;
}

async function maybeEmailResults(
  run: WebRun,
  result: Awaited<ReturnType<typeof runWashingtonCheck>>,
  baseUrl: string
): Promise<void> {
  if (!emailConfigured()) {
    emit(run, {
      type: "email_skipped",
      message: "Email results skipped because SMTP settings are not configured."
    });
    return;
  }

  emit(run, {
    type: "email_sending",
    message: "Emailing results."
  });

  try {
    await emailRunResults({
      outputPaths: result.outputPaths,
      runId: run.id,
      baseUrl,
      canceled: result.canceled,
      sendCount: result.sendCount,
      doNotSendCount: result.doNotSendCount,
      courseFrequencyCount: result.courseFrequencyCount
    });
    emit(run, {
      type: "email_sent",
      message: "Email results sent."
    });
  } catch (error) {
    emit(run, {
      type: "email_error",
      message: `Email results could not be sent: ${error instanceof Error ? error.message : String(error)}`
    });
  }
}

function handleCancel(runId: string, response: ServerResponse): void {
  const run = runs.get(runId);
  if (!run) {
    sendJson(response, 404, { error: "Run not found" });
    return;
  }

  if (run.status !== "running") {
    sendJson(response, 200, { status: run.status });
    return;
  }

  run.cancelRequested = true;
  emit(run, {
    type: "cancel_requested",
    message: "Stop requested. The current website check will finish, then the run will stop before the next license."
  });
  sendJson(response, 200, { status: "cancel_requested" });
}

function handleEvents(runId: string, response: ServerResponse): void {
  const run = runs.get(runId);
  if (!run) {
    sendJson(response, 404, { error: "Run not found" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  for (const event of run.events) {
    writeEvent(response, event);
  }

  if (run.status === "running") {
    run.clients.add(response);
    response.on("close", () => run.clients.delete(response));
  } else {
    response.end();
  }
}

async function handleFile(runId: string, fileKey: string, response: ServerResponse, download: boolean): Promise<void> {
  const outputPaths = await outputPathsForRun(runId);
  if (!outputPaths) {
    sendJson(response, 404, { error: "Run output is not available yet." });
    return;
  }

  const path = pathForFileKey(outputPaths, fileKey);
  if (!path) {
    sendJson(response, 404, { error: "File not found." });
    return;
  }

  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      sendJson(response, 404, { error: "File not found." });
      return;
    }
  } catch {
    sendJson(response, 404, { error: "File not found." });
    return;
  }

  const extension = extname(path).toLowerCase();
  const contentType = extension === ".txt" || extension === ".csv" || extension === ".jsonl"
    ? "text/plain; charset=utf-8"
    : extension === ".json"
      ? "application/json; charset=utf-8"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${basename(path)}"`
  });
  createReadStream(path).pipe(response);
}

async function handleCombinedRunWorkbook(
  runId: string,
  kind: CombinedWorkbookKind,
  response: ServerResponse
): Promise<void> {
  const runSummaries = await listPreviousRuns();
  const group = groupedRunSummaries(runSummaries).find((candidate) => runIdsInGroup(candidate).includes(runId));
  if (!group) {
    sendJson(response, 404, { error: "Run group not found." });
    return;
  }

  const runIds = runIdsInGroup(group);
  const tradesmen = [];
  for (const linkedRunId of runIds) {
    const outputPaths = await outputPathsForRun(linkedRunId);
    if (!outputPaths) continue;

    const path = kind === "send" ? outputPaths.sendPath : outputPaths.doNotSendPath;
    try {
      tradesmen.push(...await readTradesmenWorkbook(path));
    } catch {
      continue;
    }
  }

  const tempDir = await mkdtemp(join(tmpdir(), "license-status-combined-"));
  const label = kind === "send" ? "Send" : "DoNotSend";
  const outputPath = join(tempDir, `Combined-${label}-${group.root.id}.xlsx`);

  try {
    await writeTradesmenWorkbook(tradesmen, outputPath);
    const workbook = await readFile(outputPath);
    response.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${basename(outputPath)}"`
    });
    response.end(workbook);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function handleRegenerateReports(runId: string, response: ServerResponse): Promise<void> {
  const activeRun = runs.get(runId);
  if (activeRun?.status === "running") {
    sendJson(response, 409, { error: "Cannot regenerate reports while the run is still running." });
    return;
  }

  const outputPaths = await outputPathsForRun(runId);
  if (!outputPaths) {
    sendJson(response, 404, { error: "Run output is not available." });
    return;
  }

  try {
    const lookupStat = await stat(outputPaths.lookupResultsPath);
    if (!lookupStat.isFile()) {
      sendJson(response, 404, { error: "This run does not have durable lookup results to regenerate reports from." });
      return;
    }
  } catch {
    sendJson(response, 404, { error: "This run does not have durable lookup results to regenerate reports from." });
    return;
  }

  const result = await regenerateReportsFromStore(outputPaths);
  sendJson(response, 200, {
    regenerated: true,
    runId,
    ...result,
    files: fileLinks(runId, outputPaths)
  });
}

async function handleWorkerPause(runId: string, response: ServerResponse): Promise<void> {
  const outputPaths = await outputPathsForRun(runId);
  if (!outputPaths) {
    sendJson(response, 404, { error: "Run output is not available." });
    return;
  }

  const store = new PipelineStore(outputPaths);
  await store.requestPause();
  const status = await store.readWorkerStatus();
  sendJson(response, 200, { paused: true, status });
}

async function handleWorkerResume(runId: string, response: ServerResponse): Promise<void> {
  const outputPaths = await outputPathsForRun(runId);
  if (!outputPaths) {
    sendJson(response, 404, { error: "Run output is not available." });
    return;
  }

  const store = new PipelineStore(outputPaths);
  await store.clearPause();
  const status = await store.readWorkerStatus();
  sendJson(response, 200, { paused: false, status });
}

async function handleDeleteRun(runId: string, response: ServerResponse): Promise<void> {
  const run = runs.get(runId);
  if (run?.status === "running") {
    sendJson(response, 409, { error: "Cannot delete a run while it is still running. Stop the run first." });
    return;
  }

  const runDir = runDirectory(runId);
  if (!runDir) {
    sendJson(response, 400, { error: "Invalid run id." });
    return;
  }

  try {
    const folderStat = await stat(runDir);
    if (!folderStat.isDirectory()) {
      sendJson(response, 404, { error: "Run folder not found." });
      return;
    }
  } catch {
    sendJson(response, 404, { error: "Run folder not found." });
    return;
  }

  await rm(runDir, { recursive: true, force: true });
  runs.delete(runId);
  uploads.delete(runId);
  sendJson(response, 200, { deleted: true, runId });
}

async function handleRunsPage(response: ServerResponse): Promise<void> {
  const runSummaries = await listPreviousRuns();
  sendHtml(response, runsHtml(runSummaries));
}

async function handleLatestRun(response: ServerResponse): Promise<void> {
  const activeRun = [...runs.values()]
    .filter((run) => run.status === "running")
    .sort((a, b) => b.id.localeCompare(a.id))[0];

  if (activeRun?.outputPaths) {
    sendJson(response, 200, {
      found: true,
      id: activeRun.id,
      status: activeRun.status,
      message: `Run ${activeRun.id} is still running.`,
      files: fileLinks(activeRun.id, activeRun.outputPaths)
    });
    return;
  }

  const [latestRun] = await listPreviousRuns();
  if (!latestRun) {
    sendJson(response, 200, { found: false });
    return;
  }

  sendJson(response, 200, {
    found: true,
    id: latestRun.id,
    status: latestRun.state?.phase ?? "unknown",
    message: latestRun.state?.lastMessage ?? `Latest run ${latestRun.id}.`,
    state: latestRun.state,
    files: Object.fromEntries(Object.entries(latestRun.files).map(([key, link]) => [key, link.href]))
  });
}

async function handleEnableEmailPoll(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const bodyText = (await readRequestBody(request)).toString("utf8").trim();
  const body = bodyText ? JSON.parse(bodyText) as { time?: string } : {};
  const config = emailPollConfig();
  config.enabled = true;
  config.time = body.time?.trim() || config.time;
  const result = await enableEmailPolling(config);
  sendJson(response, result.ok ? 200 : 400, result.ok ? emailPollState : { error: result.error, status: emailPollState });
}

async function handleDisableEmailPoll(response: ServerResponse): Promise<void> {
  await disableEmailPolling("Scheduled email polling disabled from the web UI.");
  sendJson(response, 200, emailPollState);
}

function emit(run: WebRun, update: ProgressUpdate): void {
  run.events.push(update);
  for (const client of run.clients) {
    writeEvent(client, update);
  }
}

function writeEvent(response: ServerResponse, update: ProgressUpdate): void {
  response.write(`data: ${JSON.stringify(update)}\n\n`);
}

function closeClients(run: WebRun): void {
  for (const client of run.clients) {
    client.end();
  }
  run.clients.clear();
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseMultipartFile(body: Buffer, boundary: string): { filename: string; data: Buffer } | undefined {
  const delimiter = Buffer.from(`--${boundary}`);
  let offset = 0;

  while (offset < body.length) {
    const start = body.indexOf(delimiter, offset);
    if (start === -1) break;

    const headerStart = start + delimiter.length + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;

    const headers = body.slice(headerStart, headerEnd).toString("utf8");
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const dataStart = headerEnd + 4;
    const next = body.indexOf(delimiter, dataStart);
    if (next === -1) break;

    if (filenameMatch) {
      const dataEnd = next - 2;
      return {
        filename: basename(filenameMatch[1]),
        data: body.slice(dataStart, dataEnd)
      };
    }

    offset = next;
  }

  return undefined;
}

function pathForFileKey(outputPaths: OutputPaths, fileKey: string): string | undefined {
  const files: Record<string, string> = {
    send: outputPaths.sendPath,
    doNotSend: outputPaths.doNotSendPath,
    sendCsv: outputPaths.sendCsvPath,
    doNotSendCsv: outputPaths.doNotSendCsvPath,
    workItems: outputPaths.workItemsPath,
    lookupResults: outputPaths.lookupResultsPath,
    courseFrequenciesJson: outputPaths.courseFrequenciesJsonPath,
    workerStatus: outputPaths.workerStatusPath,
    workerControl: outputPaths.workerControlPath,
    coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath,
    expired: outputPaths.expiredLogPath,
    greaterThan90: outputPaths.greaterThan90LogPath,
    exception: outputPaths.exceptionLogPath,
    runState: outputPaths.runStatePath
  };
  return files[fileKey];
}

async function outputPathsForRun(runId: string): Promise<OutputPaths | undefined> {
  const run = runs.get(runId);
  if (run?.outputPaths) return run.outputPaths;

  const runDir = runDirectory(runId);
  if (!runDir) return undefined;

  const outputDir = join(runDir, "output");
  const files = await filesInDirectory(outputDir);
  const send = files.find((file) => /^Send-.+\.xlsx$/i.test(file));
  const doNotSend = files.find((file) => /^DoNotSend-.+\.xlsx$/i.test(file));

  if (!send || !doNotSend) return undefined;

  return {
    sendPath: join(outputDir, send),
    doNotSendPath: join(outputDir, doNotSend),
    sendCsvPath: join(outputDir, "Send.csv"),
    doNotSendCsvPath: join(outputDir, "DoNotSend.csv"),
    workItemsPath: join(outputDir, "work-items.jsonl"),
    lookupResultsPath: join(outputDir, "lookup-results.jsonl"),
    courseFrequenciesJsonPath: join(outputDir, "course-frequencies.json"),
    workerStatusPath: join(outputDir, "worker-status.json"),
    workerControlPath: join(outputDir, "worker-control.json"),
    workerLockPath: join(outputDir, "worker.lock"),
    coursesAlreadyTakenPath: join(outputDir, "coursesAlreadyTaken.xlsx"),
    expiredLogPath: join(outputDir, "expired.txt"),
    greaterThan90LogPath: join(outputDir, "greaterThan90.txt"),
    exceptionLogPath: join(outputDir, "exception.txt"),
    runStatePath: join(outputDir, "run-state.json")
  };
}

async function listPreviousRuns(): Promise<PreviousRunSummary[]> {
  await mkdir(rootDir, { recursive: true });
  const entries = await readdir(rootDir, { withFileTypes: true });
  const summaries: PreviousRunSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const outputPaths = await outputPathsForRun(entry.name);
    if (!outputPaths) continue;

    const runDir = runDirectory(entry.name);
    if (!runDir) continue;

    const folderStat = await stat(runDir);
    const state = await readRunStateSummary(outputPaths.runStatePath);
    const files = await existingRunFileLinks(outputPaths, previousRunFileLinks(entry.name, outputPaths));
    if (!state) delete files.runState;

    summaries.push({
      id: entry.name,
      createdAt: folderStat.birthtime.toLocaleString(),
      files,
      state
    });
  }

  return summaries.sort((a, b) => b.id.localeCompare(a.id));
}

function runDirectory(runId: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..") return undefined;

  const directory = resolve(rootDir, runId);
  const rootWithSeparator = `${rootDir}${rootDir.endsWith("/") ? "" : "/"}`;
  if (directory !== rootDir && !directory.startsWith(rootWithSeparator)) return undefined;

  return directory;
}

async function filesInDirectory(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function fileLinks(runId: string, outputPaths: OutputPaths): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      send: outputPaths.sendPath,
      doNotSend: outputPaths.doNotSendPath,
      sendCsv: outputPaths.sendCsvPath,
      doNotSendCsv: outputPaths.doNotSendCsvPath,
      workItems: outputPaths.workItemsPath,
      lookupResults: outputPaths.lookupResultsPath,
      courseFrequenciesJson: outputPaths.courseFrequenciesJsonPath,
      workerStatus: outputPaths.workerStatusPath,
      workerControl: outputPaths.workerControlPath,
      coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath,
      expired: outputPaths.expiredLogPath,
      greaterThan90: outputPaths.greaterThan90LogPath,
      exception: outputPaths.exceptionLogPath,
      runState: outputPaths.runStatePath
    }).map(([key]) => [key, `/runs/${runId}/files/${key}`])
  );
}

function previousRunFileLinks(runId: string, outputPaths: OutputPaths): Record<string, FileLink> {
  return Object.fromEntries(
    Object.entries({
      send: outputPaths.sendPath,
      doNotSend: outputPaths.doNotSendPath,
      sendCsv: outputPaths.sendCsvPath,
      doNotSendCsv: outputPaths.doNotSendCsvPath,
      workItems: outputPaths.workItemsPath,
      lookupResults: outputPaths.lookupResultsPath,
      courseFrequenciesJson: outputPaths.courseFrequenciesJsonPath,
      workerStatus: outputPaths.workerStatusPath,
      workerControl: outputPaths.workerControlPath,
      coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath,
      expired: outputPaths.expiredLogPath,
      greaterThan90: outputPaths.greaterThan90LogPath,
      exception: outputPaths.exceptionLogPath,
      runState: outputPaths.runStatePath
    }).map(([key, path]) => [key, { href: `/runs/${runId}/files/${key}`, label: basename(path) }])
  );
}

async function existingRunFileLinks(outputPaths: OutputPaths, files: Record<string, FileLink>): Promise<Record<string, FileLink>> {
  const entries = await Promise.all(
    Object.entries(files).map(async ([key, link]) => {
      const path = pathForFileKey(outputPaths, key);
      if (!path) return undefined;

      try {
        const fileStat = await stat(path);
        return fileStat.isFile() ? [key, link] as const : undefined;
      } catch {
        return undefined;
      }
    })
  );

  return Object.fromEntries(entries.filter((entry): entry is readonly [string, FileLink] => entry !== undefined));
}

async function readRunStateSummary(path: string): Promise<PreviousRunStateSummary | undefined> {
  const state = await readRunState(path);
  if (!state) return undefined;
  const exceptionSummary = await readExceptionSummary(path);
  const workerStatus = await readWorkerStatusSummary(path);

  return {
    phase: state.phase,
    startedAt: formatDateTime(state.startedAt),
    updatedAt: formatDateTime(state.updatedAt),
    completedAt: state.completedAt ? formatDateTime(state.completedAt) : undefined,
    eligible: state.counts.eligible,
    checked: state.counts.checked,
    send: state.counts.send,
    doNotSend: state.counts.doNotSend,
    errors: Math.max(state.counts.errors, exceptionSummary.count),
    canceled: state.canceled,
    canResume: state.canResume ?? (state.canceled && Boolean(state.checkpoint?.licenseNumber)),
    rateLimited: state.rateLimited ?? exceptionSummary.rateLimited,
    lastLicenseNumber: state.checkpoint?.licenseNumber,
    lastMessage: state.lastMessage,
    lastError: state.lastError ?? exceptionSummary.lastError,
    error: state.error,
    resumeAfterLicenseNumber: state.runOptions?.resumeAfterLicenseNumber,
    resumedFromRunId: state.runOptions?.resumedFromRunId,
    workerStatus
  };
}

async function readWorkerStatusSummary(runStatePath: string): Promise<WorkerStatus | undefined> {
  try {
    return JSON.parse(await readFile(join(dirname(runStatePath), "worker-status.json"), "utf8")) as WorkerStatus;
  } catch {
    return undefined;
  }
}

async function readExceptionSummary(runStatePath: string): Promise<{ count: number; lastError?: string; rateLimited: boolean }> {
  const exceptionPath = join(dirname(runStatePath), "exception.txt");
  try {
    const content = await readFile(exceptionPath, "utf8");
    if (!content.trim() || content.includes("There were no exceptions.")) {
      return { count: 0, rateLimited: false };
    }

    const count = (content.match(/^License /gm) ?? []).length || content.trim().split(/\n\s*\n/).filter(Boolean).length;
    const entries = content.split(/(?=^License )/gm).map((entry) => entry.trim()).filter(Boolean);
    const lastError = entries.at(-1)?.split("\n").slice(0, 3).join(" ");
    return {
      count,
      lastError,
      rateLimited: /429|rate-limit|rate limit|F5/i.test(content)
    };
  } catch {
    return { count: 0, rateLimited: false };
  }
}

async function readRunState(path: string): Promise<DurableRunState | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DurableRunState;
  } catch {
    return undefined;
  }
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function createRunFolderName(date = new Date()): string {
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("-");

  if (!uploads.has(stamp) && !runs.has(stamp)) {
    return stamp;
  }

  for (let counter = 2; ; counter++) {
    const candidate = `${stamp}-${counter}`;
    if (!uploads.has(candidate) && !runs.has(candidate)) {
      return candidate;
    }
  }
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

async function sendPngFile(response: ServerResponse, path: string): Promise<void> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      sendJson(response, 404, { error: "File not found." });
      return;
    }
  } catch {
    sendJson(response, 404, { error: "File not found." });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=3600"
  });
  createReadStream(path).pipe(response);
}

function requestBaseUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? `localhost:${port}`;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return `${proto ?? "http"}://${host}`;
}

function startEmailPollScheduler(): void {
  const config = emailPollConfig();

  if (!config.enabled) {
    emailPollState.enabled = false;
    emailPollState.scheduledTime = config.time;
    void logEmailPoll("Scheduled email polling is disabled.");
    return;
  }

  void enableEmailPolling(config);
}

async function enableEmailPolling(config = { ...emailPollConfig(), enabled: true }): Promise<{ ok: true } | { ok: false; error: string }> {
  stopEmailPollTimer();
  emailPollState.enabled = true;
  emailPollState.scheduledTime = config.time;
  emailPollState.nextCheckAt = undefined;

  if (!imapConfigured()) {
    emailPollState.enabled = false;
    emailPollState.lastResult = "IMAP settings are not configured.";
    await logEmailPoll("Scheduled email polling is enabled, but IMAP settings are not configured.");
    return { ok: false, error: emailPollState.lastResult };
  }

  if (!config.time) {
    emailPollState.enabled = false;
    emailPollState.lastResult = "EMAIL_POLL_TIME is not configured.";
    await logEmailPoll("Scheduled email polling is enabled, but EMAIL_POLL_TIME is not configured.");
    return { ok: false, error: emailPollState.lastResult };
  }

  try {
    scheduleNextEmailPoll(config);
    emailPollState.lastResult = `Scheduled email polling enabled for ${config.time}.`;
    await logEmailPoll(emailPollState.lastResult);
    return { ok: true };
  } catch (error) {
    emailPollState.enabled = false;
    emailPollState.lastResult = error instanceof Error ? error.message : String(error);
    await logEmailPoll(emailPollState.lastResult);
    return { ok: false, error: emailPollState.lastResult };
  }
}

function scheduleNextEmailPoll(config: EmailPollConfig): void {
  if (!config.time) return;

  stopEmailPollTimer();
  const nextCheck = nextDailyCheckAt(config.time);
  emailPollState.nextCheckAt = nextCheck.toISOString();
  const delayMs = Math.max(0, nextCheck.getTime() - Date.now());
  emailPollTimer = setTimeout(() => {
    void runScheduledEmailPoll(config).finally(() => {
      if (emailPollState.enabled) {
        scheduleNextEmailPoll(config);
      }
    });
  }, delayMs);
}

async function disableEmailPolling(message: string): Promise<void> {
  stopEmailPollTimer();
  emailPollState.enabled = false;
  emailPollState.nextCheckAt = undefined;
  emailPollState.lastResult = message;
  await logEmailPoll(message);
}

function stopEmailPollTimer(): void {
  if (!emailPollTimer) return;
  clearTimeout(emailPollTimer);
  emailPollTimer = undefined;
}

async function runScheduledEmailPoll(config: EmailPollConfig): Promise<void> {
  if (emailPollState.running) return;

  emailPollState.running = true;
  emailPollState.lastCheckedAt = new Date().toISOString();
  await logEmailPoll(`Checking email for input workbook at scheduled time ${config.time}.`);

  try {
    if (activeRunExists()) {
      emailPollState.lastResult = "Skipped because a run is already active.";
      await logEmailPoll(emailPollState.lastResult);
      return;
    }

    const workbook = await findInputWorkbookEmail();
    if (!workbook) {
      emailPollState.lastResult = "No matching unread email input workbook found.";
      await logEmailPoll(emailPollState.lastResult);
      return;
    }

    const uploaded = await saveUploadedWorkbook(workbook.filename, workbook.content);
    const run = startRun(
      uploaded,
      {
        worksheet: config.worksheet,
        headed: config.headed,
        checkDelayMs: config.checkDelayMs,
        retryAttempts: config.retryAttempts,
        retryDelayMs: config.retryDelayMs,
        retryBackoffMultiplier: config.retryBackoffMultiplier,
        limit: config.limit
      },
      config.baseUrl,
      (finishedRun) => {
        void logEmailPoll(`Run ${finishedRun.id} finished with status ${finishedRun.status}.`);
      }
    );

    emailPollState.lastRunId = run.id;
    emailPollState.lastResult = `Found ${workbook.filename} and started run ${run.id}.`;
    await logEmailPoll(`${emailPollState.lastResult} Subject: ${workbook.subject ?? "(no subject)"}.`);
  } catch (error) {
    emailPollState.lastResult = `Email poll failed: ${error instanceof Error ? error.message : String(error)}`;
    await logEmailPoll(emailPollState.lastResult);
  } finally {
    emailPollState.running = false;
  }
}

function emailPollConfig(): EmailPollConfig {
  const time = process.env.EMAIL_POLL_TIME?.trim();
  const enabled = process.env.EMAIL_POLL_ENABLED === undefined
    ? Boolean(time)
    : parseBoolean(process.env.EMAIL_POLL_ENABLED);
  const limit = Number(process.env.EMAIL_POLL_LIMIT);
  const checkDelayMs = Number(process.env.EMAIL_POLL_CHECK_DELAY_MS ?? 1500);
  const retryAttempts = Number(process.env.EMAIL_POLL_WEBSITE_RETRIES ?? 1);
  const retryDelayMs = Number(process.env.EMAIL_POLL_RETRY_DELAY_MS ?? 5000);
  const retryBackoffMultiplier = Number(process.env.EMAIL_POLL_RETRY_BACKOFF_MULTIPLIER ?? 2);

  return {
    enabled,
    time,
    worksheet: process.env.EMAIL_POLL_WORKSHEET || undefined,
    headed: parseBoolean(process.env.EMAIL_POLL_HEADED),
    checkDelayMs: Number.isFinite(checkDelayMs) && checkDelayMs >= 0 ? checkDelayMs : 1500,
    retryAttempts: Number.isFinite(retryAttempts) && retryAttempts >= 0 ? retryAttempts : 1,
    retryDelayMs: Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 5000,
    retryBackoffMultiplier: Number.isFinite(retryBackoffMultiplier) && retryBackoffMultiplier >= 1 ? retryBackoffMultiplier : 2,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    baseUrl: process.env.EMAIL_BASE_URL ?? `http://localhost:${port}`
  };
}

function nextDailyCheckAt(time: string, now = new Date()): Date {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`EMAIL_POLL_TIME must use HH:MM format, got: ${time}`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`EMAIL_POLL_TIME must use HH:MM format, got: ${time}`);
  }

  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function activeRunExists(): boolean {
  return [...runs.values()].some((run) => run.status === "running");
}

async function logEmailPoll(message: string): Promise<void> {
  await mkdir(dirname(emailPollLogPath), { recursive: true });
  const line = `${new Date().toLocaleString()} ${message}\n`;
  await appendFile(emailPollLogPath, line, "utf8");
  console.log(`[email-poll] ${message}`);
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" href="/app-icon.png">
  <link rel="apple-touch-icon" href="/app-icon.png">
  <title>License Status Checker</title>
  <style>
    :root { color-scheme: light; --ink:#10233f; --muted:#5d6673; --line:#cfd8d3; --panel:#f4faf6; --accent:#005f3c; --accent-strong:#00345f; --ok:#0b6f43; --warn:#d19300; --danger:#b3261e; --gold:#f6be00; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, Helvetica, sans-serif; color:var(--ink); background:#fbfdfb; }
    header { border-bottom:1px solid var(--line); padding:14px 24px; display:flex; align-items:center; justify-content:space-between; gap:16px; background:#fff; box-shadow:0 1px 0 rgba(16,35,63,.04); }
    h1 { font-size:20px; margin:0; font-weight:700; color:var(--accent-strong); }
    .brand { display:flex; align-items:center; gap:12px; min-width:0; }
    .brand-icon { width:48px; height:48px; border-radius:10px; object-fit:cover; border:1px solid var(--line); background:#fff; box-shadow:0 2px 8px rgba(16,35,63,.12); flex:0 0 auto; }
    main { display:grid; grid-template-columns: 360px 1fr; min-height:calc(100vh - 65px); }
    aside { border-right:1px solid var(--line); padding:20px; background:var(--panel); }
    section { padding:20px 24px; }
    label { display:block; font-size:13px; font-weight:700; margin:18px 0 6px; }
    input, select { width:100%; min-height:38px; border:1px solid var(--line); border-radius:6px; padding:8px 10px; font-size:14px; background:#fff; color:var(--ink); }
    input:focus, select:focus { outline:2px solid rgba(246,190,0,.45); border-color:var(--accent); }
    input[type="checkbox"] { width:auto; min-height:auto; }
    button { min-height:38px; border:0; border-radius:6px; padding:8px 12px; font-size:14px; font-weight:700; background:var(--accent); color:#fff; cursor:pointer; }
    button:hover:not(:disabled) { background:var(--accent-strong); }
    button.danger { background:var(--danger); }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .row { display:flex; align-items:center; gap:8px; }
    .toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:18px; }
    .toolbar h2 { margin:0; }
    .toolbar label { margin:0; font-weight:400; }
    .stack { display:grid; gap:12px; }
    .meta { color:var(--muted); font-size:13px; line-height:1.4; }
    .progress { margin:0 0 18px; border:1px solid var(--line); border-radius:6px; overflow:hidden; height:18px; background:#f1f3f4; }
    .bar { height:100%; width:0%; background:linear-gradient(90deg, var(--accent), var(--gold)); transition:width .2s ease; }
    .stage-flow { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; margin:16px 0 10px; }
    .stage { border:1px solid var(--line); border-radius:6px; padding:10px; background:#fff; min-width:0; position:relative; }
    .stage::before { content:""; position:absolute; top:0; left:0; right:0; height:4px; background:#d9e1dd; border-radius:6px 6px 0 0; }
    .stage strong { display:block; font-size:13px; margin:0 0 4px; color:var(--ink); }
    .stage span { display:block; color:var(--muted); font-size:12px; line-height:1.35; overflow-wrap:anywhere; }
    .stage small { display:block; margin-top:8px; color:var(--ink); font-size:12px; font-weight:700; line-height:1.35; overflow-wrap:anywhere; }
    .stage.pending { opacity:.72; }
    .stage.active { border-color:var(--gold); box-shadow:0 0 0 2px rgba(246,190,0,.18); }
    .stage.active::before { background:var(--gold); }
    .stage.done::before { background:var(--ok); }
    .stage.error::before { background:var(--danger); }
    .stage.error strong { color:var(--danger); }
    .feed { border:1px solid var(--line); border-radius:6px; height:55vh; overflow:auto; padding:10px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; background:#fff; }
    .feed div { padding:5px 0; border-bottom:1px solid #f1f3f4; }
    .files { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:10px; margin-top:14px; }
    .file { border:1px solid var(--line); border-radius:6px; padding:10px; display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .file-name { display:flex; align-items:center; gap:10px; min-width:0; }
    .file-icon { width:28px; height:34px; border:1px solid var(--line); border-radius:4px; display:grid; place-items:center; font-size:15px; font-weight:700; flex:0 0 auto; position:relative; background:#fff; }
    .file-icon::after { content:""; position:absolute; top:-1px; right:-1px; width:9px; height:9px; border-left:1px solid var(--line); border-bottom:1px solid var(--line); background:#f1f3f4; border-radius:0 4px 0 2px; }
    .file-icon.excel { color:#137333; border-color:#9bc3a8; background:#f3fbf5; }
    .file-icon.text { color:#5f6368; border-color:#c7ccd1; background:#f8fafd; }
    .file-actions { display:flex; gap:8px; flex:0 0 auto; }
    .file a, .meta a { color:var(--accent-strong); font-weight:700; text-decoration:none; }
    .status-box { border:1px solid var(--line); border-radius:6px; padding:10px; background:#fff; }
    .status-box h2 { font-size:14px; margin:0 0 8px; }
    .status-box dl { margin:0; display:grid; gap:6px; }
    .status-box dt { font-weight:700; color:var(--ink); }
    .status-box dd { margin:0; color:var(--muted); overflow-wrap:anywhere; }
    .status-actions { display:flex; gap:8px; margin-top:10px; }
    .status-actions button { flex:1; }
    button.secondary { background:#5f6368; }
    @media (max-width: 760px) { main { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } .stage-flow { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <img class="brand-icon" src="/app-icon.png" alt="" aria-hidden="true">
      <h1>License Status Checker</h1>
    </div>
    <div class="meta"><a href="/runs">Previous Runs</a> · <span id="status">Upload a workbook to begin.</span></div>
  </header>
  <main>
    <aside>
      <div class="stack">
        <div>
          <label for="file">Input workbook</label>
          <input id="file" type="file" accept=".xlsx">
        </div>
        <button id="upload">Upload Input File</button>
        <button id="checkEmail">Check Email for Input File</button>
        <div class="meta" id="uploadMeta"></div>
        <div>
          <label for="worksheet">Worksheet</label>
          <select id="worksheet" disabled>
            <option value="">All worksheets</option>
          </select>
        </div>
        <div>
          <label for="limit">Website check limit</label>
          <input id="limit" type="number" min="1" step="1" placeholder="Leave blank for all eligible rows">
        </div>
        <div>
          <label for="checkDelay">Pause between website checks</label>
          <input id="checkDelay" type="number" min="0" step="0.5" value="1.5">
        </div>
        <label class="row"><input id="headed" type="checkbox"> Debug: Show browser window (only works locally)</label>
        <button id="run" disabled>Run Check</button>
        <button id="stop" class="danger" disabled>Stop Run</button>
        <div class="status-box">
          <h2>Email Polling</h2>
          <dl>
            <dt>Status</dt><dd id="emailPollEnabled">Loading</dd>
            <dt>Poll time</dt><dd><input id="emailPollTime" type="time"></dd>
            <dt>Last checked</dt><dd id="emailPollLastChecked">Loading</dd>
            <dt>Last result</dt><dd id="emailPollLastResult">Loading</dd>
            <dt>Next check</dt><dd id="emailPollNextCheck">Loading</dd>
          </dl>
          <div class="status-actions">
            <button id="enableEmailPoll" type="button">Enable</button>
            <button id="disableEmailPoll" type="button" class="secondary">Disable</button>
          </div>
        </div>
      </div>
    </aside>
    <section>
      <div class="progress"><div class="bar" id="bar"></div></div>
      <div class="meta" id="progressMeta">No run started.</div>
      <div class="stage-flow" aria-label="Run stages">
        <div class="stage pending" id="stageImport"><strong>Import</strong><span>Waiting for workbook.</span><small>Rows 0 · Queued 0</small></div>
        <div class="stage pending" id="stageLookup"><strong>Website Lookup</strong><span>Waiting for queued work.</span><small>Checked 0 · Remaining 0 · Errors 0</small></div>
        <div class="stage pending" id="stageReports"><strong>Reports</strong><span>Waiting for lookup results.</span><small>Results 0 · Send 0 · Do-not-send 0</small></div>
      </div>
      <div class="toolbar">
        <h2>Progress</h2>
        <label class="row"><input id="autoScroll" type="checkbox" checked> Auto-scroll while running</label>
      </div>
      <div class="feed" id="feed"></div>
      <h2>Output Files</h2>
      <div class="files" id="files"></div>
    </section>
  </main>
  <script>
    const state = { uploadId: null, eventSource: null, isRunning: false, currentRunId: null, stopRequested: false };
    const stageMetrics = {
      importRows: 0,
      queued: 0,
      checked: 0,
      remaining: 0,
      send: 0,
      doNotSend: 0,
      errors: 0,
      lookupResults: 0,
      courses: 0
    };
    const maxFeedLines = 500;
    const fileInput = document.getElementById("file");
    const uploadButton = document.getElementById("upload");
    const checkEmailButton = document.getElementById("checkEmail");
    const runButton = document.getElementById("run");
    const stopButton = document.getElementById("stop");
    const worksheet = document.getElementById("worksheet");
    const limit = document.getElementById("limit");
    const checkDelay = document.getElementById("checkDelay");
    const headed = document.getElementById("headed");
    const feed = document.getElementById("feed");
    const files = document.getElementById("files");
    const status = document.getElementById("status");
    const uploadMeta = document.getElementById("uploadMeta");
    const bar = document.getElementById("bar");
    const progressMeta = document.getElementById("progressMeta");
    const stageImport = document.getElementById("stageImport");
    const stageLookup = document.getElementById("stageLookup");
    const stageReports = document.getElementById("stageReports");
    const autoScroll = document.getElementById("autoScroll");
    const emailPollEnabled = document.getElementById("emailPollEnabled");
    const emailPollLastChecked = document.getElementById("emailPollLastChecked");
    const emailPollLastResult = document.getElementById("emailPollLastResult");
    const emailPollNextCheck = document.getElementById("emailPollNextCheck");
    const emailPollTime = document.getElementById("emailPollTime");
    const enableEmailPoll = document.getElementById("enableEmailPoll");
    const disableEmailPoll = document.getElementById("disableEmailPoll");

    refreshEmailPollStatus();
    setInterval(refreshEmailPollStatus, 60000);

    uploadButton.addEventListener("click", async () => {
      const file = fileInput.files[0];
      if (!file) return setStatus("Choose an .xlsx file first.");
      setBusy(true);
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/upload", { method: "POST", body: form });
      const payload = await response.json();
      setBusy(false);
      if (!response.ok) return setStatus(payload.error || "Upload failed.");

      loadWorkbook(payload, "Workbook uploaded.");
    });

    checkEmailButton.addEventListener("click", async () => {
      setBusy(true);
      setStatus("Checking email for input file.");
      const response = await fetch("/check-email", { method: "POST" });
      const payload = await response.json();
      setBusy(false);
      if (!response.ok) return setStatus(payload.error || "Email check failed.");

      const source = payload.email?.subject ? ' from email "' + payload.email.subject + '"' : " from email";
      loadWorkbook(payload, "Workbook loaded" + source + ".");
    });

    runButton.addEventListener("click", async () => {
      if (!state.uploadId) return setStatus("Upload a workbook first.");
      feed.innerHTML = "";
      files.innerHTML = "";
      bar.style.width = "0%";
      resetStages();
      state.isRunning = true;
      state.currentRunId = null;
      state.stopRequested = false;
      setBusy(true);
      const response = await fetch("/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId: state.uploadId,
          worksheet: worksheet.value,
          limit: limit.value ? Number(limit.value) : undefined,
          checkDelaySeconds: checkDelay.value ? Number(checkDelay.value) : 0,
          headed: headed.checked
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        state.isRunning = false;
        state.stopRequested = false;
        setBusy(false);
        return setStatus(payload.error || "Run failed to start.");
      }
      state.currentRunId = payload.runId;
      connect(payload.runId);
      setStatus("Run started.");
    });

    stopButton.addEventListener("click", async () => {
      if (!state.currentRunId || state.stopRequested) return;
      state.stopRequested = true;
      stopButton.disabled = true;
      append("Stop requested. Waiting for the current website check to finish.");
      const response = await fetch("/runs/" + state.currentRunId + "/cancel", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        append(payload.error || "Stop request failed.");
        state.stopRequested = false;
        stopButton.disabled = false;
        return;
      }
      setStatus("Stop requested.");
    });

    enableEmailPoll.addEventListener("click", async () => {
      const initialTime = emailPollTime.value || "06:00";
      const requestedTime = window.prompt("What time should email polling run each day? Use 24-hour HH:MM time.", initialTime);
      if (requestedTime === null) {
        await refreshEmailPollStatus();
        return;
      }

      const time = requestedTime.trim();
      if (!/^\\d{1,2}:\\d{2}$/.test(time)) {
        setStatus("Enter poll time as HH:MM, for example 06:00.");
        await refreshEmailPollStatus();
        return;
      }

      emailPollTime.value = time;
      await setEmailPolling("/email-poll/enable", { time });
    });

    disableEmailPoll.addEventListener("click", async () => {
      await setEmailPolling("/email-poll/disable");
    });

    const monitorRunId = new URLSearchParams(window.location.search).get("runId");
    if (monitorRunId) {
      feed.innerHTML = "";
      files.innerHTML = "";
      bar.style.width = "0%";
      state.isRunning = true;
      state.currentRunId = monitorRunId;
      state.stopRequested = false;
      setBusy(true);
      resetStages();
      connect(monitorRunId);
      setStatus("Monitoring run " + monitorRunId + ".");
    } else {
      restoreLatestRun();
    }

    function connect(runId) {
      closeProgressStream();
      state.eventSource = new EventSource("/runs/" + runId + "/events");
      state.eventSource.onmessage = (event) => {
        const update = JSON.parse(event.data);
        append(update.message);
        updateStageFlow(update);
        if (update.total) {
          const pct = Math.round(((update.current || 0) / update.total) * 100);
          bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
          progressMeta.textContent = update.remaining === undefined
            ? update.message
            : update.message + " Remaining: " + update.remaining + ".";
        } else {
          progressMeta.textContent = update.message;
        }
        if (update.files && (update.type === "run_complete" || update.type === "run_canceled")) {
          renderFiles(update.files);
          updateStageFlow({ type: update.type === "run_canceled" ? "run_canceled" : "run_complete", message: update.message });
          state.isRunning = false;
          state.currentRunId = null;
          state.stopRequested = false;
          updateStageFlow(update);
          closeProgressStream();
          setBusy(false);
          setStatus(update.type === "run_canceled" ? "Run stopped." : "Run complete.");
        }
        if (update.type === "run_error") {
          state.isRunning = false;
          state.currentRunId = null;
          state.stopRequested = false;
          closeProgressStream();
          setBusy(false);
          setStatus(update.message);
        }
      };
      state.eventSource.onerror = () => {
        state.isRunning = false;
        state.currentRunId = null;
        state.stopRequested = false;
        if (status.textContent !== "Run complete." && status.textContent !== "Run stopped.") {
          setStatus("Progress connection closed.");
        }
        closeProgressStream();
        setBusy(false);
      };
    }

    function closeProgressStream() {
      if (!state.eventSource) return;
      state.eventSource.close();
      state.eventSource = null;
    }

    function renderFiles(fileLinks) {
      const labels = {
        send: "Send workbook",
        doNotSend: "Do-not-send workbook",
        sendCsv: "Send CSV",
        doNotSendCsv: "Do-not-send CSV",
        workItems: "Work queue",
        lookupResults: "Lookup results",
        courseFrequenciesJson: "Course frequency data",
        workerStatus: "Worker status",
        workerControl: "Worker control",
        coursesAlreadyTaken: "Course frequency workbook",
        expired: "Expired log",
        greaterThan90: "Greater-than-90 log",
        exception: "Exception log",
        runState: "Run state"
      };
      files.innerHTML = "";
      for (const [key, href] of Object.entries(fileLinks)) {
        const item = document.createElement("div");
        item.className = "file";
        const isWorkbook = ["send", "doNotSend", "coursesAlreadyTaken"].includes(key);
        const isCsv = ["sendCsv", "doNotSendCsv"].includes(key);
        const iconClass = isWorkbook ? "excel" : "text";
        const iconText = isWorkbook ? "X" : isCsv ? "C" : "N";
        const iconLabel = isWorkbook ? "Excel workbook" : isCsv ? "Pipe-delimited CSV" : "Text log";
        item.innerHTML =
          '<span class="file-name"><span class="file-icon ' + iconClass + '" title="' + iconLabel + '" aria-label="' + iconLabel + '">' + iconText + '</span><span>' + (labels[key] || key) + '</span></span>' +
          '<span class="file-actions"><a href="' + href + '" target="_blank">View</a><a href="' + href + '?download=1">Download</a></span>';
        files.appendChild(item);
      }
    }

    function loadWorkbook(payload, message) {
      state.uploadId = payload.id;
      worksheet.innerHTML = '<option value="">All worksheets</option>';
      for (const name of payload.worksheets) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        worksheet.appendChild(option);
      }
      worksheet.disabled = false;
      runButton.disabled = false;
      uploadMeta.textContent = payload.originalName + " loaded. " + payload.worksheets.length + " worksheet(s) found.";
      setStatus(message);
    }

    async function restoreLatestRun() {
      try {
        const response = await fetch("/latest-run");
        const payload = await response.json();
        if (!response.ok || !payload.found) return;

        state.currentRunId = payload.id;
        if (payload.status === "running") {
          feed.innerHTML = "";
          files.innerHTML = "";
          bar.style.width = "0%";
          state.isRunning = true;
          state.stopRequested = false;
          setBusy(true);
          connect(payload.id);
          setStatus("Monitoring run " + payload.id + ".");
          return;
        }

        renderLatestRunSnapshot(payload);
      } catch {
        // The latest-run snapshot is best effort; the page should still load normally.
      }
    }

    function renderLatestRunSnapshot(payload) {
      const runState = payload.state || {};
      const counts = {
        eligible: Number(runState.eligible || 0),
        checked: Number(runState.checked || 0),
        send: Number(runState.send || 0),
        doNotSend: Number(runState.doNotSend || 0),
        errors: Number(runState.errors || 0),
        phase: runState.phase || payload.status,
        canceled: Boolean(runState.canceled),
        canResume: Boolean(runState.canResume),
        rateLimited: Boolean(runState.rateLimited),
        lastError: runState.lastError || ""
      };
      const percent = counts.eligible > 0
        ? Math.round((counts.checked / counts.eligible) * 100)
        : payload.status === "complete" ? 100 : 0;

      bar.style.width = Math.max(0, Math.min(100, percent)) + "%";
      progressMeta.textContent = latestRunMeta(payload.status, counts, payload.message);
      renderStageSnapshot(counts);
      feed.innerHTML = "";
      append("Latest run " + payload.id + " loaded from saved run state.");
      append(progressMeta.textContent);
      if (payload.message) append(payload.message);
      if (payload.files) renderFiles(payload.files);
      setStatus(payload.status === "complete" ? "Last run complete." : "Last run status: " + payload.status + ".");
    }

    function latestRunMeta(status, counts, message) {
      const parts = [
        "Status: " + status + ".",
        "Phase: " + (counts.phase || status) + ".",
        "Can resume: " + (counts.canResume ? "yes" : "no") + ".",
        "Checked " + counts.checked + " of " + eligibleLabel(counts) + " eligible license(s).",
        "Send: " + counts.send + ".",
        "Do-not-send: " + counts.doNotSend + ".",
        "Errors: " + counts.errors + "."
      ];
      if (counts.rateLimited) {
        parts.push("Washington rate limit detected. Use the Resume button on Previous Runs to continue later.");
      }
      if (counts.lastError) {
        parts.push("Last error: " + counts.lastError);
      }
      if (message) {
        parts.push("Last message: " + message);
      }
      return parts.join(" ");
    }

    function eligibleLabel(counts) {
      return counts.eligible > 0 || counts.checked === 0 ? String(counts.eligible) : "unknown";
    }

    function resetStages() {
      resetStageMetrics();
      setStage(stageImport, "pending", "Import", "Waiting for workbook.");
      setStage(stageLookup, "pending", "Website Lookup", "Waiting for queued work.");
      setStage(stageReports, "pending", "Reports", "Waiting for lookup results.");
    }

    function updateStageFlow(update) {
      updateStageMetrics(update);
      if (["import_started", "spreadsheet_loading", "worksheet_started", "spreadsheet_row"].includes(update.type)) {
        setStage(stageImport, "active", "Import", update.message);
        setStage(stageLookup, "pending", "Website Lookup", "Waiting for queued work.");
        setStage(stageReports, "pending", "Reports", "Waiting for lookup results.");
      } else if (["spreadsheet_complete", "import_complete"].includes(update.type)) {
        setStage(stageImport, "done", "Import", update.message);
        setStage(stageLookup, "pending", "Website Lookup", "Queued work is ready.");
      } else if (["lookup_started", "checks_started", "checks_progress", "website_check_retry", "website_check_error"].includes(update.type)) {
        setStage(stageImport, "done", "Import", "Queued work is ready.");
        setStage(stageLookup, update.type === "website_check_error" ? "active" : "active", "Website Lookup", update.message);
        setStage(stageReports, "pending", "Reports", "Waiting for lookup results.");
      } else if (update.type === "rate_limited" || update.type === "checks_canceled" || update.type === "run_canceled") {
        setStage(stageImport, "done", "Import", "Queued work is saved.");
        setStage(stageLookup, "error", "Website Lookup", update.message);
        setStage(stageReports, "pending", "Reports", "Partial reports may be available.");
      } else if (update.type === "checks_complete") {
        setStage(stageImport, "done", "Import", "Queued work is ready.");
        setStage(stageLookup, "done", "Website Lookup", update.message);
        setStage(stageReports, "pending", "Reports", "Waiting to generate files.");
      } else if (update.type === "reports_started") {
        setStage(stageImport, "done", "Import", "Queued work is ready.");
        setStage(stageLookup, "done", "Website Lookup", "Lookup results are saved.");
        setStage(stageReports, "active", "Reports", update.message);
      } else if (update.type === "reports_complete" || update.type === "run_complete") {
        setStage(stageImport, "done", "Import", "Queued work is ready.");
        setStage(stageLookup, "done", "Website Lookup", "Lookup results are saved.");
        setStage(stageReports, "done", "Reports", update.message);
      } else if (update.type === "run_error") {
        setStage(stageReports, "error", "Reports", update.message);
      }
    }

    function renderStageSnapshot(counts) {
      const phase = counts.phase || "";
      stageMetrics.importRows = counts.eligible;
      stageMetrics.queued = counts.eligible;
      stageMetrics.checked = counts.checked;
      stageMetrics.remaining = Math.max(0, counts.eligible - counts.checked);
      stageMetrics.send = counts.send;
      stageMetrics.doNotSend = counts.doNotSend;
      stageMetrics.errors = counts.errors;
      stageMetrics.lookupResults = counts.send + counts.doNotSend;
      if (phase === "complete") {
        setStage(stageImport, "done", "Import", "Queued work is ready.");
        setStage(stageLookup, "done", "Website Lookup", "Lookup results are saved.");
        setStage(stageReports, "done", "Reports", "Output files are ready.");
      } else if (phase === "canceled" || counts.rateLimited) {
        setStage(stageImport, "done", "Import", "Queued work is saved.");
        setStage(stageLookup, "error", "Website Lookup", counts.rateLimited ? "Washington rate limit detected." : "Run was stopped.");
        setStage(stageReports, counts.checked > 0 ? "done" : "pending", "Reports", counts.checked > 0 ? "Partial output files are ready." : "No lookup results yet.");
      } else if (phase === "writing_outputs") {
        setStage(stageImport, "done", "Import", "Queued work is ready.");
        setStage(stageLookup, "done", "Website Lookup", "Lookup results are saved.");
        setStage(stageReports, "active", "Reports", "Generating output files.");
      } else if (phase === "checking") {
        setStage(stageImport, "done", "Import", "Queued work is ready.");
        setStage(stageLookup, "active", "Website Lookup", "Checking Washington website.");
        setStage(stageReports, "pending", "Reports", "Waiting for lookup results.");
      } else if (phase === "queued") {
        setStage(stageImport, "done", "Import", "Queued work is ready.");
        setStage(stageLookup, "pending", "Website Lookup", "Waiting to start.");
        setStage(stageReports, "pending", "Reports", "Waiting for lookup results.");
      } else if (phase === "importing" || phase === "reading") {
        setStage(stageImport, "active", "Import", "Reading workbook.");
        setStage(stageLookup, "pending", "Website Lookup", "Waiting for queued work.");
        setStage(stageReports, "pending", "Reports", "Waiting for lookup results.");
      } else {
        resetStages();
      }
    }

    function setStage(element, stateName, title, detail) {
      element.className = "stage " + stateName;
      element.querySelector("strong").textContent = title;
      element.querySelector("span").textContent = detail || "";
      element.querySelector("small").textContent = metricsForStage(element);
    }

    function resetStageMetrics() {
      stageMetrics.importRows = 0;
      stageMetrics.queued = 0;
      stageMetrics.checked = 0;
      stageMetrics.remaining = 0;
      stageMetrics.send = 0;
      stageMetrics.doNotSend = 0;
      stageMetrics.errors = 0;
      stageMetrics.lookupResults = 0;
      stageMetrics.courses = 0;
    }

    function updateStageMetrics(update) {
      if (update.type === "spreadsheet_row") {
        stageMetrics.importRows = update.current || stageMetrics.importRows;
      }
      if (update.type === "spreadsheet_complete" || update.type === "import_complete") {
        stageMetrics.importRows = Math.max(stageMetrics.importRows, update.current || 0);
        stageMetrics.queued = update.queuedCount || update.total || update.current || stageMetrics.queued;
        stageMetrics.remaining = stageMetrics.queued;
      }
      if (update.type === "lookup_started" || update.type === "checks_started") {
        stageMetrics.queued = update.total || stageMetrics.queued;
        stageMetrics.remaining = update.remaining ?? stageMetrics.queued;
      }
      if (["checks_progress", "website_check_retry", "website_check_error", "rate_limited", "checks_canceled", "checks_complete"].includes(update.type)) {
        stageMetrics.checked = update.current ?? stageMetrics.checked;
        stageMetrics.remaining = update.remaining ?? Math.max(0, stageMetrics.queued - stageMetrics.checked);
        stageMetrics.errors = update.errorCount ?? stageMetrics.errors;
        stageMetrics.lookupResults = Math.max(stageMetrics.lookupResults, stageMetrics.checked - stageMetrics.errors);
      }
      if (update.type === "reports_complete") {
        stageMetrics.send = update.sendCount ?? stageMetrics.send;
        stageMetrics.doNotSend = update.doNotSendCount ?? stageMetrics.doNotSend;
        stageMetrics.lookupResults = update.lookupResultCount ?? stageMetrics.lookupResults;
        stageMetrics.courses = update.courseFrequencyCount ?? stageMetrics.courses;
      }
    }

    function metricsForStage(element) {
      if (element === stageImport) {
        return "Rows " + stageMetrics.importRows + " · Queued " + stageMetrics.queued;
      }
      if (element === stageLookup) {
        return "Checked " + stageMetrics.checked + " · Remaining " + stageMetrics.remaining + " · Errors " + stageMetrics.errors;
      }
      return "Results " + stageMetrics.lookupResults + " · Send " + stageMetrics.send + " · Do-not-send " + stageMetrics.doNotSend;
    }

    function append(message) {
      const line = document.createElement("div");
      line.textContent = new Date().toLocaleTimeString() + "  " + message;
      feed.appendChild(line);
      while (feed.children.length > maxFeedLines) {
        feed.removeChild(feed.firstElementChild);
      }
      if (state.isRunning && autoScroll.checked) {
        feed.scrollTop = feed.scrollHeight;
      }
    }

    function setBusy(isBusy) {
      uploadButton.disabled = isBusy;
      checkEmailButton.disabled = isBusy;
      runButton.disabled = isBusy || !state.uploadId;
      stopButton.disabled = !state.isRunning || state.stopRequested;
    }

    function setStatus(message) {
      status.textContent = message;
    }

    async function refreshEmailPollStatus() {
      try {
        const response = await fetch("/email-poll/status");
        const payload = await response.json();
        emailPollEnabled.textContent = payload.enabled
          ? "Enabled" + (payload.scheduledTime ? " at " + payload.scheduledTime : "")
          : "Disabled";
        emailPollLastChecked.textContent = formatDateTime(payload.lastCheckedAt) || "Never";
        emailPollLastResult.textContent = payload.lastResult || "No checks yet.";
        emailPollNextCheck.textContent = formatDateTime(payload.nextCheckAt) || "Not scheduled";
        if (payload.scheduledTime) emailPollTime.value = payload.scheduledTime;
        enableEmailPoll.disabled = payload.enabled;
        disableEmailPoll.disabled = !payload.enabled;
      } catch {
        emailPollEnabled.textContent = "Unavailable";
      }
    }

    async function setEmailPolling(path, body) {
      enableEmailPoll.disabled = true;
      disableEmailPoll.disabled = true;
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined
        });
        const payload = await response.json();
        if (!response.ok) {
          const message = payload.error || "Email polling update failed.";
          emailPollLastResult.textContent = message;
          setStatus(message);
        }
      } catch {
        setStatus("Email polling update failed.");
      }
      await refreshEmailPollStatus();
    }

    function formatDateTime(value) {
      return value ? new Date(value).toLocaleString() : "";
    }
  </script>
</body>
</html>`;
}

interface FileLink {
  href: string;
  label: string;
}

interface PreviousRunSummary {
  id: string;
  createdAt: string;
  files: Record<string, FileLink>;
  state?: PreviousRunStateSummary;
}

interface PreviousRunStateSummary {
  phase: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  eligible: number;
  checked: number;
  send: number;
  doNotSend: number;
  errors: number;
  canceled: boolean;
  canResume: boolean;
  rateLimited: boolean;
  lastLicenseNumber?: string;
  lastMessage?: string;
  lastError?: string;
  error?: string;
  resumeAfterLicenseNumber?: string;
  resumedFromRunId?: string;
  workerStatus?: WorkerStatus;
}

function runsHtml(runSummaries: PreviousRunSummary[]): string {
  const rows = groupedRunSummaries(runSummaries).map(runGroupHtml).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" href="/app-icon.png">
  <link rel="apple-touch-icon" href="/app-icon.png">
  <title>Previous Runs</title>
  <style>
    :root { color-scheme: light; --ink:#10233f; --muted:#5d6673; --line:#cfd8d3; --panel:#f4faf6; --accent:#005f3c; --accent-strong:#00345f; --danger:#b3261e; --gold:#f6be00; }
    body { margin:0; font-family: Arial, Helvetica, sans-serif; color:var(--ink); background:#fbfdfb; }
    header { border-bottom:1px solid var(--line); padding:14px 24px; display:flex; justify-content:space-between; align-items:center; gap:16px; background:#fff; box-shadow:0 1px 0 rgba(16,35,63,.04); }
    h1 { font-size:20px; margin:0; color:var(--accent-strong); }
    main { max-width:1100px; margin:0 auto; padding:20px 24px; }
    a { color:var(--accent-strong); font-weight:700; text-decoration:none; }
    .brand { display:flex; align-items:center; gap:12px; min-width:0; }
    .brand-icon { width:48px; height:48px; border-radius:10px; object-fit:cover; border:1px solid var(--line); background:#fff; box-shadow:0 2px 8px rgba(16,35,63,.12); flex:0 0 auto; }
    .run-group { border:1px solid var(--line); border-radius:6px; margin-bottom:14px; background:#fff; overflow:hidden; }
    .run-group-title { padding:12px 14px; border-bottom:1px solid var(--line); background:var(--panel); display:flex; justify-content:space-between; gap:12px; align-items:center; }
    .run-group-title h2 { margin:0; }
    .run-group-title p { text-align:right; }
    .run-group-meta { display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
    .combined-links { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; font-size:13px; }
    .run { padding:14px; display:flex; justify-content:space-between; gap:16px; align-items:center; background:#fff; }
    .run + .run { border-top:1px solid var(--line); }
    .run.resumed { padding-left:28px; border-left:4px solid var(--gold); }
    .run-details { min-width:260px; }
    h2 { font-size:16px; margin:0 0 4px; }
    h3 { font-size:15px; margin:0 0 4px; }
    p { margin:0; color:var(--muted); font-size:13px; }
    .run-state { margin-top:10px; display:flex; flex-wrap:wrap; gap:8px; color:var(--muted); font-size:12px; }
    .run-state span { border:1px solid var(--line); border-radius:999px; padding:4px 8px; background:var(--panel); }
    .run-message { margin-top:8px; max-width:620px; }
    .run-error { color:var(--danger); }
    button { border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--ink); font:inherit; font-weight:700; padding:8px 10px; cursor:pointer; }
    button:hover { background:var(--panel); border-color:var(--gold); }
    .resume-run { color:var(--accent-strong); }
    .pause-worker { color:var(--danger); }
    .clear-pause { color:var(--accent-strong); }
    .regenerate-run { color:var(--ok); }
    .delete-run { color:var(--danger); }
    .delete-run:disabled { cursor:not-allowed; opacity:.65; }
    .run-actions { display:flex; align-items:center; justify-content:flex-end; gap:14px; }
    .links { display:flex; flex-wrap:wrap; gap:10px; justify-content:flex-end; }
    .empty { color:var(--muted); border:1px solid var(--line); border-radius:6px; padding:18px; background:#fff; }
    @media (max-width: 760px) { .run-group-title { display:block; } .run-group-title p { text-align:left; margin-top:4px; } .run-group-meta { align-items:flex-start; margin-top:8px; } .combined-links { justify-content:flex-start; } .run { display:block; } .run.resumed { padding-left:14px; } .run-actions { align-items:flex-start; flex-direction:column; margin-top:12px; } .links { justify-content:flex-start; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <img class="brand-icon" src="/app-icon.png" alt="" aria-hidden="true">
      <h1>Previous Runs</h1>
    </div>
    <a href="/">New Run</a>
  </header>
  <main>
    ${rows || '<div class="empty">No completed runs found yet.</div>'}
  </main>
  <script>
    document.querySelectorAll(".resume-run").forEach((button) => {
      button.addEventListener("click", async () => {
        const runId = button.dataset.runId;
        if (!runId) return;
        if (!confirm("Resume run " + runId + " in a new run folder?")) return;

        button.disabled = true;
        button.textContent = "Resuming...";

        try {
          const response = await fetch("/runs/" + encodeURIComponent(runId) + "/resume", { method: "POST" });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "Could not resume run.");
          }
          window.location.href = "/?runId=" + encodeURIComponent(result.runId);
        } catch (error) {
          alert(error instanceof Error ? error.message : String(error));
          button.disabled = false;
          button.textContent = "Resume";
        }
      });
    });

    document.querySelectorAll(".regenerate-run").forEach((button) => {
      button.addEventListener("click", async () => {
        const runId = button.dataset.runId;
        if (!runId) return;
        if (!confirm("Regenerate report files for run " + runId + " from stored lookup results? This will not contact Washington.")) return;

        button.disabled = true;
        button.textContent = "Regenerating...";

        try {
          const response = await fetch("/runs/" + encodeURIComponent(runId) + "/regenerate-reports", { method: "POST" });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "Could not regenerate reports.");
          }
          window.location.reload();
        } catch (error) {
          alert(error instanceof Error ? error.message : String(error));
          button.disabled = false;
          button.textContent = "Regenerate Reports";
        }
      });
    });

    document.querySelectorAll(".pause-worker, .clear-pause").forEach((button) => {
      button.addEventListener("click", async () => {
        const runId = button.dataset.runId;
        const action = button.dataset.action;
        if (!runId || !action) return;

        const label = button.textContent;
        button.disabled = true;
        button.textContent = action === "pause" ? "Pausing..." : "Clearing...";

        try {
          const response = await fetch("/runs/" + encodeURIComponent(runId) + "/worker/" + action, { method: "POST" });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "Could not update worker control.");
          }
          window.location.reload();
        } catch (error) {
          alert(error instanceof Error ? error.message : String(error));
          button.disabled = false;
          button.textContent = label;
        }
      });
    });

    document.querySelectorAll(".delete-run").forEach((button) => {
      button.addEventListener("click", async () => {
        const runId = button.dataset.runId;
        if (!runId) return;
        if (!confirm("Delete run " + runId + " and remove its folder from disk?")) return;

        button.disabled = true;
        button.textContent = "Deleting...";

        try {
          const response = await fetch("/runs/" + encodeURIComponent(runId) + "/delete", { method: "POST" });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "Could not delete run.");
          }

          const group = button.closest(".run-group");
          button.closest(".run")?.remove();
          if (group && !group.querySelector(".run")) {
            group.remove();
          }
          if (!document.querySelector(".run-group")) {
            document.querySelector("main").innerHTML = '<div class="empty">No completed runs found yet.</div>';
          }
        } catch (error) {
          alert(error instanceof Error ? error.message : String(error));
          button.disabled = false;
          button.textContent = "Delete";
        }
      });
    });
  </script>
</body>
</html>`;
}

interface PreviousRunGroup {
  root: PreviousRunSummary;
  resumedRuns: PreviousRunSummary[];
}

function groupedRunSummaries(runSummaries: PreviousRunSummary[]): PreviousRunGroup[] {
  const byId = new Map(runSummaries.map((run) => [run.id, run]));
  const resumedRunsByRoot = new Map<string, PreviousRunSummary[]>();
  const rootRuns = new Map<string, PreviousRunSummary>();

  for (const run of runSummaries) {
    const root = rootRunFor(run, byId);
    rootRuns.set(root.id, root);

    if (run.id !== root.id) {
      const resumedRuns = resumedRunsByRoot.get(root.id) ?? [];
      resumedRuns.push(run);
      resumedRunsByRoot.set(root.id, resumedRuns);
    }
  }

  return [...rootRuns.values()]
    .map((run) => ({
      root: run,
      resumedRuns: (resumedRunsByRoot.get(run.id) ?? []).sort(compareRunAscending)
    }))
    .sort((a, b) => compareRunDescending(latestRunInGroup(a), latestRunInGroup(b)));
}

function rootRunFor(run: PreviousRunSummary, byId: Map<string, PreviousRunSummary>): PreviousRunSummary {
  let current = run;
  const seen = new Set<string>();

  while (current.state?.resumedFromRunId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.state.resumedFromRunId);
    if (!parent) break;
    current = parent;
  }

  return current;
}

function latestRunInGroup(group: PreviousRunGroup): PreviousRunSummary {
  return [group.root, ...group.resumedRuns].sort(compareRunDescending)[0];
}

function compareRunDescending(a: PreviousRunSummary, b: PreviousRunSummary): number {
  return b.id.localeCompare(a.id);
}

function compareRunAscending(a: PreviousRunSummary, b: PreviousRunSummary): number {
  return a.id.localeCompare(b.id);
}

function runGroupHtml(group: PreviousRunGroup): string {
  const totalRuns = 1 + group.resumedRuns.length;
  const resumeText = totalRuns === 1 ? "Single run" : `${totalRuns} linked run(s)`;

  return `
    <section class="run-group">
      <div class="run-group-title">
        <div>
          <h2>${escapeHtml(group.root.id)}</h2>
          <p>Created ${escapeHtml(group.root.createdAt)}</p>
        </div>
        <div class="run-group-meta">
          <p>${escapeHtml(resumeText)}</p>
          ${combinedRunLinks(group)}
        </div>
      </div>
      ${runHtml(group.root)}
      ${group.resumedRuns.map((run) => runHtml(run, true)).join("")}
    </section>
  `;
}

function combinedRunLinks(group: PreviousRunGroup): string {
  if (group.resumedRuns.length === 0) return "";

  return `
    <div class="combined-links">
      <a href="/runs/${encodeURIComponent(group.root.id)}/combined/send">Combined Send.xlsx</a>
      <a href="/runs/${encodeURIComponent(group.root.id)}/combined/doNotSend">Combined DoNotSend.xlsx</a>
    </div>
  `;
}

function runIdsInGroup(group: PreviousRunGroup): string[] {
  return [group.root, ...group.resumedRuns].map((run) => run.id);
}

function runHtml(run: PreviousRunSummary, isResumed = false): string {
  const title = isResumed ? `Resumed run ${run.id}` : run.id;

  return `
    <section class="run${isResumed ? " resumed" : ""}" data-run="${escapeHtml(run.id)}">
      <div class="run-details">
        <h3>${escapeHtml(title)}</h3>
        <p>${isResumed ? resumeRelationshipText(run) : `Created ${escapeHtml(run.createdAt)}`}</p>
        ${runStateSummary(run.state)}
      </div>
      <div class="run-actions">
        <div class="links">
          ${runFileLink(run.files.send)}
          ${runFileLink(run.files.doNotSend)}
          ${runFileLink(run.files.sendCsv)}
          ${runFileLink(run.files.doNotSendCsv)}
          ${runFileLink(run.files.coursesAlreadyTaken)}
          ${runFileLink(run.files.workItems)}
          ${runFileLink(run.files.lookupResults)}
          ${runFileLink(run.files.courseFrequenciesJson)}
          ${runFileLink(run.files.workerStatus)}
          ${runFileLink(run.files.workerControl)}
          ${runFileLink(run.files.expired)}
          ${runFileLink(run.files.greaterThan90)}
          ${runFileLink(run.files.exception)}
          ${runFileLink(run.files.runState)}
        </div>
        ${regenerateRunButton(run)}
        ${workerControlButtons(run)}
        ${resumeRunButton(run)}
        <button type="button" class="delete-run" data-run-id="${escapeHtml(run.id)}">Delete</button>
      </div>
    </section>
  `;
}

function resumeRelationshipText(run: PreviousRunSummary): string {
  const parent = run.state?.resumedFromRunId ? `Resumed from ${run.state.resumedFromRunId}` : `Created ${run.createdAt}`;
  const checkpoint = run.state?.resumeAfterLicenseNumber ? ` after ${run.state.resumeAfterLicenseNumber}` : "";
  return escapeHtml(`${parent}${checkpoint}`);
}

function resumeRunButton(run: PreviousRunSummary): string {
  if (!run.state?.canResume || !run.state.lastLicenseNumber || run.state.phase === "complete") return "";
  return `<button type="button" class="resume-run" data-run-id="${escapeHtml(run.id)}">Resume</button>`;
}

function regenerateRunButton(run: PreviousRunSummary): string {
  if (!run.files.lookupResults) return "";
  return `<button type="button" class="regenerate-run" data-run-id="${escapeHtml(run.id)}">Regenerate Reports</button>`;
}

function workerControlButtons(run: PreviousRunSummary): string {
  if (!run.files.workerControl) return "";
  const status = run.state?.workerStatus?.status;
  const pauseButton = status === "queued" || status === "running"
    ? `<button type="button" class="pause-worker" data-action="pause" data-run-id="${escapeHtml(run.id)}">Pause Worker</button>`
    : "";
  const clearPauseButton = status === "paused" || status === "rate_limited"
    ? `<button type="button" class="clear-pause" data-action="resume" data-run-id="${escapeHtml(run.id)}">Clear Pause</button>`
    : "";
  return `${pauseButton}${clearPauseButton}`;
}

function runStateSummary(state: PreviousRunStateSummary | undefined): string {
  if (!state) return "";

  const finishedAt = state.completedAt ? `<span>Finished: ${escapeHtml(state.completedAt)}</span>` : "";
  const lastLicense = state.lastLicenseNumber ? `<span>Last license: ${escapeHtml(state.lastLicenseNumber)}</span>` : "";
  const message = state.error || state.lastError || state.lastMessage;
  const resumeHint = state.canResume ? `<p class="run-message">This run can be resumed. Click Resume to continue from the last checked license.</p>` : "";
  const eligible = state.eligible > 0 || state.checked === 0 ? String(state.eligible) : "unknown";
  const worker = state.workerStatus;
  const workerFinished = worker?.completedAt ? `<span>Worker finished: ${escapeHtml(formatDateTime(worker.completedAt))}</span>` : "";
  const workerHeartbeat = worker?.heartbeatAt ? `<span>Worker heartbeat: ${escapeHtml(formatDateTime(worker.heartbeatAt))}</span>` : "";

  return `
    <div class="run-state">
      <span>Phase: ${escapeHtml(state.phase)}</span>
      ${worker ? `<span>Worker: ${escapeHtml(worker.status)}</span>` : ""}
      <span>Canceled: ${state.canceled ? "yes" : "no"}</span>
      <span>Can resume: ${state.canResume ? "yes" : "no"}</span>
      ${state.rateLimited ? "<span>Rate limited: yes</span>" : ""}
      <span>Eligible: ${eligible}</span>
      <span>Checked: ${state.checked}</span>
      <span>Send: ${state.send}</span>
      <span>Do not send: ${state.doNotSend}</span>
      <span>Errors: ${state.errors}</span>
      ${worker ? `<span>Worker remaining: ${worker.remaining}</span>` : ""}
      ${worker ? `<span>Worker errors: ${worker.errors}</span>` : ""}
      ${lastLicense}
      ${workerHeartbeat}
      ${workerFinished}
      ${finishedAt}
    </div>
    ${message ? `<p class="run-message${state.error ? " run-error" : ""}">${escapeHtml(message)}</p>` : ""}
    ${resumeHint}
  `;
}

function runFileLink(file: FileLink | undefined): string {
  return file ? `<a href="${file.href}">${escapeHtml(file.label)}</a>` : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
