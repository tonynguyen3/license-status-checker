# License Status Checker

This is a TypeScript + Playwright rewrite of the Washington path from the old C# Selenium app.

## Get Started Guide

The License Status Checker helps process Washington trade license spreadsheets. You upload an Excel file, choose which trade type to process, and start a run. The app reads the spreadsheet, skips rows that are not ready to check, visits the Washington L&I license website for eligible licenses, and produces output files that show who should or should not be contacted.

Open the web app:

```text
http://localhost:3001
```

Basic workflow:

1. Click `Choose File` and select the input Excel workbook.
2. Click `Load Excel`.
3. In `Configure`, choose `All supported trades` or one trade type.
4. Click `Run Check`.
5. Watch the `Progress` panel for high-level status.
6. When the run finishes, use `Output Files` to view or download the results.

The app checks only these supported trade worksheets:

- `Plumbers`
- `Plumber Trainees`
- `Electricians`

What to expect during a run:

- The app first reads the Excel workbook and counts rows.
- It skips expired rows and rows more than 90 days away from expiration.
- It checks eligible licenses on the Washington L&I website.
- If Washington rate-limits the app with an HTTP `429` or F5 rejection page, the run stops and records the issue in the exception log.
- Runs can take a while because the app pauses between license checks to be gentler on the Washington website.

Output files:

- `Send-{date}.xlsx`: people who appear eligible to contact.
- `DoNotSend-{date}.xlsx`: people who should not be contacted, with a reason when available.
- `coursesAlreadyTaken.xlsx`: course frequency summary for licenses that already show CE credits.
- `expired.txt`: rows skipped because the spreadsheet expiration date is already expired.
- `greaterThan90.txt`: rows skipped because the spreadsheet expiration date is more than 90 days away.
- `exception.txt`: spreadsheet errors, browser errors, Washington rate-limit errors, and other exceptions.

Email results:

- Excel result files are sent as email attachments.
- Log/text files are sent as links back to the web app.
- Recipients are controlled by the `EMAIL_RECIPIENTS` setting in `.env`.
- For the AnytimeCE production setup, results should be emailed to the configured AnytimeCE recipient list. Contact support if that list needs to change.

Support:

If you need help, email `tonynguyen3@gmail.com`.

## What It Does

The CLI reads an Excel workbook of Washington license holders, checks each license on Washington L&I, and writes:

- `Send-{date}.xlsx`
- `DoNotSend-{date}.xlsx`
- `coursesAlreadyTaken.xlsx`
- `expired.txt`
- `greaterThan90.txt`
- `exception.txt`
- `timings.txt`

## Send Vs Do Not Send Business Logic

These are postcard outreach rules. **Send** means the person qualifies for the
contact list; it does not send a postcard automatically. **Do Not Send** means
the website check excluded the person. Neither bucket is a legal determination
of renewal eligibility.

### Before Website Checks: All Trades

Only the `Plumbers`, `Plumber Trainees`, and `Electricians` worksheets are read.
Other worksheets are ignored. Each row needs a license number in column B and
a parseable expiration date in column I. The spreadsheet expiration must be
between today and 90 days from today, inclusive.

| Spreadsheet condition | Destination |
| --- | --- |
| Missing license number, missing/invalid date, or blank row | `exception.txt` |
| Expiration before today | `expired.txt` |
| Expiration more than 90 days away | `greaterThan90.txt` |
| Expiration today through 90 days away | Eligible for website check |

Skipped rows are **not** added to either output workbook. A configured website
check limit or stopping a run can also leave eligible rows unchecked; those rows
are not automatically classified as Do Not Send.

### Live Website Checks: All Trades

The checker uses the live website's license type to select the trade rules,
rather than relying on the worksheet name or Excel license type.

| Website condition | Result |
| --- | --- |
| License identified as invalid | Do Not Send: not a valid license |
| Expiration more than 90 days away | Do Not Send: likely already renewed |
| Status is anything other than `Active` | Do Not Send: not active |
| Website/browser error or unparseable website expiration | `exception.txt`; neither bucket |
| HTTP 429 or detected rate-limit rejection | `exception.txt`; stop the run |

For Plumber Trainees, the additional affidavit rule explicitly requires today
to be within the live license effective-expiration period. For Plumbers and
Electricians, the current website logic relies on `Active` status and the
more-than-90-day check; it does not independently test the effective date.

### Trade Decisions After The Shared Checks

