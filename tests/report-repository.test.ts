import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PipelineStore } from "../src/pipeline-store.js";
import { buildOutputPaths } from "../src/paths.js";
import { ReportRepository } from "../src/report-repository.js";

describe("ReportRepository", () => {
  it("summarizes lookup results by bucket and dimensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-report-"));
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const store = new PipelineStore(outputPaths);
    const reports = new ReportRepository(outputPaths);

    await store.initialize();
    await store.appendLookupResult({
      bucket: "send",
      tradesman: {
        workItemId: 1,
        licenseNumber: "EL-1",
        sourceWorksheet: "Electricians",
        licenseType: "EL",
        trade: "Journey Level Electrician"
      }
    });
    await store.appendLookupResult({
      bucket: "doNotSend",
      tradesman: {
        workItemId: 2,
        licenseNumber: "PL-1",
        sourceWorksheet: "Plumbers",
        licenseType: "PL",
        trade: "Plumber",
        notSendReason: "Already renewed"
      }
    });
    await store.appendLookupResult({
      bucket: "doNotSend",
      tradesman: {
        workItemId: 3,
        licenseNumber: "PL-2",
        sourceWorksheet: "Plumbers",
        licenseType: "PL",
        trade: "Plumber",
        notSendReason: "Already renewed"
      }
    });

    await expect(reports.summary()).resolves.toEqual({
      total: 3,
      send: 1,
      doNotSend: 2,
      byWorksheet: {
        Electricians: 1,
        Plumbers: 2
      },
      byLicenseType: {
        EL: 1,
        PL: 2
      },
      byTrade: {
        "Journey Level Electrician": 1,
        Plumber: 2
      },
      byReason: {
        "Already renewed": 2
      }
    });
  });

  it("filters lookup results for browser reporting and exports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "license-report-"));
    const outputPaths = buildOutputPaths(dir, new Date(2026, 6, 6));
    const store = new PipelineStore(outputPaths);
    const reports = new ReportRepository(outputPaths);

    await store.initialize();
    await store.appendLookupResult({
      bucket: "send",
      tradesman: {
        workItemId: 1,
        licenseNumber: "EL-1",
        sourceWorksheet: "Electricians",
        licenseType: "EL"
      }
    });
    await store.appendLookupResult({
      bucket: "doNotSend",
      tradesman: {
        workItemId: 2,
        licenseNumber: "PL-1",
        sourceWorksheet: "Plumbers",
        licenseType: "PL",
        notSendReason: "Not active"
      }
    });

    await expect(reports.listTradesmen({ bucket: "send" })).resolves.toEqual([
      expect.objectContaining({ licenseNumber: "EL-1" })
    ]);
    await expect(reports.listTradesmen({ worksheet: "plumbers", reasonContains: "active" })).resolves.toEqual([
      expect.objectContaining({ licenseNumber: "PL-1" })
    ]);
  });
});
