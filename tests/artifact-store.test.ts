import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FilesystemArtifactStore } from "../src/artifact-store.js";

describe("FilesystemArtifactStore", () => {
  it("saves, copies, lists, and deletes run artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "license-artifacts-"));
    const store = new FilesystemArtifactStore(rootDir);

    const saved = await store.saveInputWorkbook("2026-07-10-10-00-00", "input.xlsx", Buffer.from("workbook"));
    expect(saved.path).toContain("ListToCheck.xlsx");
    await expect(store.fileExists(saved.path)).resolves.toBe(true);
    await expect(store.listRunIds()).resolves.toEqual(["2026-07-10-10-00-00"]);

    const copied = await store.copyInputWorkbook("2026-07-10-10-00-00", "2026-07-10-10-01-00", "Resume");
    expect(copied?.originalName).toBe("Resume");
    await expect(store.fileExists(copied?.path ?? "")).resolves.toBe(true);
    await expect(store.listRunIds()).resolves.toEqual(["2026-07-10-10-00-00", "2026-07-10-10-01-00"]);

    await expect(store.deleteRun("2026-07-10-10-00-00")).resolves.toBe(true);
    await expect(store.fileExists(saved.path)).resolves.toBe(false);
  });

  it("reconstructs output paths from saved report artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "license-artifacts-"));
    const store = new FilesystemArtifactStore(rootDir);
    await store.saveInputWorkbook("2026-07-10-10-00-00", "input.xlsx", Buffer.from("workbook"));
    const outputDir = store.outputDirForRun("2026-07-10-10-00-00");
    if (!outputDir) throw new Error("Expected output directory.");

    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "Send-2026-07-10.xlsx"), "");
    await writeFile(join(outputDir, "DoNotSend-2026-07-10.xlsx"), "");

    await expect(store.outputPathsForRun("2026-07-10-10-00-00")).resolves.toEqual(expect.objectContaining({
      sendPath: join(outputDir, "Send-2026-07-10.xlsx"),
      doNotSendPath: join(outputDir, "DoNotSend-2026-07-10.xlsx"),
      lookupResultsPath: join(outputDir, "lookup-results.jsonl")
    }));
  });

  it("rejects unsafe run ids", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "license-artifacts-"));
    const store = new FilesystemArtifactStore(rootDir);

    expect(store.runDirectory("../outside")).toBeUndefined();
    await expect(store.copyInputWorkbook("../outside", "safe", "Resume")).resolves.toBeUndefined();
  });
});
