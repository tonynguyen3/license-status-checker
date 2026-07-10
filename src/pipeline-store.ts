import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BucketedResult, CourseFrequency, OutputPaths, Tradesman } from "./types.js";

export interface WorkItem {
  id: number;
  tradesman: Tradesman;
  status: "queued";
  createdAt: string;
}

export interface LookupResultRecord {
  workItemId?: number;
  bucket: BucketedResult["bucket"];
  tradesman: Tradesman;
  checkedAt: string;
}

export type WorkerStatusName = "queued" | "running" | "paused" | "rate_limited" | "completed" | "failed";

export interface WorkerStatus {
  status: WorkerStatusName;
  pid?: number;
  startedAt?: string;
  heartbeatAt?: string;
  completedAt?: string;
  checked: number;
  remaining: number;
  errors: number;
  message?: string;
}

interface WorkerControl {
  pauseRequested?: boolean;
  updatedAt?: string;
}

export class PipelineStore {
  constructor(private readonly outputPaths: OutputPaths) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.outputPaths.workItemsPath), { recursive: true });
    await Promise.all([
      writeFile(this.outputPaths.workItemsPath, "", "utf8"),
      writeFile(this.outputPaths.lookupResultsPath, "", "utf8"),
      writeFile(this.outputPaths.courseFrequenciesJsonPath, "[]\n", "utf8"),
      writeFile(this.outputPaths.workerStatusPath, `${JSON.stringify(defaultWorkerStatus("queued"), null, 2)}\n`, "utf8"),
      writeFile(this.outputPaths.workerControlPath, "{}\n", "utf8")
    ]);
  }

  async appendWorkItem(item: WorkItem): Promise<void> {
    await appendJsonLine(this.outputPaths.workItemsPath, item);
  }

  async readWorkItems(): Promise<WorkItem[]> {
    return readJsonLines<WorkItem>(this.outputPaths.workItemsPath);
  }

  async appendLookupResult(result: BucketedResult): Promise<void> {
    await appendJsonLine(this.outputPaths.lookupResultsPath, {
      workItemId: result.tradesman.workItemId,
      bucket: result.bucket,
      tradesman: result.tradesman,
      checkedAt: new Date().toISOString()
    } satisfies LookupResultRecord);
  }

  async readLookupResults(): Promise<LookupResultRecord[]> {
    return readJsonLines<LookupResultRecord>(this.outputPaths.lookupResultsPath);
  }

  async writeCourseFrequencies(courses: CourseFrequency[]): Promise<void> {
    await writeFile(this.outputPaths.courseFrequenciesJsonPath, `${JSON.stringify(courses, null, 2)}\n`, "utf8");
  }

  async readCourseFrequencies(): Promise<CourseFrequency[]> {
    try {
      return JSON.parse(await readFile(this.outputPaths.courseFrequenciesJsonPath, "utf8")) as CourseFrequency[];
    } catch {
      return [];
    }
  }

  async acquireWorkerLock(): Promise<void> {
    await mkdir(dirname(this.outputPaths.workerLockPath), { recursive: true });
    if (existsSync(this.outputPaths.workerLockPath)) {
      throw new Error("A worker lock already exists for this run. Another worker may already be processing it.");
    }
    await writeFile(this.outputPaths.workerLockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  }

  async releaseWorkerLock(): Promise<void> {
    await rm(this.outputPaths.workerLockPath, { force: true });
  }

  async writeWorkerStatus(status: WorkerStatus): Promise<void> {
    await mkdir(dirname(this.outputPaths.workerStatusPath), { recursive: true });
    await writeFile(this.outputPaths.workerStatusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  }

  async readWorkerStatus(): Promise<WorkerStatus> {
    try {
      return JSON.parse(await readFile(this.outputPaths.workerStatusPath, "utf8")) as WorkerStatus;
    } catch {
      return defaultWorkerStatus("queued");
    }
  }

  async requestPause(): Promise<void> {
    await writeWorkerControl(this.outputPaths.workerControlPath, { pauseRequested: true, updatedAt: new Date().toISOString() });
  }

  async clearPause(): Promise<void> {
    await writeWorkerControl(this.outputPaths.workerControlPath, { pauseRequested: false, updatedAt: new Date().toISOString() });
  }

  isPauseRequested(): boolean {
    try {
      const control = JSON.parse(readFileSync(this.outputPaths.workerControlPath, "utf8")) as WorkerControl;
      return control.pauseRequested === true;
    } catch {
      return false;
    }
  }
}

function defaultWorkerStatus(status: WorkerStatusName): WorkerStatus {
  return {
    status,
    checked: 0,
    remaining: 0,
    errors: 0
  };
}

async function writeWorkerControl(path: string, control: WorkerControl): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(control, null, 2)}\n`, "utf8");
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}
