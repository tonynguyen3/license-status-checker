export function mainPageStyles(): string {
  return `
    :root { color-scheme: light; --ink:#10233f; --muted:#5d6673; --line:#cfd8d3; --panel:#f4faf6; --accent:#005f3c; --accent-strong:#00345f; --ok:#0b6f43; --warn:#d19300; --danger:#b3261e; --gold:#f6be00; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, Helvetica, sans-serif; font-size:17px; color:var(--ink); background:#fbfdfb; }
    header { border-bottom:1px solid var(--line); padding:16px 24px; display:flex; align-items:center; justify-content:space-between; gap:16px; background:#fff; box-shadow:0 1px 0 rgba(16,35,63,.04); }
    h1 { font-size:28px; margin:0; font-weight:700; color:var(--accent-strong); }
    .brand { display:flex; align-items:center; gap:12px; min-width:0; }
    .brand-icon { width:48px; height:48px; border-radius:10px; object-fit:cover; border:1px solid var(--line); background:#fff; box-shadow:0 2px 8px rgba(16,35,63,.12); flex:0 0 auto; }
    .header-button { display:inline-block; margin-right:10px; border-radius:6px; padding:8px 12px; background:var(--accent); color:#fff !important; }
    main { display:grid; grid-template-columns: 430px 1fr; min-height:calc(100vh - 73px); }
    aside { border-right:1px solid var(--line); padding:20px; background:var(--panel); }
    section { padding:20px 24px; }
    label { display:block; font-size:17px; font-weight:700; margin:20px 0 8px; }
    input, select { width:100%; min-height:48px; border:1px solid var(--line); border-radius:6px; padding:10px 12px; font-size:18px; background:#fff; color:var(--ink); }
    input:focus, select:focus { outline:2px solid rgba(246,190,0,.45); border-color:var(--accent); }
    input[type="checkbox"] { width:auto; min-height:auto; }
    button { min-height:48px; border:0; border-radius:6px; padding:10px 14px; font-size:18px; font-weight:700; background:var(--accent); color:#fff; cursor:pointer; }
    button:hover:not(:disabled) { background:var(--accent-strong); }
    button.danger { background:var(--danger); }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .row { display:flex; align-items:center; gap:8px; }
    .toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:8px 0 12px; }
    .toolbar h2 { margin:0; }
    .toolbar label { margin:0; font-weight:400; }
    .stack { display:grid; gap:12px; }
    .workflow { display:grid; align-content:start; gap:14px; }
    .stage { border:1px solid var(--line); border-radius:6px; padding:16px; background:#fff; box-shadow:0 1px 0 rgba(16,35,63,.03); }
    .stage-header { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
    .stage-number { width:34px; height:34px; border-radius:50%; display:grid; place-items:center; flex:0 0 auto; background:var(--accent); color:#fff; font-size:18px; font-weight:700; }
    .stage-title { min-width:0; }
    .stage-title h2 { margin:0; font-size:22px; color:var(--accent-strong); }
    .stage-title p { margin:2px 0 0; color:var(--muted); font-size:17px; line-height:1.35; }
    .stage-body { display:grid; gap:12px; }
    .stage-body label:first-child { margin-top:0; }
    .stage-body button { width:100%; }
    .inline-buttons { display:flex; gap:8px; }
    .inline-buttons > button { flex:1; }
    .advanced-feature { display:none !important; }
    body.advanced-features .advanced-feature { display:block !important; }
    body.advanced-features label.advanced-feature { display:flex !important; }
    .meta { color:var(--muted); font-size:17px; line-height:1.4; }
    .progress { margin:0 0 10px; border:1px solid var(--line); border-radius:6px; overflow:hidden; height:18px; background:#f1f3f4; }
    .bar { height:100%; width:0%; background:linear-gradient(90deg, var(--accent), var(--gold)); transition:width .2s ease; }
    .feed { border:1px solid var(--line); border-radius:6px; height:55vh; overflow:auto; padding:12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:15px; background:#fff; }
    .feed div { padding:5px 0; border-bottom:1px solid #f1f3f4; }
    .files { margin-top:14px; }
    .files-table { width:100%; border-collapse:collapse; border:1px solid var(--line); border-radius:6px; overflow:hidden; background:#fff; }
    .files-table th, .files-table td { border-bottom:1px solid #edf1ef; padding:10px 12px; text-align:left; vertical-align:middle; }
    .files-table th { background:var(--panel); color:var(--accent-strong); font-size:14px; text-transform:uppercase; letter-spacing:.04em; }
    .files-table td { font-size:16px; }
    .files-table tr:last-child td { border-bottom:0; }
    .files-table td:last-child { text-align:right; white-space:nowrap; }
    .file { border:1px solid var(--line); border-radius:6px; padding:10px; display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .file-name { display:flex; align-items:center; gap:10px; min-width:0; }
    .file-icon { width:28px; height:34px; border:1px solid var(--line); border-radius:4px; display:grid; place-items:center; font-size:15px; font-weight:700; flex:0 0 auto; position:relative; background:#fff; }
    .file-icon::after { content:""; position:absolute; top:-1px; right:-1px; width:9px; height:9px; border-left:1px solid var(--line); border-bottom:1px solid var(--line); background:#f1f3f4; border-radius:0 4px 0 2px; }
    .file-icon.excel { color:#137333; border-color:#9bc3a8; background:#f3fbf5; }
    .file-icon.text { color:#5f6368; border-color:#c7ccd1; background:#f8fafd; }
    .file-actions { display:flex; gap:8px; justify-content:flex-end; flex:0 0 auto; }
    .file a, .files-table a, .meta a { color:var(--accent-strong); font-weight:700; text-decoration:none; }
    .status-box { border:1px solid var(--line); border-radius:6px; padding:10px; background:#fff; }
    .status-box h2 { font-size:18px; margin:0 0 8px; }
    .status-box dl { margin:0; display:grid; gap:6px; }
    .status-box dt { font-weight:700; color:var(--ink); }
    .status-box dd { margin:0; color:var(--muted); overflow-wrap:anywhere; }
    .status-actions { display:flex; gap:8px; margin-top:10px; }
    .status-actions button { flex:1; }
    button.secondary { background:#5f6368; }
    .run-surface { display:flex; flex-direction:column; min-height:calc(100vh - 73px); }
    .results-heading { margin:20px 0 0; }
    .guide-page { max-width:960px; margin:0 auto; font-size:18px; line-height:1.55; }
    .guide-page h2 { margin:28px 0 8px; color:var(--accent-strong); font-size:26px; }
    .guide-page p, .guide-page ul, .guide-page ol, .guide-page dl { margin:0 0 14px; }
    .guide-page li { margin:6px 0; }
    .guide-page dt { font-weight:700; color:var(--ink); margin-top:10px; }
    .guide-page dd { margin:2px 0 8px; color:var(--muted); }
    @media (max-width: 760px) { main { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } .inline-buttons { flex-direction:column; } .run-surface { min-height:auto; } .files-table th, .files-table td { padding:8px; } }
  `;
}

