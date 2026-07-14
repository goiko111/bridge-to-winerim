import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);

describe("Agora queued product naming", () => {
  it("merges recent confirmed mappings into a stale master-data snapshot", () => {
    expect(source).toContain("const baseProductNames = [...new Set");
    expect(source).toContain("const expectedProductIds = [...new Set");
    expect(source).toContain("sameNameMappings");
    expect(source).toContain("ownProductMappings");
    expect(source).toContain("masterData.products_summary_json = [...namingProductsById.values()]");
  });

  it("persists the exact product name sent in XML", () => {
    expect(source).toContain("const sentNameMatch = new RegExp");
    expect(source).toContain("decodeXmlAttribute(sentNameMatch[1])");
    expect(source).toContain("provider_product_name: productName");
  });
});
