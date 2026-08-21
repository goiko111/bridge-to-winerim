import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("supabase/functions/agora-proxy/index.ts", "utf8");

// Regression: Agora rejects <Product><SaleFormats> with HTTP 500
// ("El elemento 'Product' tiene un elemento secundario 'SaleFormats' no valido").
// The accepted contract is <AdditionalSaleFormats><SaleFormat .../></AdditionalSaleFormats>.
describe("VINOTECA native formats XML contract", () => {
  it("emits AdditionalSaleFormats and never a SaleFormats node", () => {
    expect(SOURCE).toContain("<AdditionalSaleFormats>");
    expect(SOURCE).toContain("</AdditionalSaleFormats>");
    expect(SOURCE).toContain("<SaleFormat Id=");
    expect(SOURCE).not.toContain("<SaleFormats>");
    expect(SOURCE).not.toContain("</SaleFormats>");
  });

  it("keeps deterministic SaleFormatId, prices and preparation ids inside the formats", () => {
    const block = SOURCE.slice(
      SOURCE.indexOf("<AdditionalSaleFormats>"),
      SOURCE.indexOf("</AdditionalSaleFormats>") + 30,
    );
    expect(block).toContain('Id="${format.agoraId}"');
    expect(block).toContain("format.salePrice.toFixed(2)");
    expect(block).toContain('PreparationTypeId="${VINOTECA_PREPARATION_TYPE_ID}"');
    expect(block).toContain('PreparationOrderId="${VINOTECA_PREPARATION_ORDER_ID}"');
  });

  it("keeps the base BOTTLE product child order Prices then CostPrices then formats", () => {
    const product = SOURCE.slice(
      SOURCE.indexOf('<Product Id="${plan.productId}"'),
      SOURCE.indexOf("${saleFormatsXml}    </Product>") + 40,
    );
    expect(product.indexOf("<Prices>")).toBeGreaterThan(-1);
    expect(product.indexOf("<CostPrices>")).toBeGreaterThan(product.indexOf("<Prices>"));
    expect(product.indexOf("${saleFormatsXml}")).toBeGreaterThan(product.indexOf("<CostPrices>"));
  });

  it("stays gated by the Don Bernardo allowlist", () => {
    expect(SOURCE).toContain("isVinotecaNativeFormatsConnection(connection.id, providerConfig)");
  });
});
