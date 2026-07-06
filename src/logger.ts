import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProgressReporter } from "./types.js";

export class Logger {
  constructor(private readonly onProgress?: ProgressReporter) {}

  logStart(): void {
    const message = `The program started at ${new Date().toLocaleString()}.`;
    console.log(message);
    this.onProgress?.({ type: "start", message });
  }

  logEnd(): void {
    const completedMessage = "The check has been completed.";
    const endMessage = `The program successfully completed at ${new Date().toLocaleString()}.`;
    console.log(completedMessage);
    console.log(endMessage);
    this.onProgress?.({ type: "complete", message: completedMessage });
    this.onProgress?.({ type: "end", message: endMessage });
  }

  writeToConsole(message: string): void {
    console.log(message);
    this.onProgress?.({ type: "message", message });
  }

  async writeErrorsToLog(message: string, path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const entry = [
      "",
      `Log Entry : ${new Date().toLocaleString()}`,
      message,
      "-------------------------------",
      ""
    ].join("\n");

    await appendFile(path, entry, "utf8");
  }
}
