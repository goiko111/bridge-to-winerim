import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildDisabledConnectionHydration,
  parseAgoraMasterXml,
  renderHydrationSql,
} from "../../scripts/generate-disabled-connection-hydration.mjs";

const connectionId = "ba44c13a-5f48-4a49-8b3f-04049b244d94";

function syntheticSources() {
  return {
    connectionId,
    snapshot: {
      connection: { data: { id: connectionId, location_name: "Fixture", enabled: true, catalog_sync_enabled: true, write_mode: "XML_IMPORT" } },
      mappings: { data: [
        { provider_product_id: "500101", provider_product_name: "B Exact", winerim_wine_id: "101", winerim_wine_name: "Exact", format_type: "BOTTLE", status: "CONFIRMED" },
        { provider_product_id: "700102", provider_product_name: "B Missing wine", winerim_wine_id: "102", winerim_wine_name: "Gone", format_type: "BOTTLE", status: "CONFIRMED" },
        { provider_product_id: "900101", provider_product_name: "M No magnum", winerim_wine_id: "101", winerim_wine_name: "Exact", format_type: "MAGNUM", status: "CONFIRMED" },
        { provider_product_id: "901101", provider_product_name: "C Inactive", winerim_wine_id: "101", winerim_wine_name: "Exact", format_type: "GLASS", status: "CONFIRMED" },
      ] },
    },
    masterXml: `<?xml version="1.0"?><Export><Families><Family Id="1" Name="TINTOS WINERIM" /><Family Id="2" Name="COMIDA" /></Families><Products>
      <Product Id="500101" Name="B Exact" FamilyId="1"><Prices><Price PriceListId="4" MainPrice="20.00" /></Prices></Product>
      <Product Id="700102" Name="B Missing wine" FamilyId="1"><Prices><Price PriceListId="4" MainPrice="30.00" /></Prices></Product>
      <Product Id="900101" Name="M No magnum" FamilyId="1"><Prices><Price PriceListId="4" MainPrice="40.00" /></Prices></Product>
      <Product Id="901101" Name="C Inactive" FamilyId="1"><Prices><Price PriceListId="4" MainPrice="5.00" /></Prices></Product>
      <Product Id="600103" Name="B Unmapped Winerim family" FamilyId="1"><Prices><Price PriceListId="4" MainPrice="22.00" /></Prices></Product>
      <Product Id="10" Name="Food" FamilyId="2"><Prices><Price PriceListId="4" MainPrice="9.00" /></Prices></Product>
    </Products></Export>`,
    winesDocument: { success: true, wines: [{ id: 101, name: "Exact", type: "tinto", vintage: "2024" }] },
    stockDocument: { success: true, stocks: [
      { id: 1001, stock: 4, stockActive: true, winePrice: { price: "20", variant: "botella", wine: { id: 101, name: "Exact" } } },
      { id: 1002, stock: 0, stockActive: false, winePrice: { price: "5", variant: "copa", wine: { id: 101, name: "Exact" } } },
    ] },
    generatedAt: "2026-08-03T10:00:00.000Z",
  };
}

