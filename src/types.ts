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
  limit?: number;
}

export interface OutputPaths {
  sendPath: string;
  doNotSendPath: string;
  coursesAlreadyTakenPath: string;
  expiredLogPath: string;
  greaterThan90LogPath: string;
  exceptionLogPath: string;
}
