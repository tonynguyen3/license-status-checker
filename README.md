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
