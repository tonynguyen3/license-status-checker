import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

export class PipelineStore {
  constructor(private readonly outputPaths: OutputPaths) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.outputPaths.workItemsPath), { recursive: true });
    await Promise.all([
      writeFile(this.outputPaths.workItemsPath, "", "utf8"),
      writeFile(this.outputPaths.lookupResultsPath, "", "utf8"),
      writeFile(this.outputPaths.courseFrequenciesJsonPath, "[]\n", "utf8")
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
