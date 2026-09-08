import { describe, expect, it } from "vitest";
import {
  buildCatalogPlan,
  validateCatalogRequest,
  type CatalogPlanningContext,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/catalog";

function request(overrides: Record<string, unknown> = {}) {
  const result = validateCatalogRequest({
    action: "catalog.preview",
    connectionId: "purosushi",
    formats: ["BOTTLE"],
    ...overrides,
  });
  if (result.ok === false) throw new Error(result.result.error.code);
  return result.request;
}

function context(overrides: Partial<CatalogPlanningContext> = {}): CatalogPlanningContext {
  return {
    provider: "agora",
    sourceRevision: "catalog:2026-08-02T10:00:00Z",
    wines: [],
    existingFamilies: [{ id: "10", name: "TINTOS WINERIM" }],
    existingProducts: [],
    familyRouting: {
      byFormatAndWineType: {
        "bottle:tinto": { id: "10", name: "TINTOS WINERIM" },
      },
    },
    ...overrides,
  };
}

describe("Cloudflare runtime catalog planning", () => {
  it("keeps deterministic Product.Id offsets for bottle, glass and magnum", async () => {
    const plan = await buildCatalogPlan(
      request({ formats: ["BOTTLE", "GLASS", "MAGNUM"] }),
      context({
        wines: [{
          winerimId: "239259",
          name: "Alion",
          wineType: "tinto",
          variants: [
            { format: "BOTTLE", salePrice: 80 },
            { format: "GLASS", salePrice: 12 },
            { format: "MAGNUM", salePrice: 170 },
          ],
        }],
        familyRouting: {
          byFormat: {
            BOTTLE: { id: "10", name: "TINTOS WINERIM" },
            GLASS: { id: "10", name: "TINTOS WINERIM" },
            MAGNUM: { id: "10", name: "TINTOS WINERIM" },
          },
        },
      }),
    );

    expect(plan.operations.map((operation) => operation.desired.productId)).toEqual([
      "739259",
      "939259",
      "1139259",
    ]);
    expect(plan.operations.map((operation) => operation.desired.label.name)).toEqual([
      "B Alion",
      "C Alion",
      "M Alion",
    ]);
  });

  it("reproduces PurOsushi vintage labels and keeps the year visible", async () => {
    const plan = await buildCatalogPlan(request(), context({
      wines: [
        {
          winerimId: "210280",
          name: "Chateau Violet-Lamothe",
          vintage: 2022,
          wineType: "tinto",
          variants: [{ format: "BOTTLE", salePrice: 40 }],
        },
        {
          winerimId: "213744",
          name: "Chateau Violet-Lamothe",
          vintage: 2020,
          wineType: "tinto",
          variants: [{ format: "BOTTLE", salePrice: 42 }],
        },
        {
          winerimId: "213873",
          name: "Jacques Prieur Beaune Champs Pimont 1er Cru.",
          vintage: 2017,
          wineType: "tinto",
          variants: [{ format: "BOTTLE", salePrice: 90 }],
        },
        {
          winerimId: "213874",
          name: "Jacques Prieur Beaune Champs Pimont 1er Cru.",
          vintage: 2018,
          wineType: "tinto",
          variants: [{ format: "BOTTLE", salePrice: 95 }],
        },
      ],
    }));

    expect(plan.productLabelsById).toMatchObject({
      "710280": { name: "B Chateau Violet-Lamothe 2022", buttonText: "B Chateau Viole 2022" },
      "713744": { name: "B Chateau Violet-Lamothe 2020", buttonText: "B Chateau Viole 2020" },
      "713873": {
        name: "B Jacques Prieur Beaune Champs Pimont 1er Cru. 2017",
        buttonText: "B Jacques Prieu 2017",
      },
      "713874": {
        name: "B Jacques Prieur Beaune Champs Pimont 1er Cru. 2018",
        buttonText: "B Jacques Prieu 2018",
      },
    });
  });

  it("uses explicit family routing before inferred family names", async () => {
    const plan = await buildCatalogPlan(request({ formats: ["GLASS"] }), context({
      wines: [{
        winerimId: "1",
        name: "Test",
        wineType: "tinto",
        variants: [{ format: "GLASS", salePrice: 5 }],
      }],
      existingFamilies: [
        { id: "10", name: "TINTOS WINERIM" },
        { id: "20", name: "COPAS WINERIM" },
      ],
      familyRouting: {
        byFormat: { GLASS: { id: "20", name: "COPAS WINERIM" } },
        byWineType: { tinto: { id: "10", name: "TINTOS WINERIM" } },
      },
    }));

    expect(plan.operations[0].desired.family).toEqual({ id: "20", name: "COPAS WINERIM" });
  });

  it("fails closed when configured family is absent from master", async () => {
    const plan = await buildCatalogPlan(request(), context({
      wines: [{
        winerimId: "1",
        name: "Test",
        wineType: "tinto",
        variants: [{ format: "BOTTLE", salePrice: 20 }],
      }],
      familyRouting: {
        byFormat: { BOTTLE: { id: "999", name: "MISSING" } },
      },
    }));

    expect(plan.readyToApply).toBe(false);
    expect(plan.operations).toEqual([]);
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: "FAMILY_NOT_IN_MASTER" }));
  });

  it("fails closed when an explicitly requested wine is missing from the planning context", async () => {
    const plan = await buildCatalogPlan(
      request({ wineIds: ["99"] }),
      context({ wines: [] }),
    );

    expect(plan.readyToApply).toBe(false);
    expect(plan.operations).toEqual([]);
    expect(plan.issues).toContainEqual(expect.objectContaining({
      code: "REQUESTED_WINE_NOT_FOUND",
      winerimId: "99",
    }));
  });

  it("produces stable idempotency descriptors independent of input order", async () => {
    const wines = [
      { winerimId: "2", name: "Beta", wineType: "tinto", variants: [{ format: "BOTTLE" as const, salePrice: 20 }] },
      { winerimId: "1", name: "Alpha", wineType: "tinto", variants: [{ format: "BOTTLE" as const, salePrice: 10 }] },
    ];
    const first = await buildCatalogPlan(request(), context({ wines }));
    const reordered = await buildCatalogPlan(request(), context({ wines: [...wines].reverse() }));

    expect(first.idempotency.key).toBe(reordered.idempotency.key);
    expect(first.operations.map((operation) => operation.idempotency.key))
      .toEqual(reordered.operations.map((operation) => operation.idempotency.key));
    expect(first.idempotency.key).toMatch(/^catalog:v1:[a-f0-9]{64}$/);
  });

  it("reports creates, updates and unchanged products from known evidence only", async () => {
    const wines = [
      { winerimId: "1", name: "Create", wineType: "tinto", variants: [{ format: "BOTTLE" as const, salePrice: 10 }] },
      { winerimId: "2", name: "Update", wineType: "tinto", variants: [{ format: "BOTTLE" as const, salePrice: 20 }] },
      { winerimId: "3", name: "Same", wineType: "tinto", variants: [{ format: "BOTTLE" as const, salePrice: 30 }] },
    ];
    const plan = await buildCatalogPlan(request(), context({
      wines,
      existingProducts: [
        { productId: "500002", name: "B Old", familyId: "10", salePrice: 20 },
        { productId: "500003", name: "B Same", familyId: "10", salePrice: 30 },
      ],
    }));

    expect(plan.operations.map((operation) => operation.kind)).toEqual(["create", "update", "unchanged"]);
    expect(plan.summary).toMatchObject({ create: 1, update: 1, unchanged: 1, blocked: 0 });
  });
});
