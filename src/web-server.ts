import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import ExcelJS from "exceljs";
import { runWashingtonCheck } from "./runner.js";
import type { OutputPaths, ProgressUpdate } from "./types.js";

const port = Number(process.env.PORT ?? 3000);
const rootDir = resolve("Files", "web-runs");
const uploads = new Map<string, UploadedWorkbook>();
const runs = new Map<string, WebRun>();

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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, pageHtml());
      return;
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      await handleUpload(request, response);
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

  const uploadId = createId();
  const uploadDir = join(rootDir, uploadId);
  const inputPath = join(uploadDir, "ListToCheck.xlsx");
  await mkdir(uploadDir, { recursive: true });
  await writeFile(inputPath, file.data);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const uploaded: UploadedWorkbook = {
    id: uploadId,
    path: inputPath,
    originalName: file.filename,
    worksheets: workbook.worksheets.map((worksheet) => worksheet.name)
  };
  uploads.set(uploadId, uploaded);

  sendJson(response, 200, uploaded);
}

async function handleRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = JSON.parse((await readRequestBody(request)).toString("utf8")) as {
    uploadId?: string;
    worksheet?: string;
    limit?: number;
    headed?: boolean;
  };

  const upload = body.uploadId ? uploads.get(body.uploadId) : undefined;
  if (!upload) {
    sendJson(response, 400, { error: "Upload a workbook before starting a run." });
    return;
  }

  const runId = createId();
  const outputDir = join(dirname(upload.path), "output");
  const run: WebRun = {
    id: runId,
    status: "running",
    outputDir,
    events: [],
    clients: new Set(),
    cancelRequested: false
  };
  runs.set(runId, run);

  void runWashingtonCheck({
    input: upload.path,
    outDir: outputDir,
    worksheet: body.worksheet || undefined,
    headed: body.headed === true,
    slowMo: 0,
    limit: Number.isFinite(body.limit) && body.limit && body.limit > 0 ? body.limit : undefined,
    onProgress: (update) => emit(run, update),
    isCanceled: () => run.cancelRequested
  })
    .then((result) => {
      run.status = result.canceled ? "canceled" : "complete";
      run.outputPaths = result.outputPaths;
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
    });

  sendJson(response, 200, { runId });
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
  const run = runs.get(runId);
  const outputPaths = run?.outputPaths;
  if (!run || !outputPaths) {
    sendJson(response, 404, { error: "Run output is not available yet." });
    return;
  }

  const path = pathForFileKey(outputPaths, fileKey);
  if (!path) {
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
    coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath,
    expired: outputPaths.expiredLogPath,
    greaterThan90: outputPaths.greaterThan90LogPath,
    exception: outputPaths.exceptionLogPath
  };
  return files[fileKey];
}

