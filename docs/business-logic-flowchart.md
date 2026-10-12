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
    G -- No --> H{"Live expiration<br/>more than 90 days away?"}
    H -- Yes --> NO
    H -- No --> I{"Status is Active?"}
    I -- No --> NO
    I -- Yes --> J{"Trade type?"}

    J -- Electrician --> EL{"Any detected CE credits?<br/>Recorded target: 24"}
    J -- Plumber --> PL{"Any detected CE credits?<br/>Recorded target: 16"}
    EL -- Yes --> NO
    PL -- Yes --> NO
    EL -- "No / no courses section" --> SEND["SEND"]
    PL -- "No / no courses section" --> SEND

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

The CE targets distinguish "some credits already" from "enough credits" in
Do Not Send; they do not allow people with partial credits into Send.

Implementation details and limitations, including the CE parser and live
expiration handling, are described in the linked README section.
