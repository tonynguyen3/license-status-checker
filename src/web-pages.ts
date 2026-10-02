export function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" href="/app-icon.png">
  <link rel="apple-touch-icon" href="/app-icon.png">
  <link rel="stylesheet" href="/assets/main.css">
  <title>License Status Checker</title>
</head>
<body>
  ${pageHeader()}
  <main>
    ${workflowSidebar()}
    ${runSurface()}
  </main>
  <script src="/assets/main.js"></script>
</body>
</html>`;
}

function pageHeader(): string {
  return `
  <header>
    <div class="brand">
      <img class="brand-icon" src="/app-icon.png" alt="" aria-hidden="true">
      <h1>License Status Checker</h1>
    </div>
    <div class="meta"><a href="/runs">Previous Runs</a> · <span id="status">Upload a workbook to begin.</span></div>
  </header>`;
}

function workflowSidebar(): string {
  return `
    <aside class="workflow">
      ${stage(1, "Input", "Choose File then click Load Excel", `
        <label for="file">Input Excel</label>
        <input id="file" type="file" accept=".xlsx">
        <div class="inline-buttons">
          <button id="upload">Load Excel</button>
          <button id="checkEmail" class="advanced-feature">Check Email</button>
        </div>
        <div class="meta" id="uploadMeta"></div>
      `)}
      ${stage(2, "Configure", "Choose a single trade type to process or leave it as All to process all the trades", `
        <label for="worksheet">Worksheet</label>
        <select id="worksheet" disabled>
          <option value="">All supported trades</option>
        </select>
        <div class="advanced-feature">
          <label for="limit">Website check limit</label>
          <input id="limit" type="number" min="1" step="1" placeholder="Leave blank for all eligible rows">
        </div>
        <div class="advanced-feature">
          <label for="checkDelay">Pause between website checks</label>
          <input id="checkDelay" type="number" min="0" step="0.5" value="1.5">
        </div>
        <label class="row advanced-feature"><input id="headed" type="checkbox"> Debug: Show browser window (only works locally)</label>
      `)}
      ${stage(3, "Run", "Start the website checks, or stop after the current license finishes.", `
        <button id="run" disabled>Run Check</button>
        <button id="stop" class="danger" disabled>Stop Run</button>
      `)}
      ${stage(4, "Email Polling", "Schedule a daily check for new input files.", `
        <div class="status-box">
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
      `, "advanced-feature")}
    </aside>`;
}

function stage(number: number, title: string, description: string, body: string, className = ""): string {
  return `
      <div class="stage ${className}">
        <div class="stage-header">
          <div class="stage-number">${number}</div>
          <div class="stage-title">
            <h2>${title}</h2>
            <p>${description}</p>
          </div>
        </div>
        <div class="stage-body">${body}</div>
      </div>`;
}

function runSurface(): string {
  return `
    <section class="run-surface">
      <div class="progress"><div class="bar" id="bar"></div></div>
      <div class="meta" id="progressMeta">No run started.</div>
      <div class="toolbar">
        <h2>Progress</h2>
        <label class="row"><input id="autoScroll" type="checkbox" checked> Auto-scroll while running</label>
      </div>
      <div class="feed" id="feed"></div>
      <h2 class="results-heading">Output Files</h2>
      <div class="files" id="files"></div>
    </section>`;
}