export function mainPageScript(): string {
  return [
    browserStateScript(),
    inputWorkflowScript(),
    runWorkflowScript(),
    progressWorkflowScript(),
    outputFilesScript(),
    emailPollingScript(),
    sharedUiScript()
  ].join("\n");
}

function browserStateScript(): string {
  return `
    const state = { uploadId: null, eventSource: null, isRunning: false, currentRunId: null, stopRequested: false };
    const activeRunStorageKey = "licenseStatusChecker.activeRunId";
    const advancedFeaturesStorageKey = "licenseStatusChecker.advancedFeatures";
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

    applyAdvancedFeatureVisibility();
    document.addEventListener("keydown", (event) => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== "d") return;
      event.preventDefault();
      const enabled = document.body.classList.toggle("advanced-features");
      localStorage.setItem(advancedFeaturesStorageKey, enabled ? "1" : "0");
    });
    refreshEmailPollStatus();
    setInterval(refreshEmailPollStatus, 60000);
    restoreActiveRun();
  `;
}

function inputWorkflowScript(): string {
  return `
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
  `;
}

function runWorkflowScript(): string {
  return `
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
          checkDelaySeconds: checkDelay.value ? Number(checkDelay.value) : 1.5,
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
      rememberActiveRun(payload.runId);
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
  `;
}

