# Send Vs Do Not Send Decision Flow

[Back to README](../README.md#send-vs-do-not-send-business-logic)

This chart describes the supported trade rules. Skipped rows and website errors
go into logs, not either output bucket. A check limit or stopped run can leave
eligible rows unchecked.

```mermaid
flowchart TD
    A["Read Excel row"] --> B{"License number and valid<br/>expiration date present?"}
    B -- No --> EX["Skip → Exception log"]
    B -- Yes --> C{"Excel expiration<br/>before today?"}
    C -- Yes --> OLD["Skip → Expired log"]
    C -- No --> D{"Excel expiration<br/>more than 90 days away?"}
    D -- Yes --> FAR["Skip → Greater-than-90 log"]
    D -- No --> E["Check Washington website"]

    E --> F{"Website check succeeds?"}
    F -- No --> ERR["Exception log<br/>Rate limits also stop the run"]
    F -- Yes --> G{"License identified as invalid?"}
    G -- Yes --> NO["DO NOT SEND"]
    G -- No --> R{"Live expiration later<br/>than input Excel date?"}
    R -- Yes --> REN["DO NOT SEND<br/>Likely renewed; record both dates"]
    R -- No --> S{"Live expiration earlier<br/>than input Excel date?"}
    S -- Yes --> REV["DO NOT SEND<br/>Date discrepancy; review required"]
    S -- No --> H{"Live expiration expired<br/>or more than 90 days away?"}
    H -- Yes --> NO
    H -- No --> WAIT["Wait up to 10 seconds for status DOM text<br/>Normalize case and trailing punctuation"]
    WAIT --> READ{"Status populated<br/>and recognized?"}
    READ -- No --> SE["Capture screenshot, HTML, and diagnostics<br/>Exception log; neither bucket"]
    READ -- Yes --> SUPER{"Superceded or Superseded?"}
    SUPER -- Yes --> LEVEL["DO NOT SEND<br/>Likely replaced after trainee/apprentice<br/>progression to journeyman; capture evidence"]
    SUPER -- No --> I{"Status is Active?"}
    I -- No --> NO
    I -- Yes --> CE{"CE section readable?<br/>Courses or explicit no-credits message?"}
    CE -- No --> ERR
    CE -- Yes --> J{"Trade type?"}

    J -- Electrician --> EL{"Any non-first-aid<br/>courses reported?"}
    J -- Plumber --> PL{"Any non-first-aid<br/>courses reported?"}
    EL -- Yes --> NO
    PL -- Yes --> NO
    EL -- "No / first aid only" --> SEND["SEND"]
    PL -- "No / first aid only" --> SEND

    J -- "Plumber Trainee" --> PT{"Any detected CE credits?<br/>Recorded target: 8"}
    PT -- Yes --> NO
    PT -- No --> K{"Today within license<br/>effective-expiration period?"}
    K -- No --> NO
    K -- Yes --> L["Select latest affidavit period<br/>by To Date, then From Date"]
    L --> M{"Valid dates and reported hours?<br/>At least one whole week?"}
    M -- No --> NO
    M -- Yes --> N{"To Date within license<br/>effective-expiration period?"}
    N -- No --> NO
    N -- Yes --> O{"To Date within rolling<br/>past 365 days, not future?"}
    O -- No --> NO
    O -- Yes --> P["Whole weeks = floor(elapsed days / 7)<br/>Average = reported hours / whole weeks"]
    P --> Q{"Average >= 20 hours/week?"}
    Q -- No --> NO
    Q -- Yes --> SEND
```

For trainees, From Date determines reporting duration and may precede the
license effective date. Multiple employers reporting the exact same latest
From/To period have their reported hours added together. Hours approved are
not used. Any detected CE credits take precedence over affidavit activity.

CE targets are reporting values, not bucket thresholds. The first-aid exception
applies only to Plumbers and Electricians. Any title containing the whole-word
phrase First Aid matches, ignoring case and accepting whitespace or hyphens;
provider names and other title wording do not prevent a match. A separate course
without that phrase counts as other CE. Incomplete course data goes into the exception log.

Implementation details and limitations, including the CE parser and live
expiration handling, are described in the linked README section.

Non-active status is recorded verbatim in `LicenseStatus` and the exclusion
reason. Blank or unrecognized text is not evidence of inactivity. The reader
uses DOM text rather than rendered text so loading delays, collapsed sections,
or CSS formatting do not turn Active into a false Do Not Send decision.
Evidence is also captured when the initial status is blank but later resolves,
or rendered status differs from the final DOM text.
