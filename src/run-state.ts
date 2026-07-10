import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LicenseBucket, OutputPaths, ProgressUpdate, Tradesman } from "./types.js";

export type RunPhase = "created" | "reading" | "checking" | "writing_outputs" | "complete" | "canceled" | "error";

export interface DurableRunState {
  id?: string;
  phase: RunPhase;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  canceled: boolean;
  counts: {
    spreadsheetRowsRead: number;
    eligible: number;
    checked: number;
    send: number;
    doNotSend: number;
    errors: number;
  };
  checkpoint?: {
    licenseNumber?: string;
    bucket?: LicenseBucket;
    checkedAt?: string;
  };
  lastMessage?: string;
  files?: Record<string, string>;
  error?: string;
}

export class RunStateWriter {
  private readonly state: DurableRunState;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    const now = new Date().toISOString();
    this.state = {
      phase: "created",
      startedAt: now,
      updatedAt: now,
      canceled: false,
      counts: {
        spreadsheetRowsRead: 0,
        eligible: 0,
        checked: 0,
        send: 0,
        doNotSend: 0,
        errors: 0
      }
    };
  }

  async writeInitial(): Promise<void> {
    await this.write();
  }

  async recordProgress(update: ProgressUpdate): Promise<void> {
    this.state.lastMessage = update.message;

    if (update.type === "spreadsheet_loading" || update.type === "worksheet_started" || update.type === "spreadsheet_row") {
      this.state.phase = "reading";
    }

    if (update.type === "spreadsheet_row") {
      this.state.counts.spreadsheetRowsRead = update.current ?? this.state.counts.spreadsheetRowsRead;
    }

    if (update.type === "spreadsheet_complete") {
      this.state.phase = "checking";
      this.state.counts.spreadsheetRowsRead = update.current ?? this.state.counts.spreadsheetRowsRead;
      this.state.counts.eligible = update.total ?? this.state.counts.eligible;
    }

    if (update.type === "checks_started" || update.type === "checks_progress") {
      this.state.phase = "checking";
      this.state.counts.checked = update.current ?? this.state.counts.checked;
    }

    if (update.type === "rate_limited") {
      this.state.phase = "canceled";
      this.state.canceled = true;
      this.state.counts.checked = update.current ?? this.state.counts.checked;
    }

    if (update.type === "checks_canceled") {
      this.state.phase = "canceled";
      this.state.canceled = true;
      this.state.counts.checked = update.current ?? this.state.counts.checked;
    }

    if (update.type === "checks_complete") {
      this.state.phase = "writing_outputs";
      this.state.counts.checked = update.current ?? this.state.counts.checked;
    }

    if (update.files) {
      this.state.files = {
        ...this.state.files,
        ...update.files
      };
    }

    await this.write();
  }

  async recordResult(bucket: LicenseBucket, tradesman: Tradesman): Promise<void> {
    this.state.phase = "checking";
    this.state.counts.checked++;
    if (bucket === "send") {
      this.state.counts.send++;
    } else {
      this.state.counts.doNotSend++;
    }
    this.state.checkpoint = {
      licenseNumber: tradesman.licenseNumber,
      bucket,
      checkedAt: new Date().toISOString()
    };
    await this.write();
  }

  async recordFinal(result: { canceled: boolean; outputPaths: OutputPaths; error?: string }): Promise<void> {
    this.state.phase = result.error ? "error" : result.canceled ? "canceled" : "complete";
    this.state.canceled = result.canceled;
    this.state.completedAt = new Date().toISOString();
    this.state.files = {
      send: result.outputPaths.sendPath,
      doNotSend: result.outputPaths.doNotSendPath,
      coursesAlreadyTaken: result.outputPaths.coursesAlreadyTakenPath,
      expired: result.outputPaths.expiredLogPath,
      greaterThan90: result.outputPaths.greaterThan90LogPath,
      exception: result.outputPaths.exceptionLogPath,
      runState: result.outputPaths.runStatePath
    };
    this.state.error = result.error;
    await this.write();
  }

  private async write(): Promise<void> {
    const nextWrite = this.writeQueue.then(() => this.writeNow(), () => this.writeNow());
    this.writeQueue = nextWrite.catch(() => undefined);
    await nextWrite;
  }

  private async writeNow(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.path);
  }
}
