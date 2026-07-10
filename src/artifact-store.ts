import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildOutputPaths } from "./paths.js";
import type { OutputPaths } from "./types.js";

export interface StoredWorkbook {
  id: string;
  path: string;
  originalName: string;
}

export interface ArtifactStore {
  runDirectory(runId: string): string | undefined;
  inputPathForRun(runId: string): string | undefined;
  outputDirForRun(runId: string): string | undefined;
  outputPathsForRun(runId: string): Promise<OutputPaths | undefined>;
  saveInputWorkbook(runId: string, originalName: string, content: Buffer): Promise<StoredWorkbook>;
  copyInputWorkbook(sourceRunId: string, targetRunId: string, originalName: string): Promise<StoredWorkbook | undefined>;
  listRunIds(): Promise<string[]>;
  runCreatedAt(runId: string): Promise<Date | undefined>;
  fileExists(path: string): Promise<boolean>;
  directoryExists(path: string): Promise<boolean>;
  deleteRun(runId: string): Promise<boolean>;
}

export class FilesystemArtifactStore implements ArtifactStore {
  constructor(private readonly rootDir: string) {}

  runDirectory(runId: string): string | undefined {
    if (!isSafeRunId(runId)) return undefined;

    const directory = resolve(this.rootDir, runId);
    const rootWithSeparator = `${this.rootDir}${this.rootDir.endsWith("/") ? "" : "/"}`;
    if (directory !== this.rootDir && !directory.startsWith(rootWithSeparator)) return undefined;

    return directory;
  }

  inputPathForRun(runId: string): string | undefined {
    const runDir = this.runDirectory(runId);
    return runDir ? join(runDir, "ListToCheck.xlsx") : undefined;
  }

  outputDirForRun(runId: string): string | undefined {
    const runDir = this.runDirectory(runId);
    return runDir ? join(runDir, "output") : undefined;
  }

  async outputPathsForRun(runId: string): Promise<OutputPaths | undefined> {
    const outputDir = this.outputDirForRun(runId);
    if (!outputDir) return undefined;

    const files = await filesInDirectory(outputDir);
    const send = files.find((file) => /^Send-.+\.xlsx$/i.test(file));
    const doNotSend = files.find((file) => /^DoNotSend-.+\.xlsx$/i.test(file));

    if (!send || !doNotSend) return undefined;

    return {
      ...buildOutputPaths(outputDir),
      sendPath: join(outputDir, send),
      doNotSendPath: join(outputDir, doNotSend)
    };
  }

  async saveInputWorkbook(runId: string, originalName: string, content: Buffer): Promise<StoredWorkbook> {
    const inputPath = this.inputPathForRun(runId);
    if (!inputPath) {
      throw new Error(`Invalid run id: ${runId}`);
    }

    await mkdir(dirname(inputPath), { recursive: true });
    await writeFile(inputPath, content);

    return {
      id: runId,
      path: inputPath,
      originalName
    };
  }

  async copyInputWorkbook(sourceRunId: string, targetRunId: string, originalName: string): Promise<StoredWorkbook | undefined> {
    const sourceInputPath = this.inputPathForRun(sourceRunId);
    const targetInputPath = this.inputPathForRun(targetRunId);
    if (!sourceInputPath || !targetInputPath || !(await this.fileExists(sourceInputPath))) {
      return undefined;
    }

    await mkdir(dirname(targetInputPath), { recursive: true });
    await copyFile(sourceInputPath, targetInputPath);

    return {
      id: targetRunId,
      path: targetInputPath,
      originalName
    };
  }

  async listRunIds(): Promise<string[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && isSafeRunId(entry.name)).map((entry) => entry.name);
  }

  async runCreatedAt(runId: string): Promise<Date | undefined> {
    const runDir = this.runDirectory(runId);
    if (!runDir) return undefined;

    try {
      return (await stat(runDir)).birthtime;
    } catch {
      return undefined;
    }
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  async directoryExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  async deleteRun(runId: string): Promise<boolean> {
    const runDir = this.runDirectory(runId);
    if (!runDir || !(await this.directoryExists(runDir))) return false;

    await rm(runDir, { recursive: true, force: true });
    return true;
  }
}

function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId) && runId !== "." && runId !== "..";
}

async function filesInDirectory(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
