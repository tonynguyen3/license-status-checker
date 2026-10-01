import { createReadStream } from "node:fs";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, resolve } from "node:path";
import { loadEnvFile } from "./env.js";
import { findInputWorkbookEmail, imapConfigured } from "./imap-input.js";
import { pageHtml, runsHtml } from "./web-pages.js";
import { WebRunManager, writeSseEvent } from "./web-runs.js";

loadEnvFile();

const port = Number(process.env.PORT ?? 3000);
const rootDir = resolve("Files", "web-runs");
const emailPollLogPath = resolve("Files", "email-poll.log");
const appIconPath = resolve("docs", "license-status-checker-icon.png");
const webRuns = new WebRunManager(rootDir);
const emailPollState: EmailPollStatus = {
  enabled: false,
  running: false,
  logPath: emailPollLogPath
};
let emailPollTimer: ReturnType<typeof setTimeout> | undefined;

interface EmailPollConfig {
  enabled: boolean;
  time?: string;
  worksheet?: string;
  headed: boolean;
  checkDelayMs: number;
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

  const uploaded = await webRuns.saveUploadedWorkbook(file.filename, file.data);
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

  const uploaded = await webRuns.saveUploadedWorkbook(workbook.filename, workbook.content);
  sendJson(response, 200, {
    ...uploaded,
    email: {
      from: workbook.from,
      subject: workbook.subject,
      messageId: workbook.messageId
    }
  });
}

async function handleRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = JSON.parse((await readRequestBody(request)).toString("utf8")) as {
    uploadId?: string;
    worksheet?: string;
    limit?: number;
    headed?: boolean;
    checkDelaySeconds?: number;
  };

  const upload = webRuns.getUpload(body.uploadId);
  if (!upload) {
    sendJson(response, 400, { error: "Upload a workbook before starting a run." });
    return;
  }

  const run = webRuns.startRun(upload, {
    worksheet: body.worksheet || undefined,
    headed: body.headed === true,
    checkDelayMs:
      Number.isFinite(body.checkDelaySeconds) && body.checkDelaySeconds !== undefined && body.checkDelaySeconds >= 0
        ? Math.round(body.checkDelaySeconds * 1000)
        : 3000,
    limit: Number.isFinite(body.limit) && body.limit && body.limit > 0 ? body.limit : undefined
  }, requestBaseUrl(request));

  sendJson(response, 200, { runId: run.id });
}

function handleCancel(runId: string, response: ServerResponse): void {
  const result = webRuns.cancelRun(runId);
  if (!result.found) {
    sendJson(response, 404, { error: "Run not found" });
    return;
  }

  sendJson(response, 200, { status: result.status });
}

function handleEvents(runId: string, response: ServerResponse): void {
  if (!webRuns.hasRun(runId)) {
    sendJson(response, 404, { error: "Run not found" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  webRuns.connectEvents(runId, response, writeSseEvent);
}

async function handleFile(runId: string, fileKey: string, response: ServerResponse, download: boolean): Promise<void> {
  const outputPaths = await webRuns.outputPathsForRun(runId);
  if (!outputPaths) {
    sendJson(response, 404, { error: "Run output is not available yet." });
    return;
  }

  const path = webRuns.pathForFileKey(outputPaths, fileKey);
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

  const isText = extname(path).toLowerCase() === ".txt";
  response.writeHead(200, {
    "Content-Type": isText ? "text/plain; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${basename(path)}"`
  });
  createReadStream(path).pipe(response);
}

async function handleDeleteRun(runId: string, response: ServerResponse): Promise<void> {
  const result = await webRuns.deleteRun(runId);
  if (result === "running") {
    sendJson(response, 409, { error: "Cannot delete a run while it is still running. Stop the run first." });
    return;
  }
  if (result === "invalid") {
    sendJson(response, 400, { error: "Invalid run id." });
    return;
  }
  if (result === "missing") {
    sendJson(response, 404, { error: "Run folder not found." });
    return;
  }

  sendJson(response, 200, { deleted: true, runId });
}

async function handleRunsPage(response: ServerResponse): Promise<void> {
  const runSummaries = await webRuns.listPreviousRuns();
  sendHtml(response, runsHtml(runSummaries));
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
    if (webRuns.activeRunExists()) {
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

    const uploaded = await webRuns.saveUploadedWorkbook(workbook.filename, workbook.content);
    const run = webRuns.startRun(
      uploaded,
      {
        worksheet: config.worksheet,
        headed: config.headed,
        checkDelayMs: config.checkDelayMs,
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
  const checkDelayMs = Number(process.env.EMAIL_POLL_CHECK_DELAY_MS ?? 3000);

  return {
    enabled,
    time,
    worksheet: process.env.EMAIL_POLL_WORKSHEET || undefined,
    headed: parseBoolean(process.env.EMAIL_POLL_HEADED),
    checkDelayMs: Number.isFinite(checkDelayMs) && checkDelayMs >= 0 ? checkDelayMs : 3000,
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

async function logEmailPoll(message: string): Promise<void> {
  await mkdir(dirname(emailPollLogPath), { recursive: true });
  const line = `${new Date().toLocaleString()} ${message}\n`;
  await appendFile(emailPollLogPath, line, "utf8");
  console.log(`[email-poll] ${message}`);
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}
