import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import ExcelJS from "exceljs";
import { emailConfigured, emailRunResults } from "./email.js";
import { runWashingtonCheck } from "./runner.js";
import type { OutputPaths, ProgressUpdate } from "./types.js";
import type { FileLink } from "./web-page-types.js";

export interface UploadedWorkbook {
  id: string;
  path: string;
  originalName: string;
  worksheets: string[];
}

export interface WebRun {
  id: string;
  status: "running" | "complete" | "canceled" | "error";
  outputDir: string;
  events: ProgressUpdate[];
  clients: Set<ServerResponse>;
  cancelRequested: boolean;
  outputPaths?: OutputPaths;
  error?: string;
}

export interface RunStartOptions {
  worksheet?: string;
  headed: boolean;
  checkDelayMs: number;
  limit?: number;
}

export interface PreviousRunSummary {
  id: string;
  createdAt: string;
  files: Record<string, FileLink>;
}

export interface RunPurgeResult {
  deleted: string[];
  retained: number;
}

export class WebRunManager {
  private readonly uploads = new Map<string, UploadedWorkbook>();
  private readonly runs = new Map<string, WebRun>();

  constructor(private readonly rootDir: string) {}

  async saveUploadedWorkbook(originalName: string, content: Buffer): Promise<UploadedWorkbook> {
    const uploadId = this.createRunFolderName();
    const uploadDir = join(this.rootDir, uploadId);
    const inputPath = join(uploadDir, "ListToCheck.xlsx");
    await mkdir(uploadDir, { recursive: true });
    await writeFile(inputPath, content);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);
    const uploaded: UploadedWorkbook = {
      id: uploadId,
      path: inputPath,
      originalName,
      worksheets: workbook.worksheets.map((worksheet) => worksheet.name)
    };
    this.uploads.set(uploadId, uploaded);
    return uploaded;
  }

  getUpload(uploadId: string | undefined): UploadedWorkbook | undefined {
    return uploadId ? this.uploads.get(uploadId) : undefined;
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  startRun(
    upload: UploadedWorkbook,
    options: RunStartOptions,
    baseUrl: string,
    onFinished?: (run: WebRun) => void
  ): WebRun {
    const runId = upload.id;
    const outputDir = join(dirname(upload.path), "output");
    const run: WebRun = {
      id: runId,
      status: "running",
      outputDir,
      events: [],
      clients: new Set(),
      cancelRequested: false
    };
    this.runs.set(runId, run);

    void runWashingtonCheck({
      input: upload.path,
      outDir: outputDir,
      worksheet: options.worksheet,
      headed: options.headed,
      slowMo: 0,
      checkDelayMs: options.checkDelayMs,
      limit: options.limit,
      onProgress: (update) => this.emit(run, update),
      isCanceled: () => run.cancelRequested
    })
      .then(async (result) => {
        run.status = result.canceled ? "canceled" : "complete";
        run.outputPaths = result.outputPaths;
        await this.maybeEmailResults(run, result, baseUrl);
        this.emit(run, {
          type: result.canceled ? "run_canceled" : "run_complete",
          message: result.canceled ? "Run stopped. Partial output files are ready." : "Run complete. Output files are ready.",
          files: this.fileLinks(run.id, result.outputPaths)
        });
        this.closeClients(run);
      })
      .catch((error) => {
        run.status = "error";
        run.error = error instanceof Error ? error.message : String(error);
        this.emit(run, { type: "run_error", message: run.error });
        this.closeClients(run);
      })
      .finally(() => {
        onFinished?.(run);
      });

    return run;
  }

  cancelRun(runId: string): { found: false } | { found: true; status: WebRun["status"] | "cancel_requested" } {
    const run = this.runs.get(runId);
    if (!run) return { found: false };

    if (run.status !== "running") {
      return { found: true, status: run.status };
    }

    run.cancelRequested = true;
    this.emit(run, {
      type: "cancel_requested",
      message: "Stop requested. The current website check will finish, then the run will stop before the next license."
    });
    return { found: true, status: "cancel_requested" };
  }

  connectEvents(runId: string, response: ServerResponse, writeEvent: (response: ServerResponse, update: ProgressUpdate) => void): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;

    for (const event of run.events) {
      writeEvent(response, event);
    }

    if (run.status === "running") {
      run.clients.add(response);
      response.on("close", () => run.clients.delete(response));
    } else {
      response.end();
    }

    return true;
  }

  async deleteRun(runId: string): Promise<"deleted" | "invalid" | "missing" | "running"> {
    const run = this.runs.get(runId);
    if (run?.status === "running") return "running";

    const runDir = this.runDirectory(runId);
    if (!runDir) return "invalid";

    try {
      const folderStat = await stat(runDir);
      if (!folderStat.isDirectory()) return "missing";
    } catch {
      return "missing";
    }

    await rm(runDir, { recursive: true, force: true });
    this.runs.delete(runId);
    this.uploads.delete(runId);
    return "deleted";
  }

  async outputPathsForRun(runId: string): Promise<OutputPaths | undefined> {
    const run = this.runs.get(runId);
    if (run?.outputPaths) return run.outputPaths;

    const runDir = this.runDirectory(runId);
    if (!runDir) return undefined;

    const outputDir = join(runDir, "output");
    const files = await this.filesInDirectory(outputDir);
    const send = files.find((file) => /^Send-.+\.xlsx$/i.test(file));
    const doNotSend = files.find((file) => /^DoNotSend-.+\.xlsx$/i.test(file));

    if (!send || !doNotSend) return undefined;

    return {
      sendPath: join(outputDir, send),
      doNotSendPath: join(outputDir, doNotSend),
      coursesAlreadyTakenPath: join(outputDir, "coursesAlreadyTaken.xlsx"),
      expiredLogPath: join(outputDir, "expired.txt"),
      greaterThan90LogPath: join(outputDir, "greaterThan90.txt"),
      exceptionLogPath: join(outputDir, "exception.txt"),
      timingLogPath: join(outputDir, "timings.txt")
    };
  }

  async listPreviousRuns(): Promise<PreviousRunSummary[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const summaries: PreviousRunSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const outputPaths = await this.outputPathsForRun(entry.name);
      if (!outputPaths) continue;

      const runDir = this.runDirectory(entry.name);
      if (!runDir) continue;

      const folderStat = await stat(runDir);
      summaries.push({
        id: entry.name,
        createdAt: folderStat.birthtime.toLocaleString(),
        files: this.previousRunFileLinks(entry.name, outputPaths)
      });
    }

    return summaries.sort((a, b) => b.id.localeCompare(a.id));
  }

  pathForFileKey(outputPaths: OutputPaths, fileKey: string): string | undefined {
    const files: Record<string, string> = {
      send: outputPaths.sendPath,
      doNotSend: outputPaths.doNotSendPath,
      coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath,
      expired: outputPaths.expiredLogPath,
      greaterThan90: outputPaths.greaterThan90LogPath,
      exception: outputPaths.exceptionLogPath
    };
    return files[fileKey];
  }

  activeRunExists(): boolean {
    return [...this.runs.values()].some((run) => run.status === "running");
  }

  async purgeOldRuns(retentionCount: number): Promise<RunPurgeResult> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const candidates: Array<{ name: string; path: string; runTime: number }> = [];
    const deleted: string[] = [];
    let running = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const run = this.runs.get(entry.name);
      if (run?.status === "running") {
        running++;
        continue;
      }

      const runDir = this.runDirectory(entry.name);
      if (!runDir) {
        continue;
      }

      let folderStat;
      try {
        folderStat = await stat(runDir);
      } catch {
        continue;
      }

      const runDate = parseRunFolderDate(entry.name) ?? folderStat.birthtime;
      candidates.push({ name: entry.name, path: runDir, runTime: runDate.getTime() });
    }

    candidates.sort((a, b) => b.runTime - a.runTime || b.name.localeCompare(a.name));
    const retained = Math.min(candidates.length, retentionCount) + running;

    for (const candidate of candidates.slice(retentionCount)) {
      await rm(candidate.path, { recursive: true, force: true });
      this.runs.delete(candidate.name);
      this.uploads.delete(candidate.name);
      deleted.push(candidate.name);
    }

    return { deleted, retained };
  }

  private async maybeEmailResults(
    run: WebRun,
    result: Awaited<ReturnType<typeof runWashingtonCheck>>,
    baseUrl: string
  ): Promise<void> {
    if (!emailConfigured()) {
      this.emit(run, {
        type: "email_skipped",
        message: "Email results skipped because SMTP settings are not configured."
      });
      return;
    }

    this.emit(run, {
      type: "email_sending",
      message: "Emailing results."
    });

    try {
      await emailRunResults({
        outputPaths: result.outputPaths,
        runId: run.id,
        baseUrl,
        canceled: result.canceled,
        sendCount: result.sendCount,
        doNotSendCount: result.doNotSendCount,
        courseFrequencyCount: result.courseFrequencyCount
      });
      this.emit(run, {
        type: "email_sent",
        message: "Email results sent."
      });
    } catch (error) {
      this.emit(run, {
        type: "email_error",
        message: `Email results could not be sent: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private emit(run: WebRun, update: ProgressUpdate): void {
    run.events.push(update);
    for (const client of run.clients) {
      writeSseEvent(client, update);
    }
  }

  private closeClients(run: WebRun): void {
    for (const client of run.clients) {
      client.end();
    }
    run.clients.clear();
  }

  private fileLinks(runId: string, outputPaths: OutputPaths): Record<string, string> {
    return Object.fromEntries(
      Object.entries({
        send: outputPaths.sendPath,
        doNotSend: outputPaths.doNotSendPath,
        coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath,
        expired: outputPaths.expiredLogPath,
        greaterThan90: outputPaths.greaterThan90LogPath,
        exception: outputPaths.exceptionLogPath
      }).map(([key]) => [key, `/runs/${runId}/files/${key}`])
    );
  }

  private previousRunFileLinks(runId: string, outputPaths: OutputPaths): Record<string, FileLink> {
    return Object.fromEntries(
      Object.entries({
        send: outputPaths.sendPath,
        doNotSend: outputPaths.doNotSendPath,
        coursesAlreadyTaken: outputPaths.coursesAlreadyTakenPath,
        expired: outputPaths.expiredLogPath,
        greaterThan90: outputPaths.greaterThan90LogPath,
        exception: outputPaths.exceptionLogPath
      }).map(([key, path]) => [key, { href: `/runs/${runId}/files/${key}`, label: basename(path) }])
    );
  }

  private runDirectory(runId: string): string | undefined {
    if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..") return undefined;

    const directory = resolve(this.rootDir, runId);
    const relativePath = relative(this.rootDir, directory);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;

    return directory;
  }

  private async filesInDirectory(path: string): Promise<string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private createRunFolderName(date = new Date()): string {
    const stamp = [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join("-");

    if (!this.uploads.has(stamp) && !this.runs.has(stamp)) {
      return stamp;
    }

    for (let counter = 2; ; counter++) {
      const candidate = `${stamp}-${counter}`;
      if (!this.uploads.has(candidate) && !this.runs.has(candidate)) {
        return candidate;
      }
    }
  }
}

export function writeSseEvent(response: ServerResponse, update: ProgressUpdate): void {
  response.write(`data: ${JSON.stringify(update)}\n\n`);
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function parseRunFolderDate(runId: string): Date | undefined {
  const match = runId.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/);
  if (!match) return undefined;

  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );

  return Number.isNaN(date.getTime()) ? undefined : date;
}