function fileLinks(runId: string, outputPaths: OutputPaths): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      send: outputPaths.sendPath,
      doNotSend: outputPaths.doNotSendPath,
      coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath,
      expired: outputPaths.expiredLogPath,
      greaterThan90: outputPaths.greaterThan90LogPath,
      exception: outputPaths.exceptionLogPath
    }).map(([key]) => [key, `/runs/${runId}/files/${key}`])
  );
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>License Status Checker</title>
  <style>
    :root { color-scheme: light; --ink:#202124; --muted:#5f6368; --line:#dadce0; --panel:#f8fafd; --accent:#0b57d0; --ok:#137333; --warn:#b06000; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, Helvetica, sans-serif; color:var(--ink); background:#fff; }
    header { border-bottom:1px solid var(--line); padding:18px 24px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
    h1 { font-size:20px; margin:0; font-weight:700; }
    main { display:grid; grid-template-columns: 360px 1fr; min-height:calc(100vh - 65px); }
    aside { border-right:1px solid var(--line); padding:20px; background:var(--panel); }
    section { padding:20px 24px; }
    label { display:block; font-size:13px; font-weight:700; margin:18px 0 6px; }
    input, select { width:100%; min-height:38px; border:1px solid var(--line); border-radius:6px; padding:8px 10px; font-size:14px; background:#fff; }
    input[type="checkbox"] { width:auto; min-height:auto; }
    button { min-height:38px; border:0; border-radius:6px; padding:8px 12px; font-size:14px; font-weight:700; background:var(--accent); color:#fff; cursor:pointer; }
    button.danger { background:#b3261e; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .row { display:flex; align-items:center; gap:8px; }
    .toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:18px; }
    .toolbar h2 { margin:0; }
    .toolbar label { margin:0; font-weight:400; }
    .stack { display:grid; gap:12px; }
    .meta { color:var(--muted); font-size:13px; line-height:1.4; }
    .progress { margin:0 0 18px; border:1px solid var(--line); border-radius:6px; overflow:hidden; height:18px; background:#f1f3f4; }
    .bar { height:100%; width:0%; background:var(--ok); transition:width .2s ease; }
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
    .file a { color:var(--accent); font-weight:700; text-decoration:none; }
    @media (max-width: 760px) { main { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } }
  </style>
</head>
<body>
  <header>
    <h1>License Status Checker</h1>
    <div class="meta" id="status">Upload a workbook to begin.</div>
  </header>
  <main>
    <aside>
      <div class="stack">
        <div>
          <label for="file">Input workbook</label>
          <input id="file" type="file" accept=".xlsx">
        </div>
        <button id="upload">Upload Input File</button>
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
        <label class="row"><input id="headed" type="checkbox"> Show browser window</label>
        <button id="run" disabled>Run Check</button>
        <button id="stop" class="danger" disabled>Stop Run</button>
      </div>
    </aside>
    <section>
      <div class="progress"><div class="bar" id="bar"></div></div>
      <div class="meta" id="progressMeta">No run started.</div>
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
    const maxFeedLines = 500;
    const fileInput = document.getElementById("file");
    const uploadButton = document.getElementById("upload");
    const runButton = document.getElementById("run");
    const stopButton = document.getElementById("stop");
    const worksheet = document.getElementById("worksheet");
    const limit = document.getElementById("limit");
    const headed = document.getElementById("headed");
    const feed = document.getElementById("feed");
    const files = document.getElementById("files");
    const status = document.getElementById("status");
    const uploadMeta = document.getElementById("uploadMeta");
    const bar = document.getElementById("bar");
    const progressMeta = document.getElementById("progressMeta");
    const autoScroll = document.getElementById("autoScroll");

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
      uploadMeta.textContent = payload.originalName + " uploaded. " + payload.worksheets.length + " worksheet(s) found.";
      setStatus("Workbook uploaded.");
    });

    runButton.addEventListener("click", async () => {
      if (!state.uploadId) return setStatus("Upload a workbook first.");
      feed.innerHTML = "";
      files.innerHTML = "";
      bar.style.width = "0%";
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

    function connect(runId) {
      if (state.eventSource) state.eventSource.close();
      state.eventSource = new EventSource("/runs/" + runId + "/events");
      state.eventSource.onmessage = (event) => {
        const update = JSON.parse(event.data);
        append(update.message);
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
          state.isRunning = false;
          state.currentRunId = null;
          state.stopRequested = false;
          setBusy(false);
          setStatus(update.type === "run_canceled" ? "Run stopped." : "Run complete.");
        }
        if (update.type === "run_error") {
          state.isRunning = false;
          state.currentRunId = null;
          state.stopRequested = false;
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
        setBusy(false);
      };
    }

    function renderFiles(fileLinks) {
      const labels = {
        send: "Send workbook",
        doNotSend: "Do-not-send workbook",
        coursesAlreadyTaken: "Course frequency workbook",
        expired: "Expired log",
        greaterThan90: "Greater-than-90 log",
        exception: "Exception log"
      };
      files.innerHTML = "";
      for (const [key, href] of Object.entries(fileLinks)) {
        const item = document.createElement("div");
        item.className = "file";
        const isWorkbook = ["send", "doNotSend", "coursesAlreadyTaken"].includes(key);
        const iconClass = isWorkbook ? "excel" : "text";
        const iconText = isWorkbook ? "X" : "N";
        const iconLabel = isWorkbook ? "Excel workbook" : "Text log";
        item.innerHTML =
          '<span class="file-name"><span class="file-icon ' + iconClass + '" title="' + iconLabel + '" aria-label="' + iconLabel + '">' + iconText + '</span><span>' + (labels[key] || key) + '</span></span>' +
          '<span class="file-actions"><a href="' + href + '" target="_blank">View</a><a href="' + href + '?download=1">Download</a></span>';
        files.appendChild(item);
      }
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
      runButton.disabled = isBusy || !state.uploadId;
      stopButton.disabled = !state.isRunning || state.stopRequested;
    }

    function setStatus(message) {
      status.textContent = message;
    }
  </script>
</body>
</html>`;
}
