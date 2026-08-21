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

  it("keeps the exact accepted BOTTLE child order and StorageOptions contract", () => {
    const product = SOURCE.slice(
      SOURCE.indexOf('<Product Id="${plan.productId}"'),
      SOURCE.indexOf("    </Product>`;", SOURCE.indexOf('<Product Id="${plan.productId}"')),
    );
    const barcodes = product.indexOf("<Barcodes />");
    const prices = product.indexOf("<Prices>");
    const storage = product.indexOf("<StorageOptions>");
    const formats = product.indexOf("${saleFormatsXml}");
    const costs = product.indexOf("<CostPrices>");

    expect(barcodes).toBeGreaterThan(-1);
    expect(prices).toBeGreaterThan(barcodes);
    expect(storage).toBeGreaterThan(prices);
    expect(formats).toBeGreaterThan(storage);
    expect(costs).toBeGreaterThan(formats);
    expect(product).toContain(
      '<StorageOption WarehouseId="1" Location="" MinStock="0.00" MaxStock="0.00" />',
    );
  });

  it("stays gated by the Don Bernardo allowlist", () => {
    expect(SOURCE).toContain("isVinotecaNativeFormatsConnection(connection.id, providerConfig)");
  });
});