| Trade on website | Recorded CE target (`HoursNeeded`) | Send | Do Not Send |
| --- | --- | --- | --- |
| `Plumber` | 16 | Zero detected CE credits, or no courses section | Any detected CE credits |
| `Electrician` | 24 | Zero detected CE credits, or no courses section | Any detected CE credits |
| `Plumber Trainee` | 8 | Zero detected CE credits **and** qualifying affidavit activity below | Any detected CE credits, or failed affidavit activity rules |

The CE targets are hard-coded reporting values, not minimum balances required
to enter Send. For example, a Plumber with 4 credits is Do Not Send even though
4 is below 16. Credits at or above the trade target produce the reason
"has enough credits"; positive credits below it produce "has some credits already."
`HoursNeeded` is the full target, not target minus completed hours.

### How Completed CE Hours Are Counted

The current parser finds spans anywhere on the website page containing `.00`,
ignores text containing `$`, parses the leading number, and sums those numbers
into `HoursCompleted`. No courses section is treated as zero credits for trainees;
Plumbers and Electricians go directly to Send when that section is absent.

This parser does not filter courses by completion date or renewal period, does
not restrict matches to course-hour fields, and can miss fractional hours or
additional numbers in the same span. The bucket rules use this detected total.
The `coursesAlreadyTaken.xlsx` title/code frequency report does not affect
Send versus Do Not Send.

### Plumber Trainee Affidavit Activity

Plumber Trainees with any completed CE credits remain in **Do Not Send**.
Zero-credit trainees must also meet all of these conditions to enter **Send**:

- The live license is Active, and today falls within its effective-expiration period (inclusive).
- The latest affidavit's To Date falls within that license period (inclusive). From Date may precede the license effective date; it is used only to compute the reporting duration.
- Its To Date is within the rolling past 365 days, including exactly 365 days ago, and is not in the future.
- Its average **Hours reported** is at least 20 hours per whole week. Hours approved are not used.

Weeks are the elapsed calendar days between From Date and To Date divided by 7,
rounded down, discarding leftover days. For example, 02/24/2024-02/23/2025 is
52 whole weeks, so 1,400 reported hours averages 26.92 hours/week. Periods shorter
than one whole week cannot qualify. The latest period is selected by To Date,
then From Date; multiple employers with the exact same period have their reported
hours added together. An older qualifying period does not override a newer one.
Missing or invalid affidavit data results in Do Not Send with an explanation.

Both output workbooks include affidavit dates, reported hours, whole weeks,
average hours/week, and the affidavit decision when this check is reached.
The existing Excel expiration filter (today through 90 days away) still applies
before website checks. These are postcard targeting rules, not legal renewal requirements.

### Examples

Assuming the spreadsheet and shared live checks pass:

| Trade and evidence | Result |
| --- | --- |
| Plumber, 0 CE credits | Send |
| Plumber, 4 CE credits | Do Not Send: some credits already |
| Electrician, 24 CE credits | Do Not Send: enough credits |
| Plumber Trainee, 1 CE credit and recent high-hour affidavit | Do Not Send: CE credits take precedence |
| Plumber Trainee, 0 CE credits, qualifying To Date, 1,400 hours / 52 weeks | Send: 26.92 hours/week |
| Plumber Trainee, 0 CE credits, latest To Date 366 days ago | Do Not Send: affidavit too old |
| Plumber Trainee, 0 CE credits, 500 hours / 52 weeks | Do Not Send: below 20 hours/week |

`NotSendReason` explains exclusions in the Do Not Send workbook. Affidavit
columns are populated only when a zero-credit trainee reaches that check;
they remain blank when an earlier condition already determines the outcome.

Implementation: `src/spreadsheet.ts` (input filters), `src/washington-checker.ts`
(live checks and CE decisions), `src/hours.ts` (CE targets), and
`src/trainee-affidavits.ts` (trainee activity calculation).

## Input And Output Files

By default, all input and output files live in a `Files` folder under the project root:

```text
license-status-checker/
  Files/
    ListToCheck.xlsx
    Send-{date}.xlsx
    DoNotSend-{date}.xlsx
    coursesAlreadyTaken.xlsx
    expired.txt
    greaterThan90.txt
    exception.txt
    timings.txt
```

The input workbook must be named `ListToCheck.xlsx` unless you pass a custom `--input` path. The default input path is:

```text
Files/ListToCheck.xlsx
```