function emailPollingScript(): string {
  return `
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
  `;
}

function progressWorkflowScript(): string {
  return `
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
          forgetActiveRun();
          closeProgressStream();
          setBusy(false);
          setStatus(update.type === "run_canceled" ? "Run stopped." : "Run complete.");
        }
        if (update.type === "run_error") {
          state.isRunning = false;
          state.currentRunId = null;
          state.stopRequested = false;
          forgetActiveRun();
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
        forgetActiveRun();
        closeProgressStream();
        setBusy(false);
      };
    }

    function closeProgressStream() {
      if (!state.eventSource) return;
      state.eventSource.close();
      state.eventSource = null;
    }

    function restoreActiveRun() {
      const runId = localStorage.getItem(activeRunStorageKey);
      if (!runId) return;
      state.isRunning = true;
      state.currentRunId = runId;
      state.stopRequested = false;
      feed.innerHTML = "";
      files.innerHTML = "";
      setBusy(true);
      setStatus("Reconnected to run " + runId + ".");
      connect(runId);
    }

    function rememberActiveRun(runId) {
      localStorage.setItem(activeRunStorageKey, runId);
    }

    function forgetActiveRun() {
      localStorage.removeItem(activeRunStorageKey);
    }
  `;
}

function outputFilesScript(): string {
  return `
    function renderFiles(fileLinks) {
      const labels = {
        send: "Send workbook (.xlsx)",
        doNotSend: "Do-not-send workbook (.xlsx)",
        coursesAlreadyTaken: "Course frequency workbook (.xlsx)",
        expired: "Expired log (.txt)",
        greaterThan90: "Greater-than-90 log (.txt)",
        exception: "Exception log (.txt)"
      };
      files.innerHTML = "";
      const table = document.createElement("table");
      table.className = "files-table";
      table.innerHTML = "<thead><tr><th>Type</th><th>File</th><th>Actions</th></tr></thead><tbody></tbody>";
      const tbody = table.querySelector("tbody");
      for (const [key, href] of Object.entries(fileLinks)) {
        const row = document.createElement("tr");
        const isWorkbook = ["send", "doNotSend", "coursesAlreadyTaken"].includes(key);
        const iconClass = isWorkbook ? "excel" : "text";
        const iconText = isWorkbook ? "X" : "N";
        const iconLabel = isWorkbook ? "Excel workbook" : "Text log";
        row.innerHTML =
          '<td><span class="file-name"><span class="file-icon ' + iconClass + '" title="' + iconLabel + '" aria-label="' + iconLabel + '">' + iconText + '</span><span>' + iconLabel + '</span></span></td>' +
          '<td>' + (labels[key] || key) + '</td>' +
          '<td><span class="file-actions"><a href="' + href + '" target="_blank">View</a><a href="' + href + '?download=1">Download</a></span></td>';
        tbody.appendChild(row);
      }
      files.appendChild(table);
    }
  `;
}

function sharedUiScript(): string {
  return `
    function loadWorkbook(payload, message) {
      state.uploadId = payload.id;
      worksheet.innerHTML = '<option value="">All supported trades</option>';
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

    function formatDateTime(value) {
      return value ? new Date(value).toLocaleString() : "";
    }

    function applyAdvancedFeatureVisibility() {
      document.body.classList.toggle("advanced-features", localStorage.getItem(advancedFeaturesStorageKey) === "1");
    }
  `;
}
