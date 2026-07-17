import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);

describe("Agora queued product naming", () => {
  it("uses the current Agora catalog instead of stale mapping names", () => {
    expect(source).toContain("const namingCatalog = await fetchAgoraProductsXmlCached");
    expect(source).toContain('extractXmlElementsWithAttrs(namingCatalog.xml, "Product")');
    expect(source).toContain("masterData.products_summary_json = [...namingProductsById.values()]");
    expect(source).not.toContain("sameNameMappings");
    expect(source).not.toContain("ownProductMappings");
  });

  it("resolves queued names with every active homonymous Winerim wine", () => {
    expect(source).toContain("const queuedProductNameOverrides = buildQueuedProductNameOverrides");
    expect(source).toContain('.eq("name", wineArr[0].name)');
    expect(source).toContain("queuedProductNameOverrides,");
  });

  it("persists the exact product name sent in XML", () => {
    expect(source).toContain("const sentNameMatch = new RegExp");
    expect(source).toContain("decodeXmlAttribute(sentNameMatch[1])");
    expect(source).toContain("provider_product_name: productName");
  });

  it("builds audit expectations from the forced fresh Agora catalog", () => {
    const auditStart = source.indexOf('if (action === "audit-winerim-products")');
    const freshCatalog = source.indexOf("const actualCatalogProducts =", auditStart);
    const expectedXml = source.indexOf("const { xml: expectedXml, validationResults }", auditStart);

    expect(auditStart).toBeGreaterThan(-1);
    expect(freshCatalog).toBeGreaterThan(auditStart);
    expect(expectedXml).toBeGreaterThan(freshCatalog);
    expect(source.slice(auditStart, expectedXml)).toContain(
      "masterData.products_summary_json = actualCatalogProducts.map",
    );
  });

  it("uses deterministic per-connection product ids throughout queue processing", () => {
    const processStart = source.indexOf('if (action === "process-xml-outbound-task")');
    const processEnd = source.indexOf("// ── QUEUE XML OUTBOUND TASKS", processStart);
    const processSource = source.slice(processStart, processEnd);

    expect(processSource).toContain("const productIdByFormat = Object.fromEntries");
    expect(processSource).toContain("deterministicAgoraProductId(connection, wineArr[0], fmt)");
    expect(processSource).not.toContain("500000 + Number(winerimWineId");
    expect(processSource).not.toContain("700000 + Number(winerimWineId");
    expect(processSource).not.toContain("900000 + Number(winerimWineId");
  });

  it("parses generated Product XML regardless of attribute order", () => {
    expect(source).toContain('const preSendProductRegex = /<Product\\b[^>]*\\bId=');
    expect(source).toContain('const productBlockRegex = /<Product\\b[^>]*\\bId=');
    expect(source).toContain('const famRegex = /<Product\\b[^>]*\\bId=');
  });
});