describe("disabled connection hydration generator", () => {
  it("accepts exact current Product.Id + wineId + stock variant mappings and marks inactive stock sales-only", () => {
    const plan = buildDisabledConnectionHydration(syntheticSources());
    expect(plan.counts).toMatchObject({
      snapshotMappings: 4,
      acceptedMappings: 2,
      rejectedMappings: 2,
      inactiveWinerimStocks: 1,
      confirmedProviderWineCandidates: 2,
      ambiguousProviderWineCandidates: 3,
    });
    expect(plan.acceptedMappings).toEqual([expect.objectContaining({
      providerProductId: "500101",
      winerimWineId: "101",
      formatType: "BOTTLE",
      stockId: 1001,
      stockActive: true,
      status: "CONFIRMED",
    }), expect.objectContaining({
      providerProductId: "901101",
      winerimWineId: "101",
      formatType: "GLASS",
      stockId: 1002,
      stockActive: false,
      matchMethod: "RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY",
    })]);
    expect(plan.rejectedMappings.map((mapping) => mapping.reason).sort()).toEqual([
      "STOCK_VARIANT_NOT_CURRENT",
      "WINERIM_WINE_NOT_CURRENT",
    ].sort());
  });

  it("keeps rejected and unmapped Winerim-family products as ambiguous wine candidates", () => {
    const plan = buildDisabledConnectionHydration(syntheticSources());
    for (const productId of ["700102", "900101", "600103"]) {
      expect(plan.providerProducts.find((product) => product.providerProductId === productId)).toMatchObject({
        isWineCandidate: true,
        classificationStatus: "AMBIGUOUS",
        syncStatus: "BLOCKED",
        syncError: "HYDRATION_WINE_CANDIDATE_AMBIGUOUS",
        winerimWineId: null,
        saleFormat: null,
      });
    }
    expect(plan.providerProducts.find((product) => product.providerProductId === "901101")).toMatchObject({
      isWineCandidate: true,
      classificationStatus: "CONFIRMED",
      syncStatus: "SYNCED",
      winerimWineId: "101",
      saleFormat: "GLASS",
      wineReasons: ["RESCUE_EXACT_ID_WINE_INACTIVE_VARIANT_SALES_ONLY"],
    });
    expect(plan.providerProducts.find((product) => product.providerProductId === "10")).toMatchObject({
      isWineCandidate: false,
      classificationStatus: "NOT_WINE",
      syncStatus: "NOT_SYNCED",
    });
  });

  it("renders one-shot SQL with row/table locks and exact semantic no-op replay", () => {
    const plan = buildDisabledConnectionHydration(syntheticSources());
    const sql = renderHydrationSql(plan);
    expect(sql).toContain("enabled IS FALSE");
    expect(sql).toContain("catalog_sync_enabled IS FALSE");
    expect(sql).toContain("write_mode = 'NONE'");
    expect(sql).toContain("target_write_mode IS DISTINCT FROM 'NONE'");
    expect(sql).toContain("FOR UPDATE;");
    expect(sql).toContain("IN SHARE ROW EXCLUSIVE MODE");
    expect(sql.indexOf("FOR UPDATE;")).toBeLessThan(sql.indexOf("LOCK TABLE public.winerim_wines"));
    expect(sql.indexOf("LOCK TABLE public.winerim_wines")).toBeLessThan(sql.indexOf("SELECT count(*) INTO wine_count"));
    expect(sql.indexOf("SELECT count(*) INTO wine_count")).toBeLessThan(sql.indexOf("INSERT INTO public.winerim_wines"));
    expect(sql).toContain("HYDRATION_TARGET_NOT_EMPTY_OR_IDENTICAL");
    expect(sql).toContain("WINERIM_RESCUE_HYDRATION_V2_SHA256:");
    expect(sql).toContain("INSERT INTO hydration_control VALUES (false");
    expect(sql).not.toMatch(/ON CONFLICT|DO UPDATE|TRUNCATE|DELETE FROM/i);
    expect(sql).toContain("HYDRATION_POSTCONDITION_COUNT_MISMATCH");
    const mappingSection = sql.slice(
      sql.indexOf("INSERT INTO hydration_expected_mappings"),
      sql.indexOf("CREATE TEMP TABLE hydration_control"),
    );
    expect(mappingSection).toContain("500101");
    expect(mappingSection).toContain("CURRENT_BOTTLE_STOCK_ACTIVE_TRUE");
    expect(mappingSection).not.toContain("700102");
    expect(mappingSection).not.toContain("900101");
    expect(mappingSection).toContain("901101");
    expect(mappingSection).toContain("CURRENT_GLASS_STOCK_ACTIVE_FALSE_SALES_ONLY");
    expect(sql).not.toMatch(/api_token|winerim_api_token|last_business_day_synced|sales_events|outbound_tasks|runtime_canary_connections/i);
    expect(sql).not.toContain("SET enabled");
  });

  it("changes the semantic digest when an input changes, preventing stale replay", () => {
    const initial = buildDisabledConnectionHydration(syntheticSources());
    const changedSources = syntheticSources();
    changedSources.stockDocument.stocks[0].stock = 3;
    const changed = buildDisabledConnectionHydration(changedSources);
    expect(changed.hydrationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(changed.hydrationDigest).not.toBe(initial.hydrationDigest);
    expect(renderHydrationSql(changed)).toContain(`WINERIM_RESCUE_HYDRATION_V2_SHA256:${changed.hydrationDigest}`);
  });

  it("rejects unsafe or structurally ambiguous XML", () => {
    expect(() => parseAgoraMasterXml('<!DOCTYPE x [<!ENTITY y "z">]><Export><Families/><Products/></Export>')).toThrow(/UNSAFE_DECLARATION/);
    expect(() => parseAgoraMasterXml('<Export><Families/><Products/><Products/></Export>')).toThrow(/SINGLE_FAMILIES_AND_PRODUCTS/);
    expect(() => parseAgoraMasterXml('<Export><Families/><Products><Audit><Product Id="1" /></Audit></Products></Export>')).toThrow(/UNEXPECTED_PRODUCTS_CHILD/);
    expect(() => parseAgoraMasterXml('<Export><Families/><Products><Product Id="1"/><Product Id="1"/></Products></Export>')).toThrow(/DUPLICATE_PRODUCT/);
  });

  it("fails closed on a mismatched snapshot connection", () => {
    const inputs = syntheticSources();
    inputs.snapshot.connection.data.id = "e2f6ce27-0e94-444f-9d64-09ba425a2b83";
    expect(() => buildDisabledConnectionHydration(inputs)).toThrow(/SNAPSHOT_CONNECTION_MISMATCH/);
  });

  const realPaths = {
    snapshot: "/Users/GOIKO/Documents/Playground/bridge-to-winerim-audit/bridge-to-winerim-main/tmp/agora_el_bejeque_readonly_20260731.json",
    master: "/tmp/el-bejeque-master-probe.json",
    wines: "/tmp/el-bejeque-winerim-wines-page1.json",
    stock: "/tmp/el-bejeque-winerim-stock-page1.json",
  };
  const realFixtureAvailable = Object.values(realPaths).every(existsSync);

  it.runIf(realFixtureAvailable)("reconciles active and exact sales-only stock in the real El Bejeque fixture", () => {
    const plan = buildDisabledConnectionHydration({
      connectionId,
      snapshot: JSON.parse(readFileSync(realPaths.snapshot, "utf8")),
      masterXml: readFileSync(realPaths.master, "utf8"),
      winesDocument: JSON.parse(readFileSync(realPaths.wines, "utf8")),
      stockDocument: JSON.parse(readFileSync(realPaths.stock, "utf8")),
      generatedAt: "2026-08-03T10:00:00.000Z",
    });
    expect(plan.counts).toMatchObject({
      acceptedMappings: 95,
      rejectedMappings: 11,
      inactiveWinerimStocks: 24,
      confirmedProviderWineCandidates: 95,
      ambiguousProviderWineCandidates: 11,
    });
    expect(plan.rejectedByReason).toEqual({
      WINERIM_WINE_NOT_CURRENT: 10,
      STOCK_VARIANT_NOT_CURRENT: 1,
    });
    expect(plan.acceptedMappings).toHaveLength(95);
    expect(plan.acceptedMappings.filter((mapping) => mapping.stockActive === false)).toHaveLength(23);
    expect(plan.acceptedMappings.filter((mapping) => mapping.stockActive === false).every((mapping) => (
      mapping.matchMethod === "RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY"
    ))).toBe(true);
    expect(plan.providerProducts.filter((product) => product.classificationStatus === "AMBIGUOUS")).toHaveLength(11);
    expect(plan.providerProducts.filter((product) => product.classificationStatus === "AMBIGUOUS").every((product) => (
      product.isWineCandidate === true && product.syncStatus === "BLOCKED" && product.winerimWineId === null
    ))).toBe(true);
    expect(plan.rejectedMappings.find((mapping) => mapping.reason === "STOCK_VARIANT_NOT_CURRENT")).toMatchObject({
      providerProductId: "1122870",
      winerimWineId: "222870",
      formatType: "MAGNUM",
    });
  });
});
