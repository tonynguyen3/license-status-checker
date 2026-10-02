import type { FileLink } from "./web-page-types.js";

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
