import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { findInputWorkbookEmail, imapConfigured } from "./imap-input.js";
import type { WebRunManager } from "./web-runs.js";

export interface EmailPollConfig {
  enabled: boolean;
  time?: string;
  worksheet?: string;
  headed: boolean;
  checkDelayMs: number;
  limit?: number;
  baseUrl: string;
}

export interface EmailPollStatus {
  enabled: boolean;
  scheduledTime?: string;
  nextCheckAt?: string;
  lastCheckedAt?: string;
  lastResult?: string;
  lastRunId?: string;
  running: boolean;
  logPath: string;
}

export class EmailPollScheduler {
  private readonly state: EmailPollStatus;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: {
      logPath: string;
      port: number;
      webRuns: WebRunManager;
    }
  ) {
    this.state = {
      enabled: false,
      running: false,
      logPath: options.logPath
    };
  }

  status(): EmailPollStatus {
    return this.state;
  }

  startFromEnvironment(): void {
    const config = this.config();

    if (!config.enabled) {
      this.state.enabled = false;
      this.state.scheduledTime = config.time;
      void this.log("Scheduled email polling is disabled.");
      return;
    }

    void this.enable(config);
  }

  async enable(config = { ...this.config(), enabled: true }): Promise<{ ok: true } | { ok: false; error: string }> {
    this.stopTimer();
    this.state.enabled = true;
    this.state.scheduledTime = config.time;
    this.state.nextCheckAt = undefined;

    if (!imapConfigured()) {
      this.state.enabled = false;
      this.state.lastResult = "IMAP settings are not configured.";
      await this.log("Scheduled email polling is enabled, but IMAP settings are not configured.");
      return { ok: false, error: this.state.lastResult };
    }

    if (!config.time) {
      this.state.enabled = false;
      this.state.lastResult = "EMAIL_POLL_TIME is not configured.";
      await this.log("Scheduled email polling is enabled, but EMAIL_POLL_TIME is not configured.");
      return { ok: false, error: this.state.lastResult };
    }

    try {
      this.scheduleNext(config);
      this.state.lastResult = `Scheduled email polling enabled for ${config.time}.`;
      await this.log(this.state.lastResult);
      return { ok: true };
    } catch (error) {
      this.state.enabled = false;
      this.state.lastResult = error instanceof Error ? error.message : String(error);
      await this.log(this.state.lastResult);
      return { ok: false, error: this.state.lastResult };
    }
  }

  async disable(message: string): Promise<void> {
    this.stopTimer();
    this.state.enabled = false;
    this.state.nextCheckAt = undefined;
    this.state.lastResult = message;
    await this.log(message);
  }

  config(): EmailPollConfig {
    const time = process.env.EMAIL_POLL_TIME?.trim();
    const enabled = process.env.EMAIL_POLL_ENABLED === undefined
      ? Boolean(time)
      : parseBoolean(process.env.EMAIL_POLL_ENABLED);
    const limit = Number(process.env.EMAIL_POLL_LIMIT);
    const checkDelayMs = Number(process.env.EMAIL_POLL_CHECK_DELAY_MS ?? 3000);

    return {
      enabled,
      time,
      worksheet: process.env.EMAIL_POLL_WORKSHEET || undefined,
      headed: parseBoolean(process.env.EMAIL_POLL_HEADED),
      checkDelayMs: Number.isFinite(checkDelayMs) && checkDelayMs >= 0 ? checkDelayMs : 3000,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      baseUrl: process.env.EMAIL_BASE_URL ?? `http://localhost:${this.options.port}`
    };
  }

  private scheduleNext(config: EmailPollConfig): void {
    if (!config.time) return;

    this.stopTimer();
    const nextCheck = nextDailyCheckAt(config.time);
    this.state.nextCheckAt = nextCheck.toISOString();
    const delayMs = Math.max(0, nextCheck.getTime() - Date.now());
    this.timer = setTimeout(() => {
      void this.run(config).finally(() => {
        if (this.state.enabled) {
          this.scheduleNext(config);
        }
      });
    }, delayMs);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async run(config: EmailPollConfig): Promise<void> {
    if (this.state.running) return;

    this.state.running = true;
    this.state.lastCheckedAt = new Date().toISOString();
    await this.log(`Checking email for input workbook at scheduled time ${config.time}.`);

    try {
      if (this.options.webRuns.activeRunExists()) {
        this.state.lastResult = "Skipped because a run is already active.";
        await this.log(this.state.lastResult);
        return;
      }

      const workbook = await findInputWorkbookEmail();
      if (!workbook) {
        this.state.lastResult = "No matching unread email input workbook found.";
        await this.log(this.state.lastResult);
        return;
      }

      const uploaded = await this.options.webRuns.saveUploadedWorkbook(workbook.filename, workbook.content);
      const run = this.options.webRuns.startRun(
        uploaded,
        {
          worksheet: config.worksheet,
          headed: config.headed,
          checkDelayMs: config.checkDelayMs,
          limit: config.limit
        },
        config.baseUrl,
        (finishedRun) => {
          void this.log(`Run ${finishedRun.id} finished with status ${finishedRun.status}.`);
        }
      );

      this.state.lastRunId = run.id;
      this.state.lastResult = `Found ${workbook.filename} and started run ${run.id}.`;
      await this.log(`${this.state.lastResult} Subject: ${workbook.subject ?? "(no subject)"}.`);
    } catch (error) {
      this.state.lastResult = `Email poll failed: ${error instanceof Error ? error.message : String(error)}`;
      await this.log(this.state.lastResult);
    } finally {
      this.state.running = false;
    }
  }

  private async log(message: string): Promise<void> {
    await mkdir(dirname(this.options.logPath), { recursive: true });
    const line = `${new Date().toLocaleString()} ${message}\n`;
    await appendFile(this.options.logPath, line, "utf8");
    console.log(`[email-poll] ${message}`);
  }
}

export function nextDailyCheckAt(time: string, now = new Date()): Date {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`EMAIL_POLL_TIME must use HH:MM format, got: ${time}`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`EMAIL_POLL_TIME must use HH:MM format, got: ${time}`);
  }

  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}
