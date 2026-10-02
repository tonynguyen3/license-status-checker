import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { loadEnvFile } from "./env.js";
import { findInputWorkbookEmail, imapConfigured } from "./imap-input.js";
import { EmailPollScheduler } from "./web-email-poll.js";
import { parseMultipartFile, readRequestBody, sendFile, sendHtml, sendJson, sendText } from "./web-http.js";
import { mainPageScript, mainPageStyles } from "./web-main-page-assets.js";
import { guideHtml } from "./web-guide-page.js";
import { pageHtml } from "./web-pages.js";
import { WebRunManager, writeSseEvent } from "./web-runs.js";
import { runsHtml } from "./web-runs-page.js";

loadEnvFile();

const port = Number(process.env.PORT ?? 3001);
const rootDir = resolve("Files", "web-runs");
const emailPollLogPath = resolve("Files", "email-poll.log");
const appIconPath = resolve("docs", "license-status-checker-icon.png");
const webRunRetentionCount = parseRetentionCount(process.env.WEB_RUN_RETENTION_COUNT ?? process.env.WEB_RUN_RETENTION_DAYS);
const webRuns = new WebRunManager(rootDir);
const emailPoll = new EmailPollScheduler({ logPath: emailPollLogPath, port, webRuns });

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, pageHtml());
      return;
    }

    if (request.method === "GET" && url.pathname === "/guide") {
      sendHtml(response, guideHtml());
      return;
    }

    if (request.method === "GET" && url.pathname === "/assets/main.css") {
      sendText(response, 200, "text/css; charset=utf-8", mainPageStyles());
      return;
    }

    if (request.method === "GET" && url.pathname === "/assets/main.js") {
      sendText(response, 200, "application/javascript; charset=utf-8", mainPageScript());
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
      sendJson(response, 200, emailPoll.status());
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
  console.log("Running AutomateCE License Status Checker");
  console.log(`Web interface running at http://localhost:${port}`);
  startWebRunPurgeScheduler();
  emailPoll.startFromEnvironment();
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
  await sendFile(response, path, {
    contentType: isText ? "text/plain; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    disposition: download ? "attachment" : "inline"
  });
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
  const config = emailPoll.config();
  config.enabled = true;
  config.time = body.time?.trim() || config.time;
  const result = await emailPoll.enable(config);
  sendJson(response, result.ok ? 200 : 400, result.ok ? emailPoll.status() : { error: result.error, status: emailPoll.status() });
}

async function handleDisableEmailPoll(response: ServerResponse): Promise<void> {
  await emailPoll.disable("Scheduled email polling disabled from the web UI.");
  sendJson(response, 200, emailPoll.status());
}

async function sendPngFile(response: ServerResponse, path: string): Promise<void> {
  const sent = await sendFile(response, path, {
    contentType: "image/png",
    cacheControl: "public, max-age=3600"
  });
  if (!sent) {
    sendJson(response, 404, { error: "File not found." });
  }
}

function requestBaseUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? `localhost:${port}`;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return `${proto ?? "http"}://${host}`;
}

function startWebRunPurgeScheduler(): void {
  void purgeOldWebRuns();
  setInterval(() => {
    void purgeOldWebRuns();
  }, 24 * 60 * 60 * 1000);
}

async function purgeOldWebRuns(): Promise<void> {
  try {
    const result = await webRuns.purgeOldRuns(webRunRetentionCount);
    if (result.deleted.length > 0) {
      console.log(`[web-runs] Purged ${result.deleted.length} old run folder(s), keeping ${webRunRetentionCount}: ${result.deleted.join(", ")}`);
    } else {
      console.log(`[web-runs] No old run folders to purge; keeping up to ${webRunRetentionCount}.`);
    }
  } catch (error) {
    console.error(`[web-runs] Could not purge old run folders: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseRetentionCount(value: string | undefined): number {
  const parsed = Number(value ?? 20);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
}
