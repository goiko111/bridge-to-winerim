import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  baseProductPriceMap,
  productXmlWithoutSaleFormats,
  saleFormatDifferenceReasons,
  saleFormatPriceMaps,
} from "../../supabase/functions/_shared/agoraVinotecaProductDiff";

const SOURCE = readFileSync("supabase/functions/agora-proxy/index.ts", "utf8");

function product(bottlePrice: string, glassPrice: string): string {
  return `    <Product Id="2363449" Name="Vino" ButtonText="Vino" FamilyId="950809" VatId="1" UseAsDirectSale="false" SaleableAsMain="true" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="6" PreparationOrderId="2" CostPrice="12.00">
      <Barcodes />
      <Prices>
        <Price PriceListId="1" MainPrice="${bottlePrice}" AddinPrice="0.00" MenuItemPrice="0.00" />
      </Prices>
      <StorageOptions>
        <StorageOption WarehouseId="1" Location="" MinStock="0.00" MaxStock="0.00" />
      </StorageOptions>
      <AdditionalSaleFormats>
        <SaleFormat Id="3363449" Name="Copa Vino" ButtonText="Copa Vino" Ratio="0.20" SaleableAsMain="true" SaleableAsAddin="false">
          <Prices>
            <Price PriceListId="1" MainPrice="${glassPrice}" AddinPrice="0.00" MenuItemPrice="0.00" />
          </Prices>
        </SaleFormat>
      </AdditionalSaleFormats>
      <CostPrices>
        <CostPrice WarehouseId="1" CostPrice="12.00" />
      </CostPrices>
    </Product>`;
}

describe("base BOTTLE price is not masked by nested sale formats", () => {
  it("reads the bottle price from the base Product only", () => {
    expect(baseProductPriceMap(product("26.00", "3.10"))).toEqual({ "1": "26.00" });
    expect(productXmlWithoutSaleFormats(product("26.00", "3.10"))).not.toContain("SaleFormat");
  });

  it("reads GLASS by SaleFormatId inside AdditionalSaleFormats", () => {
    expect(saleFormatPriceMaps(product("26.00", "3.10"))).toEqual({ "3363449": { "1": "3.10" } });
  });
});

describe("fixtures required by the canary", () => {
  it("expected bottle 26 vs actual 25 is a real diff (glass 3.10 == 3.10 adds nothing)", () => {
    const expectedXml = product("26.00", "3.10");
    const actualXml = product("25.00", "3.10");
    expect(baseProductPriceMap(expectedXml)["1"]).toBe("26.00");
    expect(baseProductPriceMap(actualXml)["1"]).toBe("25.00");
    expect(saleFormatDifferenceReasons(expectedXml, actualXml, ["1"])).toEqual([]);
  });

  it("is idempotent when actual equals expected", () => {
    const same = product("26.00", "3.10");
    expect(baseProductPriceMap(same)).toEqual(baseProductPriceMap(same));
    expect(saleFormatDifferenceReasons(same, same, ["1"])).toEqual([]);
  });

  it("detects a GLASS price drift by SaleFormatId", () => {
    expect(saleFormatDifferenceReasons(product("26.00", "3.10"), product("26.00", "2.90"), ["1"]))
      .toEqual(["SALE_FORMAT_3363449_PRICE_LIST_1_MISMATCH"]);
  });

  it("detects a missing sale format", () => {
    const actualXml = product("26.00", "3.10").replace(/<AdditionalSaleFormats[\s\S]*?<\/AdditionalSaleFormats>/, "");
    expect(saleFormatDifferenceReasons(product("26.00", "3.10"), actualXml, ["1"]))
      .toEqual(["SALE_FORMAT_3363449_MISSING"]);
  });
});

describe("agora-proxy wiring", () => {
  it("uses the base price map and the sale-format comparator", () => {
    expect(SOURCE).toContain('from "../_shared/agoraVinotecaProductDiff.ts"');
    expect(SOURCE).toContain("return baseProductPriceMap(productXml);");
    expect(SOURCE).toContain("differences.push(...saleFormatDifferenceReasons(expected.xml, actual.xml, scopedPriceListIds));");
  });

  it("labels base price drift as BOTTLE when sale formats exist and reports the diff reason", () => {
    expect(SOURCE).toContain('const basePriceLabel = hasSaleFormats ? "BOTTLE_PRICE_LIST" : "PRICE_LIST";');
    expect(SOURCE).toContain("update_diff_detected:");
  });
});
