import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BucketedResult, CourseFrequency, OutputPaths } from "./types.js";
import type { LookupResultRecord, PipelineStorage, WorkerStatus, WorkerStatusName, WorkItem } from "./pipeline-storage.js";

interface WorkerControl {
  pauseRequested?: boolean;
  updatedAt?: string;
}

export class PipelineStore implements PipelineStorage {
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

  async claimNextWorkItem(workerId: string): Promise<WorkItem | undefined> {
    const workItems = await this.readWorkItems();
    const index = workItems.findIndex((item) => item.status === "queued");
    if (index === -1) return undefined;

    const now = new Date().toISOString();
    const claimed = {
      ...workItems[index],
      status: "in_progress",
      claimedAt: now,
      claimedBy: workerId,
      attempts: (workItems[index].attempts ?? 0) + 1,
      lastError: undefined
    } satisfies WorkItem;
    workItems[index] = claimed;
    await writeJsonLines(this.outputPaths.workItemsPath, workItems);
    return claimed;
  }

  async completeWorkItem(id: number): Promise<void> {
    await this.updateWorkItem(id, (item) => ({
      ...item,
      status: "completed",
      completedAt: new Date().toISOString(),
      lastError: undefined
    }));
  }

  async failWorkItem(id: number, error: string): Promise<void> {
    await this.updateWorkItem(id, (item) => ({
      ...item,
      status: "failed",
      lastError: error
    }));
  }

  async requeueFailedWorkItems(maxAttempts: number): Promise<number> {
    const workItems = await this.readWorkItems();
    let requeued = 0;
    const updated = workItems.map((item) => {
      if (item.status !== "failed" || (item.attempts ?? 0) >= maxAttempts) return item;
      requeued++;
      return {
        ...item,
        status: "queued",
        claimedAt: undefined,
        claimedBy: undefined,
        lastError: "Requeued failed work item for retry."
      } satisfies WorkItem;
    });

    if (requeued > 0) {
      await writeJsonLines(this.outputPaths.workItemsPath, updated);
    }
    return requeued;
  }

  async releaseStaleClaims(maxAgeMs: number): Promise<number> {
    const workItems = await this.readWorkItems();
    const staleBefore = Date.now() - Math.max(0, maxAgeMs);
    let released = 0;
    const updated = workItems.map((item) => {
      if (item.status !== "in_progress" || !item.claimedAt) return item;
      if (new Date(item.claimedAt).getTime() > staleBefore) return item;
      released++;
      return {
        ...item,
        status: "queued",
        claimedAt: undefined,
        claimedBy: undefined,
        lastError: "Released stale in-progress claim."
      } satisfies WorkItem;
    });

    if (released > 0) {
      await writeJsonLines(this.outputPaths.workItemsPath, updated);
    }
    return released;
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

  private async updateWorkItem(id: number, update: (item: WorkItem) => WorkItem): Promise<void> {
    const workItems = await this.readWorkItems();
    const index = workItems.findIndex((item) => item.id === id);
    if (index === -1) return;

    workItems[index] = update(workItems[index]);
    await writeJsonLines(this.outputPaths.workItemsPath, workItems);
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

async function writeJsonLines(path: string, values: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : ""), "utf8");
  await rename(tempPath, path);
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
