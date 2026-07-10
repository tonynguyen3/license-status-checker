import { resolve } from "node:path";
import { formattedDate } from "./date-utils.js";
import type { OutputPaths } from "./types.js";

export function buildOutputPaths(outDir: string, date = new Date()): OutputPaths {
  const stamp = formattedDate(date);
  const base = resolve(outDir);

  return {
    sendPath: resolve(base, `Send-${stamp}.xlsx`),
    doNotSendPath: resolve(base, `DoNotSend-${stamp}.xlsx`),
    sendCsvPath: resolve(base, "Send.csv"),
    doNotSendCsvPath: resolve(base, "DoNotSend.csv"),
    workItemsPath: resolve(base, "work-items.jsonl"),
    lookupResultsPath: resolve(base, "lookup-results.jsonl"),
    courseFrequenciesJsonPath: resolve(base, "course-frequencies.json"),
    workerStatusPath: resolve(base, "worker-status.json"),
    workerControlPath: resolve(base, "worker-control.json"),
    workerLockPath: resolve(base, "worker.lock"),
    coursesAlreadyTakenPath: resolve(base, "coursesAlreadyTaken.xlsx"),
    expiredLogPath: resolve(base, "expired.txt"),
    greaterThan90LogPath: resolve(base, "greaterThan90.txt"),
    exceptionLogPath: resolve(base, "exception.txt"),
    runStatePath: resolve(base, "run-state.json")
  };
}
