export type LicenseBucket = "send" | "doNotSend";

export interface Tradesman {
  licenseType?: string;
  licenseNumber: string;
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  expirationDate?: string;
  liveExpirationDate?: string;
  licenseStatus?: string;
  statusEvidence?: string;
  expirationComparison?: string;
  decisionReason?: string;
  reportedCourses?: string;
  ceClassification?: string;
  trade?: string;
  hoursNeeded?: number;
  hoursCompleted?: number;
  notSendReason?: string;
  affidavitFromDate?: string;
  affidavitToDate?: string;
  affidavitHoursReported?: number;
  affidavitWholeWeeks?: number;
  affidavitHoursPerWeek?: number;
  affidavitDecision?: string;
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
  isCanceled?: () => boolean;
}

export interface OutputPaths {
  sendPath: string;
  doNotSendPath: string;
  coursesAlreadyTakenPath: string;
  expiredLogPath: string;
  greaterThan90LogPath: string;
  exceptionLogPath: string;
  timingLogPath: string;
}

export interface ProgressUpdate {
  type: string;
  message: string;
  current?: number;
  total?: number;
  remaining?: number;
  licenseNumber?: string;
  files?: Record<string, string>;
}

export type ProgressReporter = (update: ProgressUpdate) => void;
