import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PipelineStore } from "../src/pipeline-store.js";
import { buildOutputPaths } from "../src/paths.js";
import { regenerateReportsFromStore } from "../src/runner.js";
import { readTradesmenCsv, readTradesmenWorkbook } from "../src/spreadsheet.js";

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

  it("regenerates report files from stored lookup results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const store = new PipelineStore(outputPaths);

    await store.initialize();
    await store.appendLookupResult({
      bucket: "send",
      tradesman: {
        workItemId: 1,
        licenseNumber: "EL-SEND",
        name: "Sender"
      }
    });
    await store.appendLookupResult({
      bucket: "doNotSend",
      tradesman: {
        workItemId: 2,
        licenseNumber: "EL-NO",
        name: "Nope",
        notSendReason: "Already renewed"
      }
    });

    await expect(regenerateReportsFromStore(outputPaths)).resolves.toEqual({
      sendCount: 1,
      doNotSendCount: 1,
      courseFrequencyCount: 0,
      lookupResultCount: 2
    });
    await expect(readTradesmenCsv(outputPaths.sendCsvPath)).resolves.toEqual([
      expect.objectContaining({ licenseNumber: "EL-SEND" })
    ]);
    await expect(readTradesmenWorkbook(outputPaths.doNotSendPath)).resolves.toEqual([
      expect.objectContaining({ licenseNumber: "EL-NO", notSendReason: "Already renewed" })
    ]);
  });

  it("persists worker status, pause control, and a single worker lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const store = new PipelineStore(outputPaths);

    await store.initialize();
    await expect(store.readWorkerStatus()).resolves.toEqual({
      status: "queued",
      checked: 0,
      remaining: 0,
      errors: 0
    });

    await store.requestPause();
    expect(store.isPauseRequested()).toBe(true);

    await store.clearPause();
    expect(store.isPauseRequested()).toBe(false);

    await store.writeWorkerStatus({
      status: "running",
      pid: 123,
      startedAt: "2026-07-06T00:00:00.000Z",
      heartbeatAt: "2026-07-06T00:00:01.000Z",
      checked: 5,
      remaining: 10,
      errors: 1,
      message: "Working"
    });
    await expect(store.readWorkerStatus()).resolves.toEqual(expect.objectContaining({
      status: "running",
      checked: 5,
      remaining: 10,
      errors: 1,
      message: "Working"
    }));

    await store.acquireWorkerLock();
    await expect(store.acquireWorkerLock()).rejects.toThrow(/worker lock already exists/i);
    await store.releaseWorkerLock();
    await expect(store.acquireWorkerLock()).resolves.toBeUndefined();
    await store.releaseWorkerLock();
  });

  it("claims, completes, fails, and releases queued work items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-status-checker-"));
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const store = new PipelineStore(outputPaths);

    await store.initialize();
    await store.appendWorkItem({
      id: 1,
      status: "queued",
      createdAt: "2026-07-06T00:00:00.000Z",
      tradesman: { workItemId: 1, licenseNumber: "EL-1" }
    });
    await store.appendWorkItem({
      id: 2,
      status: "queued",
      createdAt: "2026-07-06T00:00:00.000Z",
      tradesman: { workItemId: 2, licenseNumber: "EL-2" }
    });

    const first = await store.claimNextWorkItem("worker-a");
    expect(first).toEqual(expect.objectContaining({
      id: 1,
      status: "in_progress",
      claimedBy: "worker-a",
      attempts: 1
    }));

    await store.completeWorkItem(1);
    await expect(store.readWorkItems()).resolves.toEqual([
      expect.objectContaining({ id: 1, status: "completed" }),
      expect.objectContaining({ id: 2, status: "queued" })
    ]);

    const second = await store.claimNextWorkItem("worker-a");
    expect(second?.id).toBe(2);
    await store.failWorkItem(2, "Website error");
    await expect(store.readWorkItems()).resolves.toEqual([
      expect.objectContaining({ id: 1, status: "completed" }),
      expect.objectContaining({ id: 2, status: "failed", lastError: "Website error" })
    ]);

    await expect(store.requeueFailedWorkItems(3)).resolves.toBe(1);
    await expect(store.readWorkItems()).resolves.toEqual([
      expect.objectContaining({ id: 1, status: "completed" }),
      expect.objectContaining({ id: 2, status: "queued", lastError: "Requeued failed work item for retry." })
    ]);
    await store.claimNextWorkItem("worker-a");
    await store.failWorkItem(2, "Website error again");
    await expect(store.requeueFailedWorkItems(2)).resolves.toBe(0);

    await store.appendWorkItem({
      id: 3,
      status: "queued",
      createdAt: "2026-07-06T00:00:00.000Z",
      tradesman: { workItemId: 3, licenseNumber: "EL-3" }
    });
    await store.claimNextWorkItem("worker-b");
    await expect(store.releaseStaleClaims(0)).resolves.toBe(1);
    await expect(store.readWorkItems()).resolves.toEqual([
      expect.objectContaining({ id: 1, status: "completed" }),
      expect.objectContaining({ id: 2, status: "failed" }),
      expect.objectContaining({ id: 3, status: "queued" })
    ]);
  });
});
