# License Status Checker

This is a TypeScript + Playwright rewrite of the Washington path from the old C# Selenium app.

## What It Does

The CLI reads an Excel workbook of Washington license holders, checks each license on Washington L&I, and writes:

- `Send-{date}.xlsx`
- `DoNotSend-{date}.xlsx`
- `coursesAlreadyTaken.xlsx`
- `expired.txt`
- `greaterThan90.txt`
- `exception.txt`

The bucketing rules match the old app:

- skip spreadsheet rows already expired
- skip spreadsheet rows more than 90 days out
- check the live L&I license page
- exclude invalid, non-active, or likely-renewed licenses
- map trade to CE hours:
  - `Plumber Trainee`: 8
  - `Plumber`: 16
  - `Electrician`: 24
- send active, near-expiration licenses with no completed CE credits
- do not send if any CE credits are already present

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
```

The input workbook must be named `ListToCheck.xlsx` unless you pass a custom `--input` path. The default input path is:

```text
Files/ListToCheck.xlsx
```

By default, the app reads every worksheet in that workbook. To read only one worksheet, pass `--worksheet` with the sheet name:

```bash
npm start -- --worksheet Electricians
npm start -- --worksheet Plumbers
npm start -- --worksheet "Plumber Trainees"
npm start -- --worksheet "Electrical Trainees"
```

Supported worksheet names:

- `Plumbers`
- `Plumber Trainees`
- `Electricians`
- `Electrical Trainees`

Each worksheet must use the Washington L&I export-style columns:

```text
License Type, License Number, Name, Address1, Address2, City, State, Zip, ExpirationDate
```

Generated output files are written to the output directory. By default, that is also `Files/`. You can change it with `--out-dir`.

- `Send-{date}.xlsx`: license holders who appear active, near renewal, and have no completed CE credits.
- `DoNotSend-{date}.xlsx`: license holders who should not be contacted, with a reason when available.
- `coursesAlreadyTaken.xlsx`: course title/code frequency report from licenses that already show completed CE credits.
- `expired.txt`: spreadsheet rows skipped before browser checks because the input expiration date is already past.
- `greaterThan90.txt`: spreadsheet rows skipped before browser checks because the input expiration date is more than 90 days away.
- `exception.txt`: spreadsheet parsing errors and Playwright/browser errors encountered during the run.

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
npm start -- --worksheet "Electrical Trainees" --limit 5
npm start -- --headed
npm start -- --limit 10 --headed --slow-mo 100
```

`--headed` opens the browser visibly, which is helpful while validating selectors against the state website.

## Web Interface

Start the local web interface:

```bash
npm run web
```

Then open:

```text
http://localhost:3000
```

The page lets you upload `ListToCheck.xlsx`, choose a worksheet, set an optional website check limit, and run the check. Progress is streamed to the page while the app loads the workbook, counts eligible rows, checks each license, and writes outputs. When the run finishes, the page shows view/download links for the output workbooks and logs.

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
EMAIL_BASE_URL=http://localhost:3000
```

If `EMAIL_BASE_URL` is omitted, the app uses the host from the web request, usually `http://localhost:3000`. Keep the web server running if recipients need to open the log links.

### Email Input Workbook

The web interface can also check email for an input workbook. This is a manual button, not background polling, so the app will not automatically run just because an email arrives.

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
