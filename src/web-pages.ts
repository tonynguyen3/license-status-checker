export function pageHtml(): string {
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
    @media (max-width: 760px) { main { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } }
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
          <input id="checkDelay" type="number" min="0" step="0.5" value="3">
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

    function connect(runId) {
      closeProgressStream();
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
        coursesAlreadyTaken: "Course frequency workbook",
        expired: "Expired log",
        greaterThan90: "Greater-than-90 log",
        exception: "Exception log",
        timings: "Timing log"
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

export interface FileLink {
  href: string;
  label: string;
}

export function runsHtml(runSummaries: Array<{ id: string; createdAt: string; files: Record<string, FileLink> }>): string {
  const rows = runSummaries.map((run) => `
    <section class="run" data-run="${escapeHtml(run.id)}">
      <div>
        <h2>${escapeHtml(run.id)}</h2>
        <p>${escapeHtml(run.createdAt)}</p>
      </div>
      <div class="run-actions">
        <div class="links">
          ${runFileLink(run.files.send)}
          ${runFileLink(run.files.doNotSend)}
          ${runFileLink(run.files.coursesAlreadyTaken)}
          ${runFileLink(run.files.expired)}
          ${runFileLink(run.files.greaterThan90)}
          ${runFileLink(run.files.exception)}
          ${runFileLink(run.files.timings)}
        </div>
        <button type="button" class="delete-run" data-run-id="${escapeHtml(run.id)}">Delete</button>
      </div>
    </section>
  `).join("");

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
    .run { border:1px solid var(--line); border-radius:6px; padding:14px; margin-bottom:12px; display:flex; justify-content:space-between; gap:16px; align-items:center; background:#fff; }
    h2 { font-size:16px; margin:0 0 4px; }
    p { margin:0; color:var(--muted); font-size:13px; }
    button { border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--ink); font:inherit; font-weight:700; padding:8px 10px; cursor:pointer; }
    button:hover { background:var(--panel); border-color:var(--gold); }
    .delete-run { color:var(--danger); }
    .delete-run:disabled { cursor:not-allowed; opacity:.65; }
    .run-actions { display:flex; align-items:center; justify-content:flex-end; gap:14px; }
    .links { display:flex; flex-wrap:wrap; gap:10px; justify-content:flex-end; }
    .empty { color:var(--muted); border:1px solid var(--line); border-radius:6px; padding:18px; background:#fff; }
    @media (max-width: 760px) { .run { display:block; } .run-actions { align-items:flex-start; flex-direction:column; margin-top:12px; } .links { justify-content:flex-start; } }
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

          button.closest(".run")?.remove();
          if (!document.querySelector(".run")) {
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
