import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildDisabledConnectionHydration } from "../../scripts/generate-disabled-connection-hydration.mjs";
import {
  buildHydrationTransition,
  renderApplyHydrationTransitionSql,
  renderRollbackHydrationTransitionSql,
} from "../../scripts/generate-disabled-connection-hydration-transition.mjs";

const connectionId = "ba44c13a-5f48-4a49-8b3f-04049b244d94";

type AcceptedMapping = {
  providerProductId: string;
  stockActive: boolean;
  matchMethod: string;
  [key: string]: unknown;
};

type ProviderProduct = {
  providerProductId: string;
  name: string;
  family: string;
  price: number;
  saleFormat: string | null;
  classificationStatus: string;
  winerimWineId: string | null;
  rawPayload: unknown;
  isWineCandidate: boolean;
  wineScore: number;
  wineReasons: string[];
  syncStatus: string;
  syncError: string | null;
  [key: string]: unknown;
};

type HydrationPlan = {
  connectionId: string;
  acceptedMappings: AcceptedMapping[];
  winerimWines: unknown[];
  providerProducts: ProviderProduct[];
  agoraMasterData: {
    families: unknown;
    productsSummary: unknown[];
    [key: string]: unknown;
  };
  counts: {
    acceptedMappings: number;
    rejectedMappings: number;
    confirmedProviderWineCandidates: number;
    ambiguousProviderWineCandidates: number;
    [key: string]: number;
  };
  hydrationDigest: string;
  [key: string]: unknown;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function recomputeDigest(plan: HydrationPlan) {
  const payload = {
    schemaVersion: 2,
    connectionId: plan.connectionId,
    acceptedMappings: plan.acceptedMappings,
    winerimWines: plan.winerimWines,
    providerProducts: plan.providerProducts,
    agoraMasterData: {
      families: plan.agoraMasterData.families,
      products: plan.providerProducts.map((product) => ({
        providerProductId: product.providerProductId,
        name: product.name,
        family: product.family,
        price: product.price,
        saleFormat: product.saleFormat,
        classificationStatus: product.classificationStatus,
        winerimWineId: product.winerimWineId,
        rawPayload: product.rawPayload,
      })),
    },
  };
  plan.hydrationDigest = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return plan;
}

function plans() {
  const after = buildDisabledConnectionHydration({
    connectionId,
    snapshot: {
      connection: { data: { id: connectionId } },
      mappings: { data: [
        { provider_product_id: "500101", provider_product_name: "B Active", winerim_wine_id: "101", winerim_wine_name: "Wine", format_type: "BOTTLE", status: "CONFIRMED" },
        { provider_product_id: "700101", provider_product_name: "C Inactive", winerim_wine_id: "101", winerim_wine_name: "Wine", format_type: "GLASS", status: "CONFIRMED" },
      ] },
    },
    masterXml: `<Export><Families><Family Id="1" Name="WINERIM"/></Families><Products>
      <Product Id="500101" Name="B Active" FamilyId="1"><Prices><Price MainPrice="20"/></Prices></Product>
      <Product Id="700101" Name="C Inactive" FamilyId="1"><Prices><Price MainPrice="5"/></Prices></Product>
    </Products></Export>`,
    winesDocument: { success: true, wines: [{ id: 101, name: "Wine" }] },
    stockDocument: { success: true, stocks: [
      { id: 1001, stock: 3, stockActive: true, winePrice: { price: 20, variant: "botella", wine: { id: 101 } } },
      { id: 1002, stock: 0, stockActive: false, winePrice: { price: 5, variant: "copa", wine: { id: 101 } } },
    ] },
    generatedAt: "2026-08-03T10:00:00.000Z",
  }) as HydrationPlan;
  const before = structuredClone(after);
  before.acceptedMappings = before.acceptedMappings.filter((mapping) => mapping.providerProductId !== "700101");
  const provider = before.providerProducts.find((product) => product.providerProductId === "700101");
  if (!provider) throw new Error("TEST_PROVIDER_REQUIRED");
  Object.assign(provider, {
    saleFormat: null,
    isWineCandidate: true,
    classificationStatus: "AMBIGUOUS",
    wineScore: 50,
    wineReasons: ["CURRENT_WINERIM_FAMILY", "REJECTED_STOCK_VARIANT_INACTIVE"],
    syncStatus: "BLOCKED",
    syncError: "HYDRATION_WINE_CANDIDATE_AMBIGUOUS",
    winerimWineId: null,
  });
  before.agoraMasterData.productsSummary = before.providerProducts.map((product) => ({
    provider_product_id: product.providerProductId,
    name: product.name,
    family: product.family,
    price: product.price,
    sale_format: product.saleFormat,
    classification_status: product.classificationStatus,
    winerim_wine_id: product.winerimWineId,
    raw_payload: product.rawPayload,
  }));
  before.counts.acceptedMappings = 1;
  before.counts.rejectedMappings = 1;
  before.counts.confirmedProviderWineCandidates = 1;
  before.counts.ambiguousProviderWineCandidates = 1;
  recomputeDigest(before);
  return { before, after };
}

describe("disabled hydration additive transition", () => {
  it("permits only exact inactive sales-only mapping additions", () => {
    const { before, after } = plans();
    const transition = buildHydrationTransition(before, after, "2026-08-03T12:00:00.000Z");
    expect(transition.beforeCounts.mappings).toBe(1);
    expect(transition.afterCounts.mappings).toBe(2);
    expect(transition.additions).toEqual([expect.objectContaining({
      providerProductId: "700101",
      formatType: "GLASS",
      stockId: 1002,
      stockActive: false,
      matchMethod: "RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY",
    })]);
  });

  it("renders a fail-closed apply and exact inverse rollback", () => {
    const { before, after } = plans();
    const transition = buildHydrationTransition(before, after, "2026-08-03T12:00:00.000Z");
    const apply = renderApplyHydrationTransitionSql(transition);
    const rollback = renderRollbackHydrationTransitionSql(transition);
    expect(apply).toContain("HYDRATION_TRANSITION_TARGET_NOT_DISABLED");
    expect(apply).toContain("HYDRATION_TRANSITION_OPERATIONAL_SCOPE_NOT_EMPTY");
    expect(apply).toContain("CURRENT_GLASS_STOCK_ACTIVE_FALSE_SALES_ONLY");
    expect(apply).toContain("INSERT INTO public.product_mappings");
    expect(apply).not.toMatch(/DELETE FROM public\.product_mappings/);
    expect(apply).not.toMatch(/sales\/import|UPDATE public\.pos_connections|api_token|winerim_api_token/i);
    expect(rollback).toContain("DELETE FROM public.product_mappings");
    expect(rollback).toContain("provider_product_id IN ('700101')");
    expect(rollback).not.toMatch(/TRUNCATE|DELETE FROM public\.provider_products/i);
  });

  it("rejects active additions and unrelated provider changes", () => {
    const activePlans = plans();
    const addition = activePlans.after.acceptedMappings.find((mapping) => mapping.providerProductId === "700101");
    if (!addition) throw new Error("TEST_MAPPING_REQUIRED");
    addition.stockActive = true;
    addition.matchMethod = "RESCUE_EXACT_ID_WINE_VARIANT";
    recomputeDigest(activePlans.after);
    expect(() => buildHydrationTransition(activePlans.before, activePlans.after)).toThrow(/NOT_EXACT_SALES_ONLY/);

    const changedPlans = plans();
    const changedProduct = changedPlans.after.providerProducts.find((product) => product.providerProductId === "500101");
    if (!changedProduct) throw new Error("TEST_PRODUCT_REQUIRED");
    changedProduct.price = 999;
    recomputeDigest(changedPlans.after);
    expect(() => buildHydrationTransition(changedPlans.before, changedPlans.after)).toThrow(/UNRELATED_PROVIDER_CHANGED/);
  });
});