By default, the app reads only the supported worksheets in that workbook and ignores other tabs. To read only one supported worksheet, pass `--worksheet` with the sheet name:

```bash
npm start -- --worksheet Electricians
npm start -- --worksheet Plumbers
npm start -- --worksheet "Plumber Trainees"
```

Supported worksheet names:

- `Plumbers`
- `Plumber Trainees`
- `Electricians`

Each worksheet must use the Washington L&I export-style columns:

```text
License Type, License Number, Name, Address1, Address2, City, State, Zip, ExpirationDate
```

Spreadsheet rows are filtered before the app opens the Washington website:

- rows with missing license numbers or missing/invalid expiration dates are written to `exception.txt`
- rows with expiration dates in the past are written to `expired.txt`
- rows with expiration dates more than 90 days away are written to `greaterThan90.txt`
- only rows expiring today through 90 days from today are sent to the Washington website check

Generated output files are written to the output directory. By default, that is also `Files/`. You can change it with `--out-dir`.

- `Send-{date}.xlsx`: license holders who appear active, near renewal, and have no completed CE credits. Plumber Trainees must also pass the affidavit activity rules above.
- `DoNotSend-{date}.xlsx`: license holders who should not be contacted, with a reason when available.
- `coursesAlreadyTaken.xlsx`: course title/code frequency report from licenses that already show completed CE credits.
- `expired.txt`: spreadsheet rows skipped before browser checks because the input expiration date is already past.
- `greaterThan90.txt`: spreadsheet rows skipped before browser checks because the input expiration date is more than 90 days away.
- `exception.txt`: spreadsheet parsing errors and Playwright/browser errors encountered during the run.
- `timings.txt`: pipe-delimited per-license timing data for Washington website checks.

`timings.txt` is intended for debugging slow runs and Washington website hiccups. It includes one row per checked license with total duration, HTTP status, the slowest phase, and phase timings for navigation, rate-limit page probing, expiration parsing, active-status lookup, trade lookup, course detection, completed-credit parsing, and course-frequency parsing. Rows with a `hiccup` value are the first ones to inspect; they mark slow total checks, slow navigation, slow page parsing, rate limits, and errors.

Example with explicit paths:

```bash
npm start -- --input ./Files/ListToCheck.xlsx --out-dir ./Files
```

## Setup

```bash
npm install
npm run install:browsers
```

## Run

Put the source workbook at:

```text
Files/ListToCheck.xlsx
```

Then run:

```bash
npm start
```

Useful options:

```bash
npm start -- --input /path/to/ListToCheck.xlsx --out-dir /path/to/Files
npm start -- --worksheet Electricians
npm start -- --worksheet "Plumber Trainees" --limit 5
npm start -- --headed
npm start -- --limit 10 --headed --slow-mo 100 --check-delay-ms 3000
```

`--headed` opens the browser visibly, which is helpful while validating selectors against the state website.

`--slow-mo` is a Playwright/browser debugging option. It slows down low-level browser actions such as navigation, locator operations, clicks, and typing. It is most useful with `--headed` when you want to watch what the browser is doing. It does not guarantee a clean pause between one license row and the next.

`--check-delay-ms` is the app-level Washington website throttle. It controls the pause between one license/person lookup and the next license/person lookup. This is the important setting for being gentle with the Washington website and reducing the chance of F5/HTTP `429` rate limits. It defaults to `3000`, which waits about 3 seconds between license rows.

## Web Interface

Start the local web interface:

```bash
npm run web
```

Then open:

```text
http://localhost:3001
```

For production, build the JavaScript files first and run the built server:

```bash
npm run build
npm run web:built
```

![License Status Checker web interface](docs/web-interface.png)

The page lets you upload `ListToCheck.xlsx`, choose a worksheet, set an optional website check limit, set a pause between Washington website checks, and run the check. Progress is streamed to the page while the app loads the workbook, counts eligible rows, checks each license, and writes outputs. When the run finishes, the page shows view/download links for the output workbooks and logs.

The `Previous Runs` page lists completed run folders and lets you delete old runs. Deleting a run removes its folder under `Files/web-runs` and its output files from disk.

The web server also automatically purges old timestamped run folders under `Files/web-runs`, keeping the newest 20 run folders by default. Cleanup runs when the web server starts and then once per day while it stays running. To change the retained folder count, set `WEB_RUN_RETENTION_COUNT` in `.env`.

If Washington returns an HTTP `429` response, or appears to show an F5/rate-limit rejection page, the app writes that to `exception.txt` and stops the website checks before moving to the next license.

