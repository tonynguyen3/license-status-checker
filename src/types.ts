export type LicenseBucket = "send" | "doNotSend";

export interface Tradesman {
  workItemId?: number;
  licenseType?: string;
  licenseNumber: string;
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  expirationDate?: string;
  sourceWorksheet?: string;
  sourceRowNumber?: number;
  sourceLocation?: string;
  trade?: string;
  hoursNeeded?: number;
  hoursCompleted?: number;
  notSendReason?: string;
}

export interface CourseFrequency {
  courseName: string;
  courseCode: string;
  frequency: number;
}

export interface BucketedResult {
  bucket: LicenseBucket;
  tradesman: Tradesman;
}

export interface CheckerOptions {
  headed: boolean;
  slowMo: number;
  checkDelayMs: number;
  limit?: number;
  onProgress?: ProgressReporter;
  onResult?: (result: BucketedResult) => void | Promise<void>;
  isCanceled?: () => boolean;
}

export interface OutputPaths {
  sendPath: string;
  doNotSendPath: string;
  sendCsvPath: string;
  doNotSendCsvPath: string;
  workItemsPath: string;
  lookupResultsPath: string;
  courseFrequenciesJsonPath: string;
  coursesAlreadyTakenPath: string;
  expiredLogPath: string;
  greaterThan90LogPath: string;
  exceptionLogPath: string;
  runStatePath: string;
}

export interface ProgressUpdate {
  type: string;
  message: string;
  current?: number;
  total?: number;
  remaining?: number;
  licenseNumber?: string;
  errorCount?: number;
  sendCount?: number;
  doNotSendCount?: number;
  queuedCount?: number;
  lookupResultCount?: number;
  courseFrequencyCount?: number;
  canResume?: boolean;
  rateLimited?: boolean;
  files?: Record<string, string>;
}

export type ProgressReporter = (update: ProgressUpdate) => void;
