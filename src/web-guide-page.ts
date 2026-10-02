export function guideHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" href="/app-icon.png">
  <link rel="apple-touch-icon" href="/app-icon.png">
  <link rel="stylesheet" href="/assets/main.css">
  <title>Get Started Guide</title>
</head>
<body>
  <header>
    <div class="brand">
      <img class="brand-icon" src="/app-icon.png" alt="" aria-hidden="true">
      <h1>Get Started Guide</h1>
    </div>
    <div class="meta"><a href="/">New Run</a> &middot; <a href="/runs">Previous Runs</a></div>
  </header>
  <section class="guide-page">
    <h2>What This App Does</h2>
    <p>The License Status Checker processes Washington trade license spreadsheets. It reads the Excel file, skips rows that are not ready to check, visits the Washington L&amp;I license website for eligible licenses, and creates output files showing who should or should not be contacted.</p>

    <h2>Basic Workflow</h2>
    <ol>
      <li>Click <strong>Choose File</strong> and select the input Excel workbook.</li>
      <li>Click <strong>Load Excel</strong>.</li>
      <li>Choose <strong>All supported trades</strong> or one trade type.</li>
      <li>Click <strong>Run Check</strong>.</li>
      <li>Watch the Progress panel for status updates.</li>
      <li>When the run finishes, use Output Files to view or download results.</li>
    </ol>

    <h2>Supported Trades</h2>
    <ul>
      <li>Plumbers</li>
      <li>Plumber Trainees</li>
      <li>Electricians</li>
    </ul>

    <h2>What To Expect</h2>
    <ul>
      <li>The app reads the Excel workbook and counts rows before checking the website.</li>
      <li>Expired rows and rows more than 90 days away from expiration are skipped before website checks.</li>
      <li>Eligible licenses are checked on the Washington L&amp;I website.</li>
      <li>If Washington rate-limits the app with an HTTP 429 or F5 rejection page, the run stops and records the issue in the exception log.</li>
      <li>Runs can take a while because the app pauses between license checks to be gentler on the Washington website.</li>
    </ul>

    <h2>Output Files</h2>
    <dl>
      <dt>Send-{date}.xlsx</dt><dd>People who appear eligible to contact.</dd>
      <dt>DoNotSend-{date}.xlsx</dt><dd>People who should not be contacted, with a reason when available.</dd>
      <dt>coursesAlreadyTaken.xlsx</dt><dd>Course frequency summary for licenses that already show CE credits.</dd>
      <dt>expired.txt</dt><dd>Rows skipped because the spreadsheet expiration date is already expired.</dd>
      <dt>greaterThan90.txt</dt><dd>Rows skipped because the spreadsheet expiration date is more than 90 days away.</dd>
      <dt>exception.txt</dt><dd>Spreadsheet errors, browser errors, Washington rate-limit errors, and other exceptions.</dd>
    </dl>

    <h2>Email Results</h2>
    <ul>
      <li>Excel result files are sent as email attachments.</li>
      <li>Log and text files are sent as links back to the web app.</li>
      <li>Recipients are controlled by the EMAIL_RECIPIENTS setting in the app configuration.</li>
      <li>For the AnytimeCE production setup, results should be emailed to the configured AnytimeCE recipient list.</li>
    </ul>

    <h2>Support</h2>
    <p>If you need help, email <a href="mailto:tonynguyen3@gmail.com">tonynguyen3@gmail.com</a>.</p>
  </section>
</body>
</html>`;
}
