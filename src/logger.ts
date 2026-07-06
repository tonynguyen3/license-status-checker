import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export class Logger {
  logStart(): void {
    console.log(`The program started at ${new Date().toLocaleString()}.`);
  }

  logEnd(): void {
    console.log("The check has been completed.");
    console.log(`The program successfully completed at ${new Date().toLocaleString()}.`);
  }

  writeToConsole(message: string): void {
    console.log(message);
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
