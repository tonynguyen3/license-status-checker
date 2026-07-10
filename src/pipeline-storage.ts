import type { BucketedResult, CourseFrequency, Tradesman } from "./types.js";

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

export interface WorkQueueStore {
  appendWorkItem(item: WorkItem): Promise<void>;
  readWorkItems(): Promise<WorkItem[]>;
}

export interface LookupResultStore {
  appendLookupResult(result: BucketedResult): Promise<void>;
  readLookupResults(): Promise<LookupResultRecord[]>;
}

export interface CourseFrequencyStore {
  writeCourseFrequencies(courses: CourseFrequency[]): Promise<void>;
  readCourseFrequencies(): Promise<CourseFrequency[]>;
}

export interface WorkerControlStore {
  acquireWorkerLock(): Promise<void>;
  releaseWorkerLock(): Promise<void>;
  writeWorkerStatus(status: WorkerStatus): Promise<void>;
  readWorkerStatus(): Promise<WorkerStatus>;
  requestPause(): Promise<void>;
  clearPause(): Promise<void>;
  isPauseRequested(): boolean;
}

export interface PipelineStorage extends WorkQueueStore, LookupResultStore, CourseFrequencyStore, WorkerControlStore {
  initialize(): Promise<void>;
}
