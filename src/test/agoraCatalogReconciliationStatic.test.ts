import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "scripts/reconcile-agora-catalog.mjs"),
  "utf8",
);

describe("Agora controlled catalog reconciliation", () => {
  it("releases occupied base names before assigning their final owners", () => {
    expect(source).toContain("const transitionPriority = (item) =>");
    expect(source).toContain('expectedName.startsWith(`${actualName} `)');
    expect(source).toContain('actualName.startsWith(`${expectedName} `)');
    expect(source).toContain("transitionPriority(left) - transitionPriority(right)");
  });

  it("verifies each batch against the full homonym-aware catalog audit", () => {
    expect(source).toContain("const fullBatchAudit = await invoke");
    expect(source).toContain("const batchWineIds = new Set(batch.map(String))");
    expect(source).toContain("const batchDetails = (fullBatchAudit.details || []).filter");
    expect(source).not.toContain("winerimWineIds: batch,\n          });\n          result.catalogBatches");
  });

  it("keeps direct XML batches explicit, bounded and freshly verified", () => {
    expect(source).toContain('--direct-xml-batches');
    expect(source).toContain('action, ...body');
    expect(source).toContain('const directResult = await invoke("xml-import"');
    expect(source).toContain('mode: "DIRECT_XML_BATCH"');
    expect(source).toContain('directResult?.verification?.success === false');
    expect(source).toContain('const fullBatchAudit = await invoke');
    expect(source).toContain('const directVerification = await invoke("verify-products"');
    expect(source).toContain('Direct XML final verification failed');
  });

  it("paginates mutable catalog state in a deterministic order", () => {
    expect(source).toContain("&order=winerim_id.asc");
    expect(source).toContain("&order=winerim_wine_id.asc,format.asc");
  });

  it("recovers legacy ownership only with canonical evidence or an explicit current override", () => {
    expect(source).toContain("--recover-legacy-prefix-ownership");
    expect(source).toContain("canonicalProductName(item.actualName, item.expectedFormat) === canonicalProductName(item.expectedName, item.expectedFormat)");
    expect(source).toContain("Ownership overrides did not match current unowned differences");
    expect(source).toContain("Ownership recovery conflict for Agora product");
  });
});
