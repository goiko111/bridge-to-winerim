import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const workerPath = resolve(root, "cloudflare/workers/middleware-runtime-executor/src/worker.ts");
const proposalPath = resolve(
  root,
  "cloudflare/workers/middleware-runtime-executor/src/catalog-outbound.worker.patch",
);

describe("private catalog/outbound central integration proposal", () => {
  it("leaves worker.ts untouched and proposes only opt-in, dependency-injected routing", async () => {
    const [worker, proposal] = await Promise.all([
      readFile(workerPath, "utf8"),
      readFile(proposalPath, "utf8"),
    ]);

    expect(worker).not.toContain("RUNTIME_CATALOG_EXECUTION_ENABLED");
    expect(worker).not.toContain("RUNTIME_OUTBOUND_EXECUTION_ENABLED");
    expect(worker).not.toContain("routePrivateLanes");
    expect(proposal).toContain("RUNTIME_CATALOG_EXECUTION_ENABLED");
    expect(proposal).toContain("RUNTIME_CATALOG_APPLY_ENABLED");
    expect(proposal).toContain("RUNTIME_OUTBOUND_EXECUTION_ENABLED");
    expect(proposal).toContain("RUNTIME_OUTBOUND_MUTATION_ENABLED");
    expect(proposal).toContain("dependencies.catalog ?? (() => null)");
    expect(proposal).toContain("dependencies.outbound ?? (() => null)");
    expect(proposal).toContain("Deliberately not applied");
  });
});
