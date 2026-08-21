import { describe, expect, it } from "vitest";
import { buildVinotecaReferencePlan } from "../../supabase/functions/_shared/agoraVinotecaNativeFormats";
import { verifyVinotecaNativeFormatsImport } from "../../supabase/functions/_shared/agoraVinotecaPostImportVerify";

const PRICE_LISTS = [{ id: "13", name: "Sala" }, { id: "16", name: "Terraza" }];
const PL_TO_SC: Record<string, string[]> = { "13": ["1"], "16": ["2"] };

const plan = buildVinotecaReferencePlan({
  winerimWineId: 363449,
  wineName: "Vega Sicilia Unico",
  region: "RIBERA",
  bottleSalePrice: 26,
  bottleCostPrice: 12,
  glassSalePrice: 3.1,
  glassCostPrice: 1.2,
}).plan!;

function productXml(bottlePrice: string, glassPrice: string, opts: {
  saleFormatId?: string;
  prepTypeId?: string;
  ratio?: string;
  saleableAsMain?: string;
} = {}) {
  return `<Products>
    <Product Id="2363449" Name="Vega Sicilia Unico" FamilyId="950809" UseAsDirectSale="false" SaleableAsMain="${opts.saleableAsMain ?? "true"}" PreparationTypeId="${opts.prepTypeId ?? "6"}" PreparationOrderId="2" CostPrice="12.00">
      <Barcodes />
      <Prices>
        <Price PriceListId="13" MainPrice="${bottlePrice}" />
        <Price PriceListId="16" MainPrice="${bottlePrice}" />
      </Prices>
      <StorageOptions><StorageOption WarehouseId="1" Location="" MinStock="0.00" MaxStock="0.00" /></StorageOptions>
      <AdditionalSaleFormats>
        <SaleFormat Id="${opts.saleFormatId ?? "3363449"}" Name="Copa" Ratio="${opts.ratio ?? "0.20"}">
          <Prices>
            <Price PriceListId="13" MainPrice="${glassPrice}" />
            <Price PriceListId="16" MainPrice="${glassPrice}" />
          </Prices>
        </SaleFormat>
      </AdditionalSaleFormats>
      <CostPrices><CostPrice WarehouseId="1" Price="12.00" /></CostPrices>
    </Product>
  </Products>`;
}

const sentXml = productXml("26.00", "3.10");

function run(actualXml: string) {
  return verifyVinotecaNativeFormatsImport({
    plan,
    sentXml,
    actualXml,
    scopedPriceLists: PRICE_LISTS,
    priceListToSaleCenters: PL_TO_SC,
  });
}

describe("VINOTECA post-import verification", () => {
  it("verifies the native identities 2363449 / 3363449 as SUCCESS", () => {
    const result = run(productXml("26.00", "3.10"));
    expect(result.success).toBe(true);
    expect(result.verified_exists).toBe(true);
    expect(result.verified_prices).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toEqual({ checked: 2, ok: 2, failed: 0 });
  });

  it("is idempotent on a second identical cycle", () => {
    expect(run(productXml("26.00", "3.10"))).toEqual(run(productXml("26.00", "3.10")));
  });

  it("never looks for generic 500k/700k ids", () => {
    const result = run(productXml("26.00", "3.10"));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("863449");
    expect(serialized).not.toContain("1063449");
  });

  it("fails when the base Product is really absent", () => {
    const result = run("<Products></Products>");
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe("NOT_FOUND");
    expect(result.errors[0].message).toContain("2363449");
  });

  it("fails when the GLASS SaleFormat is missing from AdditionalSaleFormats", () => {
    const result = run(productXml("26.00", "3.10", { saleFormatId: "999999" }));
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("SALE_FORMAT_NOT_FOUND");
  });

  it("detects a stale bottle price and a wrong ratio", () => {
    const stale = run(productXml("25.00", "3.10"));
    expect(stale.success).toBe(false);
    expect(stale.errors.map((e) => e.code)).toContain("PRICE_MISMATCH");

    const ratio = run(productXml("26.00", "3.10", { ratio: "1.00" }));
    expect(ratio.errors.map((e) => e.code)).toContain("SALE_FORMAT_RATIO_MISMATCH");
  });

  it("flags hidden products and wrong preparation on the base Product", () => {
    expect(run(productXml("26.00", "3.10", { saleableAsMain: "false" })).errors.map((e) => e.code))
      .toContain("PRODUCT_NOT_VISIBLE");
    expect(run(productXml("26.00", "3.10", { prepTypeId: "1" })).errors.map((e) => e.code))
      .toContain("PREPARATION_MISMATCH");
  });
});
