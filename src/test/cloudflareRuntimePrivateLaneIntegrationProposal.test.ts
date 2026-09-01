import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const workerPath = resolve(root, "cloudflare/workers/middleware-runtime-executor/src/worker.ts");
describe("private catalog/outbound central integration", () => {
  it("wires only the reviewed catalog lane and keeps generic outbound disconnected", async () => {
    const worker = await readFile(workerPath, "utf8");

    expect(worker).toContain("RUNTIME_CATALOG_EXECUTION_ENABLED");
    expect(worker).toContain("RUNTIME_CATALOG_APPLY_ENABLED");
    expect(worker).toContain("createPrivateCatalogLaneExecutor");
    expect(worker).toContain("createAgoraCatalogPlanApplyAndReadbackPort");
    expect(worker).toContain('"OUTBOUND_EXCLUSIVE_QUEUE_NOT_CONFIGURED"');
    expect(worker).not.toContain("createPrivateOutboundLaneExecutor");
  });
});
