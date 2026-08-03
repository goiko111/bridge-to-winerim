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
        { provider_product_id: "900101", provider_product_name: "C No glass", winerim_wine_id: "101", winerim_wine_name: "Exact", format_type: "GLASS", status: "CONFIRMED" },
      ] },
    },
    masterXml: `<?xml version="1.0"?><Export><Families><Family Id="1" Name="WINERIM" /></Families><Products>
      <Product Id="500101" Name="B Exact" FamilyId="1"><Prices><Price PriceListId="4" MainPrice="20.00" /></Prices></Product>
      <Product Id="700102" Name="B Missing wine" FamilyId="1"><Prices><Price PriceListId="4" MainPrice="30.00" /></Prices></Product>
      <Product Id="900101" Name="C No glass" FamilyId="1"><Prices><Price PriceListId="4" MainPrice="5.00" /></Prices></Product>
    </Products></Export>`,
    winesDocument: { success: true, wines: [{ id: 101, name: "Exact", type: "tinto", vintage: "2024" }] },
    stockDocument: { success: true, stocks: [{ id: 1001, stock: 4, stockActive: true, winePrice: { price: "20", variant: "botella", wine: { id: 101, name: "Exact" } } }] },
    generatedAt: "2026-08-03T10:00:00.000Z",
  };
}

describe("disabled connection hydration generator", () => {
  it("accepts only exact current Product.Id + wineId + stock variant mappings", () => {
    const plan = buildDisabledConnectionHydration(syntheticSources());
    expect(plan.counts).toMatchObject({ snapshotMappings: 3, acceptedMappings: 1, rejectedMappings: 2 });
    expect(plan.acceptedMappings).toEqual([expect.objectContaining({
      providerProductId: "500101",
      winerimWineId: "101",
      formatType: "BOTTLE",
      stockId: 1001,
      status: "CONFIRMED",
    })]);
    expect(plan.rejectedMappings.map((mapping) => mapping.reason).sort()).toEqual([
      "STOCK_VARIANT_NOT_CURRENT",
      "WINERIM_WINE_NOT_CURRENT",
    ]);
  });

  it("renders replay-safe SQL guarded by disabled, catalog-off and write NONE before and after", () => {
    const plan = buildDisabledConnectionHydration(syntheticSources());
    const sql = renderHydrationSql(plan);
    expect(sql).toContain("enabled IS FALSE");
    expect(sql).toContain("catalog_sync_enabled IS FALSE");
    expect(sql).toContain("write_mode = 'NONE'");
    expect(sql).toContain("ON CONFLICT (connection_id, winerim_id) DO UPDATE");
    expect(sql).toContain("ON CONFLICT (connection_id, provider_product_id) DO UPDATE");
    expect(sql).toContain("HYDRATION_POSTCONDITION_COUNT_MISMATCH");
    const mappingSection = sql.slice(sql.indexOf("INSERT INTO public.product_mappings"));
    expect(mappingSection).toContain("500101");
    expect(mappingSection).not.toContain("700102");
    expect(mappingSection).not.toContain("900101");
    expect(sql).not.toMatch(/api_token|winerim_api_token|last_business_day_synced|sales_events|outbound_tasks|runtime_canary_connections/i);
    expect(sql).not.toContain("SET enabled");
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

  it.runIf(realFixtureAvailable)("reconciles the real El Bejeque fixture as 95 exact and 11 rejected", () => {
    const plan = buildDisabledConnectionHydration({
      connectionId,
      snapshot: JSON.parse(readFileSync(realPaths.snapshot, "utf8")),
      masterXml: readFileSync(realPaths.master, "utf8"),
      winesDocument: JSON.parse(readFileSync(realPaths.wines, "utf8")),
      stockDocument: JSON.parse(readFileSync(realPaths.stock, "utf8")),
      generatedAt: "2026-08-03T10:00:00.000Z",
    });
    expect(plan.counts.acceptedMappings).toBe(95);
    expect(plan.counts.rejectedMappings).toBe(11);
    expect(plan.rejectedByReason).toEqual({ WINERIM_WINE_NOT_CURRENT: 10, STOCK_VARIANT_NOT_CURRENT: 1 });
    expect(plan.rejectedMappings.find((mapping) => mapping.reason === "STOCK_VARIANT_NOT_CURRENT")).toMatchObject({
      providerProductId: "1122870",
      winerimWineId: "222870",
      formatType: "MAGNUM",
    });
  });
});
