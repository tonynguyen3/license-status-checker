import { PipelineStore } from "./pipeline-store.js";
import type { LookupResultRecord } from "./pipeline-storage.js";
import type { LicenseBucket, OutputPaths, Tradesman } from "./types.js";

export interface LookupResultFilter {
  bucket?: LicenseBucket;
  worksheet?: string;
  licenseType?: string;
  trade?: string;
  reasonContains?: string;
}

export interface RunReportSummary {
  total: number;
  send: number;
  doNotSend: number;
  byWorksheet: Record<string, number>;
  byLicenseType: Record<string, number>;
  byTrade: Record<string, number>;
  byReason: Record<string, number>;
}

export class ReportRepository {
  private readonly store: PipelineStore;

  constructor(outputPaths: OutputPaths) {
    this.store = new PipelineStore(outputPaths);
  }

  async listResults(filter: LookupResultFilter = {}): Promise<LookupResultRecord[]> {
    const results = await this.store.readLookupResults();
    return results.filter((result) => matchesFilter(result.tradesman, result.bucket, filter));
  }

  async listTradesmen(filter: LookupResultFilter = {}): Promise<Tradesman[]> {
    return (await this.listResults(filter)).map((result) => result.tradesman);
  }

  async summary(filter: LookupResultFilter = {}): Promise<RunReportSummary> {
    return summarizeResults(await this.listResults(filter));
  }
}

export function summarizeResults(results: LookupResultRecord[]): RunReportSummary {
  const summary: RunReportSummary = {
    total: results.length,
    send: 0,
    doNotSend: 0,
    byWorksheet: {},
    byLicenseType: {},
    byTrade: {},
    byReason: {}
  };

  for (const result of results) {
    if (result.bucket === "send") {
      summary.send++;
    } else {
      summary.doNotSend++;
    }

    increment(summary.byWorksheet, result.tradesman.sourceWorksheet);
    increment(summary.byLicenseType, result.tradesman.licenseType);
    increment(summary.byTrade, result.tradesman.trade);
    if (result.tradesman.notSendReason) {
      increment(summary.byReason, normalizeReason(result.tradesman.notSendReason));
    }
  }

  return summary;
}

function matchesFilter(tradesman: Tradesman, bucket: LicenseBucket, filter: LookupResultFilter): boolean {
  if (filter.bucket && bucket !== filter.bucket) return false;
  if (filter.worksheet && normalize(tradesman.sourceWorksheet) !== normalize(filter.worksheet)) return false;
  if (filter.licenseType && normalize(tradesman.licenseType) !== normalize(filter.licenseType)) return false;
  if (filter.trade && normalize(tradesman.trade) !== normalize(filter.trade)) return false;
  if (filter.reasonContains && !normalize(tradesman.notSendReason).includes(normalize(filter.reasonContains))) return false;
  return true;
}

function increment(counts: Record<string, number>, value: string | undefined): void {
  const key = value?.trim() || "(blank)";
  counts[key] = (counts[key] ?? 0) + 1;
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim();
}
