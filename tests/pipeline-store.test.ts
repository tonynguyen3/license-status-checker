import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PipelineStore } from "../src/pipeline-store.js";
import { buildOutputPaths } from "../src/paths.js";

describe("PipelineStore", () => {
  it("persists queued work items and lookup results as durable JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const store = new PipelineStore(outputPaths);

    await store.initialize();
    await store.appendWorkItem({
      id: 1,
      status: "queued",
      createdAt: "2026-07-06T00:00:00.000Z",
      tradesman: {
        workItemId: 1,
        licenseNumber: "EL-1",
        sourceLocation: "Electricians!2"
      }
    });
    await store.appendLookupResult({
      bucket: "doNotSend",
      tradesman: {
        workItemId: 1,
        licenseNumber: "EL-1",
        notSendReason: "Already renewed"
      }
    });
    await store.writeCourseFrequencies([{ courseName: "Code Update", courseCode: "CE1", frequency: 2 }]);

    await expect(store.readWorkItems()).resolves.toEqual([
      expect.objectContaining({
        id: 1,
        tradesman: expect.objectContaining({ licenseNumber: "EL-1" })
      })
    ]);
    await expect(store.readLookupResults()).resolves.toEqual([
      expect.objectContaining({
        bucket: "doNotSend",
        workItemId: 1,
        tradesman: expect.objectContaining({ notSendReason: "Already renewed" })
      })
    ]);
    await expect(store.readCourseFrequencies()).resolves.toEqual([
      { courseName: "Code Update", courseCode: "CE1", frequency: 2 }
    ]);
  });
});