### Email Results

The web interface can email results after each run. Excel output files are attached to the email. Log files are included as links back to the local web server.

Create a local `.env` file next to `package.json`:

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD="your app password"
EMAIL_FROM=your-email@gmail.com
EMAIL_RECIPIENTS=recipient@example.com
```

Optional:

```text
EMAIL_BASE_URL=http://localhost:3001
```

If `EMAIL_BASE_URL` is omitted, the app uses the host from the web request, usually `http://localhost:3001`. Keep the web server running if recipients need to open the log links.

### Email Input Workbook

The web interface can also check email for an input workbook. Use the `Check Email for Input File` button for a manual check, or configure the scheduled poller to check once per day and automatically start a run when it finds a matching unread workbook.

Add IMAP settings to your local `.env`:

```text
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER=your-email@gmail.com
IMAP_PASSWORD="your app password"
INPUT_EMAIL_ATTACHMENT_NAME=WA Ele *.xlsx,WA PLM *.xlsx,WA PLM Trainees *.xlsx,Master List from Kelly for AnytimeCE Post card mailing *.xlsx
```

Optional filters:

```text
INPUT_EMAIL_FROM=tonynguyen3@gmail.com,techsupport1@anytimece.com,hvacschool@hvacschool.com,hvacshoolappemailer@gmail.com,hvacschoolappemailer@gmail.com
INPUT_EMAIL_SUBJECT_CONTAINS=License Status Input
```

The email checker looks at unread messages in newest-first order, finds the first message that matches the optional sender/subject filters, and loads the matching Excel attachment. `INPUT_EMAIL_FROM` accepts a comma-separated sender list. `INPUT_EMAIL_ATTACHMENT_NAME` accepts comma-separated wildcard patterns. Use `*.xlsx` if you want to allow any Excel attachment.

After a workbook is loaded from email, choose the worksheet/options and click `Run Check`. The email is marked read only after a matching workbook is loaded.

### Scheduled Email Polling

The web server can check email once per day at a configured local time. If it finds a matching unread workbook, it marks that message read, saves the workbook to a timestamped run folder, and starts the same run pipeline used by the web UI.

Add these optional settings to `.env`:

```text
EMAIL_POLL_TIME=06:00
EMAIL_POLL_WORKSHEET=Electricians
EMAIL_POLL_LIMIT=50
EMAIL_POLL_CHECK_DELAY_MS=3000
EMAIL_POLL_HEADED=false
```

`EMAIL_POLL_TIME` uses 24-hour `HH:MM` time in the server's local timezone. Setting `EMAIL_POLL_TIME` enables the scheduler at server startup; `EMAIL_POLL_ENABLED=true` can also be set explicitly. Leave `EMAIL_POLL_WORKSHEET` or `EMAIL_POLL_LIMIT` blank to run all worksheets or all eligible rows.

The web page shows the scheduler status, including the last checked time, last result, and next check time. The Email Polling panel also has a poll-time input plus Enable and Disable buttons for changing polling while the web server is running. When you click Enable, the page prompts for the daily poll time in 24-hour `HH:MM` format and schedules the poll using that time.

The UI buttons use the run settings already loaded from `.env`, including `EMAIL_POLL_WORKSHEET`, `EMAIL_POLL_LIMIT`, and `EMAIL_POLL_CHECK_DELAY_MS`. The poll time entered in the UI overrides `EMAIL_POLL_TIME` for the current server process only. These are runtime controls: disabling polling in the UI stops the pending timer, and enabling polling starts a new timer. `.env` still controls the default polling state and default poll time the next time the server starts.

`EMAIL_POLL_CHECK_DELAY_MS` has the same meaning as `--check-delay-ms`: it is the app-level pause between Washington license/person lookups during a scheduled run. It is not the same as `--slow-mo`, which is only for slowing down browser actions while debugging.

The app also writes scheduled email polling activity to:

```text
Files/email-poll.log
```

## Verify

```bash
npm run check
npm test
```

## Notes

The old C# app added records to an in-memory send list when the L&I page had no `Courses` section, but it did not write those rows to the Send spreadsheet. This rewrite writes all bucketed rows at the end, so those send rows are preserved.

The Playwright selectors still depend on Washington L&I's page structure, especially:

- `#ExpirationDate`
- `#StatusDescription strong`
- `#LicenseType`
- `#Courses`
- `#coursesList .itemSingleCol`
