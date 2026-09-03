import { describe, expect, it, vi } from "vitest";
import {
  handleCatalogRequest,
  type CatalogHandlerPorts,
  type CatalogPlanningContext,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/catalog";

function planningContext(): CatalogPlanningContext {
  return {
    provider: "agora",
    sourceRevision: "revision-1",
    wines: [{
      winerimId: "1",
      name: "Wine",
      wineType: "tinto",
      variants: [{ format: "BOTTLE", salePrice: 20 }],
    }],
    existingFamilies: [{ id: "10", name: "TINTOS WINERIM" }],
    existingProducts: [],
    familyRouting: { byWineType: { tinto: { id: "10", name: "TINTOS WINERIM" } } },
  };
}

describe("Cloudflare runtime catalog handler", () => {
  it("returns a preview without invoking the apply port", async () => {
    const applyPlan = vi.fn();
    const ports: CatalogHandlerPorts = {
      loadPlanningContext: vi.fn(async () => ({ ok: true as const, context: planningContext() })),
      applyPlan,
    };

    const result = await handleCatalogRequest({
      action: "xml-import",
      connectionId: "connection-a",
      dryRun: true,
    }, ports);

    expect(result).toMatchObject({ ok: true, mode: "preview", plan: { dryRun: true } });
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it("passes only the deterministic plan and idempotency descriptor to apply", async () => {
    const applyPlan = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        status: "applied" as const,
        appliedProductIds: ["500001", "not-planned"],
        providerRequestId: "request-1",
        token: "must-not-leak",
      },
    }));
    const ports: CatalogHandlerPorts = {
      loadPlanningContext: vi.fn(async () => ({ ok: true as const, context: planningContext() })),
      applyPlan,
    };

    const result = await handleCatalogRequest({
      action: "catalog.apply",
      connectionId: "connection-a",
    }, ports);

    expect(result).toMatchObject({
      ok: true,
      mode: "applied",
      receipt: { status: "applied", appliedProductIds: ["500001"], providerRequestId: "request-1" },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(applyPlan).toHaveBeenCalledWith(expect.objectContaining({
      idempotency: expect.objectContaining({ scope: "catalog-plan", key: expect.stringMatching(/^catalog:v1:/) }),
    }));
  });

  it("does not apply a plan with blocking validation issues", async () => {
    const applyPlan = vi.fn();
    const invalidContext: CatalogPlanningContext = {
      ...planningContext(),
      wines: [{
        winerimId: "1",
        name: "Wine",
        wineType: "tinto",
        variants: [{ format: "BOTTLE", salePrice: 0 }],
      }],
    };
    const result = await handleCatalogRequest({
      action: "catalog.apply",
      connectionId: "connection-a",
    }, {
      loadPlanningContext: async () => ({ ok: true, context: invalidContext }),
      applyPlan,
    });

    expect(result).toMatchObject({ ok: false, status: 422, error: { code: "CATALOG_PLAN_BLOCKED" } });
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it("sanitizes thrown port errors", async () => {
    const result = await handleCatalogRequest({
      action: "catalog.preview",
      connectionId: "connection-a",
    }, {
      loadPlanningContext: async () => {
        throw new Error("postgres://user:secret@host/database");
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: { code: "CONTEXT_UNAVAILABLE", message: "Catalog planning context is unavailable." },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
