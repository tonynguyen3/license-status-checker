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

    <h2>Who Goes Into Send Or Do Not Send?</h2>
    <p>These lists identify who qualifies for postcard outreach. Creating a Send list does not automatically send postcards.</p>
    <p>For all trades, the Excel expiration date must be today through 90 days away. Missing or invalid data, expired rows, and rows more than 90 days away are skipped into the logs, rather than either result list. The website check excludes invalid licenses, licenses whose expiration is more than 90 days away, and licenses that are not Active. Website errors go into the exception log instead of either list.</p>
    <dl>
      <dt>Plumbers</dt><dd>Send when no CE credits are detected, or no courses section is present. Any detected CE credits mean Do Not Send. The recorded CE target is 16 hours.</dd>
      <dt>Electricians</dt><dd>Send when no CE credits are detected, or no courses section is present. Any detected CE credits mean Do Not Send. The recorded CE target is 24 hours.</dd>
      <dt>Plumber Trainees</dt><dd>Any detected CE credits mean Do Not Send, even below the recorded 8-hour target. With zero credits, the license must be active and within its effective-expiration period, and the latest affidavit must qualify as described below.</dd>
    </dl>
    <h2>Plumber Trainee Work Activity</h2>
    <ul>
      <li>The latest affidavit To Date must be within the rolling past 365 days, including exactly 365 days ago, and cannot be in the future.</li>
      <li>Only To Date must fall between the license effective and expiration dates. From Date may be earlier than the license effective date.</li>
      <li>Average reported work hours must be at least 20 per whole week. Hours approved are not used.</li>
      <li>Whole weeks equal elapsed days between From Date and To Date divided by 7, rounded down. For example, 1,400 hours over 52 whole weeks is 26.92 hours/week.</li>
      <li>The latest period is selected by To Date, then From Date. Hours from multiple employers reporting the exact same period are added together.</li>
      <li>Missing or invalid affidavit data, a period shorter than one whole week, old reports, or an average below 20 hours/week mean Do Not Send.</li>
    </ul>
    <p>The output includes the decision reason and affidavit details when the affidavit check is reached. The recorded CE target is not a remaining-hours calculation: any detected CE credits exclude the person from Send.</p>
    <p>CE totals currently use numbers detected on the website page and are not filtered by course date or renewal period. These are outreach rules, not a determination of legal renewal eligibility.</p>

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
