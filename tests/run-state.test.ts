import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOutputPaths } from "../src/paths.js";
import { RunStateWriter, type DurableRunState } from "../src/run-state.js";

describe("RunStateWriter", () => {
  it("persists progress, checkpoints, and final output paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const writer = new RunStateWriter(outputPaths.runStatePath);

    await writer.writeInitial();
    await writer.recordProgress({
      type: "spreadsheet_complete",
      message: "Spreadsheet read complete. 2 license(s) are eligible for website checks.",
      current: 10,
      total: 2
    });
    await writer.recordResult("send", {
      licenseNumber: "EL-1"
    });
    await writer.recordFinal({
      canceled: false,
      outputPaths
    });

    const state = JSON.parse(await readFile(outputPaths.runStatePath, "utf8")) as DurableRunState;

    expect(state.phase).toBe("complete");
    expect(state.counts.spreadsheetRowsRead).toBe(10);
    expect(state.counts.eligible).toBe(2);
    expect(state.counts.checked).toBe(1);
    expect(state.counts.send).toBe(1);
    expect(state.checkpoint?.licenseNumber).toBe("EL-1");
    expect(state.files?.send).toBe(outputPaths.sendPath);
    expect(state.files?.runState).toBe(outputPaths.runStatePath);
  });
});
