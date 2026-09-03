import { describe, expect, it, vi } from "vitest";

import type { DatabaseAdapter } from "../../middleware-api/src/db";
import type { PostgresCatalogAdapterFactory } from "../../middleware-runtime/src/adapters/catalog";
import type { HttpRequestPort } from "../../middleware-runtime/src/adapters/http";
import type { RuntimeJob } from "../../middleware-runtime/src/contracts";
import { createRuntimeEnvelope } from "../../middleware-runtime/src/idempotency";
import type {
  CatalogApplyPortResult,
  CatalogPlan,
  CatalogPlanningContext,
} from "../../middleware-runtime/src/handlers/catalog";
import {
  catalogProductCanonicalFingerprint,
  createAgoraCatalogPlanApplyAndReadbackPort,
  createPrivateCatalogLaneExecutor,
  renderAgoraCatalogProductXml,
  type AgoraCatalogApplyAndReadbackPort,
  type AgoraCatalogApplyAndReadbackResult,
  type AgoraCatalogRenderableProductState,
  type AgoraCatalogXmlProfile,
  type PrivateCatalogCompositionOptions,
} from "./catalog";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function database(): DatabaseAdapter {
  return {
    query: vi.fn(),
    transaction: vi.fn(),
  } as unknown as DatabaseAdapter;
}

async function envelope(
  payload: Record<string, unknown> = {},
  job: Extract<RuntimeJob, `catalog.${string}`> = "catalog.sync-master",
) {
  return createRuntimeEnvelope({
    connectionId: CONNECTION_ID,
    job,
    dedupeScope: `catalog-remote-gate:${job}`,
    payload,
    source: { kind: "queue", eventId: `catalog-remote-gate:${job}` },
    createdAt: "2026-08-03T12:00:00.000Z",
  });
}

function planningContext(): CatalogPlanningContext {
  return {
    provider: "agora",
    sourceRevision: "catalog-remote-fixture-v1",
    wines: [{
      winerimId: "1",
      name: "Remote Readback Fixture",
      active: true,
      wineType: "tinto",
      variants: [{ format: "BOTTLE", salePrice: 20 }],
    }],
    existingFamilies: [{ id: "10", name: "TINTOS WINERIM" }],
    existingProducts: [],
    familyRouting: {
      byWineType: { tinto: { id: "10", name: "TINTOS WINERIM" } },
    },
  };
}

function successfulReceipt(plan: CatalogPlan): CatalogApplyPortResult {
  return {
    ok: true,
    receipt: {
      status: "applied",
      appliedProductIds: plan.operations.map((operation) => operation.desired.productId),
      providerRequestId: "agora-request-1",
    },
  };
}

async function successfulRemoteReceipt(plan: CatalogPlan): Promise<AgoraCatalogApplyAndReadbackResult> {
  return {
    ok: true,
    receipt: {
      status: "applied",
      appliedProductIds: plan.operations.map((operation) => operation.desired.productId),
      canonicalProductFingerprints: Object.fromEntries(await Promise.all(plan.operations.map(async (operation) => [
        operation.desired.productId,
        await catalogProductCanonicalFingerprint(operation.desired),
      ]))),
      providerRequestId: "agora-request-1",
    },
  };
}

function fixture(remote?: AgoraCatalogApplyAndReadbackPort) {
  const loadConnection = vi.fn(async () => ({
    connectionId: CONNECTION_ID,
    provider: "agora",
    enabled: true,
  }));
  const openCredential = vi.fn(async () => ({
    read: vi.fn(async () => "fixture-agora-token"),
  }));
  const loadPlanningContext = vi.fn(async () => ({
    ok: true as const,
    context: planningContext(),
  }));
  const persistPlan = vi.fn(async ({ plan }: { plan: CatalogPlan }) => successfulReceipt(plan));
  const refreshMaster = vi.fn(async () => ({
    ok: true as const,
    outcome: "complete" as const,
    changed: 1,
    observedAt: "2026-08-03T12:00:00.000Z",
  }));
  const adapterFactory = vi.fn(() => ({
    loadPlanningContext,
    applyPlan: persistPlan,
  })) as unknown as PostgresCatalogAdapterFactory;
  const options: PrivateCatalogCompositionOptions = {
    allowedConnectionId: CONNECTION_ID,
    switches: { executionEnabled: true, applyEnabled: true },
    database: database(),
    connections: { load: loadConnection },
    credentials: { open: openCredential },
    adapterFactory,
    ...(remote ? { agoraApply: remote, agoraMasterRefresh: { refresh: refreshMaster } } : {}),
  };
  return {
    options,
    loadConnection,
    openCredential,
    loadPlanningContext,
    persistPlan,
    refreshMaster,
  };
}

describe("private catalog remote apply gate", () => {
  it("fails closed without an Agora apply-and-readback port and never persists", async () => {
    const configured = fixture();

    const result = await createPrivateCatalogLaneExecutor(configured.options).execute(
      await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] }),
    );

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_AGORA_APPLY_PORT_NOT_CONFIGURED" },
    });
    expect(configured.openCredential).not.toHaveBeenCalled();
    expect(configured.loadPlanningContext).not.toHaveBeenCalled();
    expect(configured.persistPlan).not.toHaveBeenCalled();
  });

  it("fails closed on an incomplete remote readback and never persists", async () => {
    const applyAndReadback = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        status: "applied" as const,
        appliedProductIds: [],
        canonicalProductFingerprints: {},
        providerRequestId: "agora-request-mismatch",
      },
    }));
    const configured = fixture({ applyAndReadback });

    const result = await createPrivateCatalogLaneExecutor(configured.options).execute(
      await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] }),
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        httpStatus: 409,
        message: "CATALOG_APPLY_CONFLICT",
        diagnostic: {
          operation: "catalog.apply",
          route: "catalog.remote-readback",
          errorCode: "CATALOG_REMOTE_READBACK_FINGERPRINT_MISMATCH",
        },
      },
    });
    expect(applyAndReadback).toHaveBeenCalledOnce();
    expect(configured.persistPlan).not.toHaveBeenCalled();
  });

  it("persists only after exact remote readback of every planned Product.Id", async () => {
    const order: string[] = [];
    const applyAndReadback = vi.fn(async (input: Parameters<AgoraCatalogApplyAndReadbackPort["applyAndReadback"]>[0]) => {
      order.push("remote");
      return successfulRemoteReceipt(input.plan);
    });
    const configured = fixture({ applyAndReadback });
    configured.persistPlan.mockImplementation(async ({ plan }: { plan: CatalogPlan }) => {
      order.push("persist");
      return successfulReceipt(plan);
    });
    const runtimeEnvelope = await envelope({
      winerimWineIds: ["1"],
      formatTypes: ["BOTTLE"],
    });

    const result = await createPrivateCatalogLaneExecutor(configured.options).execute(runtimeEnvelope);

    expect(result).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^catalog:applied:1:catalog:v1:/),
    });
    expect(order).toEqual(["remote", "persist"]);
    expect(configured.refreshMaster).toHaveBeenCalledOnce();
    expect(configured.refreshMaster.mock.invocationCallOrder[0])
      .toBeLessThan(configured.loadPlanningContext.mock.invocationCallOrder[0]);
    expect(applyAndReadback).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: CONNECTION_ID,
      messageId: runtimeEnvelope.messageId,
      envelopeIdempotencyKey: runtimeEnvelope.idempotencyKey,
      credential: expect.objectContaining({ read: expect.any(Function) }),
      plan: expect.objectContaining({
        readyToApply: true,
        operations: [expect.objectContaining({
          desired: expect.objectContaining({ productId: "500001" }),
        })],
      }),
    }));
    expect(configured.persistPlan).toHaveBeenCalledOnce();
  });

  it("rejects a matching Product.Id with a mismatched canonical remote fingerprint", async () => {
    const applyAndReadback = vi.fn(async (input: Parameters<AgoraCatalogApplyAndReadbackPort["applyAndReadback"]>[0]) => ({
      ok: true as const,
      receipt: {
        status: "applied" as const,
        appliedProductIds: input.plan.operations.map((operation) => operation.desired.productId),
        canonicalProductFingerprints: Object.fromEntries(input.plan.operations.map((operation) => [
          operation.desired.productId,
          "0".repeat(64),
        ])),
      },
    }));
    const configured = fixture({ applyAndReadback });

    const result = await createPrivateCatalogLaneExecutor(configured.options).execute(
      await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] }),
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        httpStatus: 409,
        message: "CATALOG_APPLY_CONFLICT",
        diagnostic: {
          operation: "catalog.apply",
          route: "catalog.remote-readback",
          errorCode: "CATALOG_REMOTE_READBACK_FINGERPRINT_MISMATCH",
        },
      },
    });
    expect(configured.persistPlan).not.toHaveBeenCalled();
  });

  it("processes a bounded multi-product plan serially as exact one-product readbacks", async () => {
    const order: string[] = [];
    const applyAndReadback = vi.fn(async (input: Parameters<AgoraCatalogApplyAndReadbackPort["applyAndReadback"]>[0]) =>
      (order.push(`remote:${input.plan.operations[0].desired.productId}`), successfulRemoteReceipt(input.plan))
    );
    const configured = fixture({ applyAndReadback });
    configured.persistPlan.mockImplementation(async ({ plan }: { plan: CatalogPlan }) => {
      order.push(`persist:${plan.operations[0].desired.productId}`);
      return successfulReceipt(plan);
    });
    configured.loadPlanningContext.mockResolvedValue({
      ok: true,
      context: {
        ...planningContext(),
        wines: [{
          ...planningContext().wines[0],
          variants: [
            { format: "BOTTLE" as const, salePrice: 20 },
            { format: "GLASS" as const, salePrice: 5 },
          ],
        }],
      },
    });

    const result = await createPrivateCatalogLaneExecutor(configured.options).execute(
      await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE", "GLASS"] }),
    );

    expect(result).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^catalog:applied:2:catalog:v1:/),
    });
    expect(applyAndReadback).toHaveBeenCalledTimes(2);
    expect(applyAndReadback.mock.calls.every((call) => call[0].plan.operations.length === 1)).toBe(true);
    expect(configured.persistPlan).toHaveBeenCalledTimes(2);
    expect(configured.persistPlan.mock.calls.every((call) => call[0].plan.operations.length === 1)).toBe(true);
    expect(order).toEqual([
      "remote:500001",
      "persist:500001",
      "remote:700001",
      "persist:700001",
    ]);
  });

  it("keeps dry-run read-only without a remote port, credential or persistence", async () => {
    const configured = fixture();

    const result = await createPrivateCatalogLaneExecutor(configured.options).execute(
      await envelope({
        dryRun: true,
        winerimWineIds: ["1"],
        formatTypes: ["BOTTLE"],
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^catalog:preview:1:catalog:v1:/),
    });
    expect(configured.openCredential).not.toHaveBeenCalled();
    expect(configured.loadPlanningContext).toHaveBeenCalledOnce();
    expect(configured.persistPlan).not.toHaveBeenCalled();
  });

  it("fails closed before planning when the fresh Agora master port is missing", async () => {
    const configured = fixture({ applyAndReadback: vi.fn() });
    const withoutRefresh = { ...configured.options, agoraMasterRefresh: undefined };

    const result = await createPrivateCatalogLaneExecutor(withoutRefresh).execute(
      await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] }),
    );

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_AGORA_MASTER_REFRESH_PORT_NOT_CONFIGURED" },
    });
    expect(configured.loadPlanningContext).not.toHaveBeenCalled();
    expect(configured.persistPlan).not.toHaveBeenCalled();
  });

  it("fails closed before planning and apply when the fresh Agora master is invalid", async () => {
    const configured = fixture({ applyAndReadback: vi.fn() });
    const refresh = vi.fn(async () => ({
      ok: false as const,
      httpStatus: 503,
      message: "AGORA_MASTER_SALE_CENTER_PRICE_LIST_INVALID",
      diagnostic: {
        operation: "agora.master-refresh",
        route: "agora.master.validate",
        errorCode: "AGORA_MASTER_SALE_CENTER_PRICE_LIST_INVALID",
      },
    }));

    const result = await createPrivateCatalogLaneExecutor({
      ...configured.options,
      agoraMasterRefresh: { refresh },
    }).execute(await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] }));

    expect(result).toMatchObject({
      ok: false,
      failure: {
        httpStatus: 503,
        message: "CATALOG_AGORA_MASTER_REFRESH_FAILED",
        diagnostic: { errorCode: "AGORA_MASTER_SALE_CENTER_PRICE_LIST_INVALID" },
      },
    });
    expect(configured.loadPlanningContext).not.toHaveBeenCalled();
    expect(configured.persistPlan).not.toHaveBeenCalled();
  });

  it("fails closed on remote timeout and never persists", async () => {
    const applyAndReadback = vi.fn(async () => {
      throw new Error("upstream timeout with sensitive diagnostics");
    });
    const configured = fixture({ applyAndReadback });

    const result = await createPrivateCatalogLaneExecutor(configured.options).execute(
      await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] }),
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        httpStatus: 503,
        message: "CATALOG_APPLY_UNAVAILABLE",
        diagnostic: {
          operation: "catalog.apply",
          route: "catalog.remote-apply",
          errorCode: "Error",
        },
      },
    });
    expect(configured.persistPlan).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("sensitive diagnostics");
  });
});

function catalogProduct(
  format: AgoraCatalogRenderableProductState["format"] = "BOTTLE",
  overrides: Partial<AgoraCatalogRenderableProductState> = {},
): AgoraCatalogRenderableProductState {
  const productId = format === "GLASS" ? "700001" : format === "MAGNUM" ? "900001" : "500001";
  const prefix = format === "GLASS" ? "C" : format === "MAGNUM" ? "M" : "B";
  return {
    productId,
    winerimId: "1",
    format,
    label: { name: `${prefix} Viña & Test`, buttonText: `${prefix} Vina Test` },
    family: { id: format === "GLASS" ? "20" : "10", name: format === "GLASS" ? "COPAS WINERIM" : "TINTOS WINERIM" },
    salePrice: format === "GLASS" ? 5.5 : 25,
    costPrice: format === "GLASS" ? 1.25 : 8.4,
    useAsDirectSale: false,
    saleableAsMain: true,
    ...overrides,
  };
}

function catalogPlan(...products: AgoraCatalogRenderableProductState[]): CatalogPlan {
  return {
    version: 1,
    connectionId: CONNECTION_ID,
    provider: "agora",
    sourceRevision: "catalog-xml-fixture-v1",
    action: "apply",
    dryRun: false,
    readyToApply: true,
    formats: [...new Set(products.map((product) => product.format))],
    operations: products.map((product, index) => ({
      kind: "update",
      desired: product as CatalogPlan["operations"][number]["desired"],
      changedFields: ["salePrice", "familyId"],
      idempotency: {
        version: 1,
        scope: "catalog-product-upsert",
        key: `catalog-product-fixture-${index + 1}`,
        fingerprint: `fixture-${index + 1}`,
        connectionId: CONNECTION_ID,
        provider: "agora",
        sourceRevision: "catalog-xml-fixture-v1",
        productId: product.productId,
      },
    })),
    productLabelsById: Object.fromEntries(products.map((product) => [product.productId, product.label])),
    issues: [],
    summary: {
      requestedWines: products.length,
      consideredVariants: products.length,
      create: 0,
      update: products.length,
      unchanged: 0,
      blocked: 0,
    },
    idempotency: {
      version: 1,
      scope: "catalog-plan",
      key: "catalog-plan-fixture",
      fingerprint: "catalog-plan-fixture-fingerprint",
      connectionId: CONNECTION_ID,
      provider: "agora",
      sourceRevision: "catalog-xml-fixture-v1",
    },
  };
}

function xmlProfile(): AgoraCatalogXmlProfile {
  return {
    vatId: "1",
    priceListIds: ["1", "2"],
    warehouseIds: ["1"],
    colorByFormat: {
      BOTTLE: "#8B0000",
      GLASS: "#F5F5DC",
      MAGNUM: "#333333",
    },
    preparationTypeId: "3",
    preparationOrderId: "4",
    orderByProductId: {
      "500001": "101",
      "700001": "102",
      "900001": "103",
    },
  };
}

function agoraMaster(...products: string[]): string {
  return `<?xml version="1.0"?><Export><Products>${products.join("")}</Products></Export>`;
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

function catalogTransport(
  request: HttpRequestPort,
  enabled = true,
  sleep?: (milliseconds: number) => Promise<void>,
) {
  return createAgoraCatalogPlanApplyAndReadbackPort({
    enabled,
    connectionId: CONNECTION_ID,
    baseUrl: "https://agora.example.test",
    allowedHosts: ["agora.example.test"],
    request,
    profile: xmlProfile(),
    ...(sleep ? { sleep } : {}),
  });
}

async function applyCatalogPlan(
  port: ReturnType<typeof catalogTransport>,
  plan: CatalogPlan,
  read = vi.fn(async () => "fixture-agora-token"),
) {
  return port.applyAndReadback({
    connectionId: CONNECTION_ID,
    messageId: "22222222-2222-4222-8222-222222222222",
    envelopeIdempotencyKey: "catalog-envelope-fixture",
    plan,
    credential: { read },
  });
}

describe("single-product Agora catalog plan transport", () => {
  it("stays disabled by default and performs no credential read or HTTP request", async () => {
    const request: HttpRequestPort = { request: vi.fn() };
    const read = vi.fn(async () => "fixture-agora-token");
    const port = createAgoraCatalogPlanApplyAndReadbackPort({
      connectionId: CONNECTION_ID,
      baseUrl: "https://agora.example.test",
      allowedHosts: ["agora.example.test"],
      request,
      profile: xmlProfile(),
    });

    await expect(applyCatalogPlan(port, catalogPlan(catalogProduct()), read)).resolves.toMatchObject({
      ok: false,
      code: "APPLY_REJECTED",
      diagnostic: {
        operation: "catalog.apply",
        route: "catalog.precondition",
        errorCode: "AGORA_CATALOG_APPLY_DISABLED",
      },
    });
    expect(read).not.toHaveBeenCalled();
    expect(request.request).not.toHaveBeenCalled();
  });

  it.each([
    ["BOTTLE" as const, "500001", "B Viña &amp; Test", "#8B0000", "25.00", "8.40"],
    ["GLASS" as const, "700001", "C Viña &amp; Test", "#F5F5DC", "5.50", "1.25"],
  ])("renders a complete scoped %s product", (format, productId, name, color, price, cost) => {
    const xml = renderAgoraCatalogProductXml(catalogProduct(format), xmlProfile());

    expect(xml).toContain(`Id="${productId}"`);
    expect(xml).toContain(`Name="${name}"`);
    expect(xml).toContain(`Color="${color}"`);
    expect(xml).toContain(`MainPrice="${price}"`);
    expect(xml).toContain(`CostPrice="${cost}"`);
    expect(xml.match(/<Product\b/g)).toHaveLength(1);
  });

  it("prefers an exact product color over the format fallback", () => {
    const profile = xmlProfile();
    const xml = renderAgoraCatalogProductXml(catalogProduct("BOTTLE"), {
      ...profile,
      colorByProductId: { "500001": "#E8E4B9" },
    });

    expect(xml).toContain('Color="#E8E4B9"');
    expect(xml).not.toContain('Color="#8B0000"');
  });

  it("renders exact price and family changes without widening the XML envelope", () => {
    const xml = renderAgoraCatalogProductXml(catalogProduct("BOTTLE", {
      family: { id: "88", name: "BLANCOS WINERIM" },
      salePrice: 31.75,
      costPrice: 9.2,
    }), xmlProfile());

    expect(xml).toContain('FamilyId="88"');
    expect(xml.match(/MainPrice="31.75"/g)).toHaveLength(2);
    expect(xml).toContain('CostPrice="9.20"');
    expect(xml).not.toContain("<Families>");
  });

  it("preserves an existing Agora BaseSaleFormatId on a scoped update", () => {
    const xml = renderAgoraCatalogProductXml(catalogProduct("BOTTLE", {
      productId: "818",
      baseSaleFormatId: "864",
      winerimId: "156694",
    }), xmlProfile());

    expect(xml).toContain('Id="818" BaseSaleFormatId="864"');
  });

  it("keeps new product XML unchanged when no BaseSaleFormatId is known", () => {
    const xml = renderAgoraCatalogProductXml(catalogProduct("BOTTLE", {
      productId: "656694",
      winerimId: "156694",
    }), xmlProfile());

    expect(xml).not.toContain("BaseSaleFormatId=");
  });

  it("uses deterministic product id order when a new Agora product has no explicit order yet", () => {
    const xml = renderAgoraCatalogProductXml(catalogProduct("BOTTLE", {
      productId: "512345",
      winerimId: "12345",
    }), xmlProfile());

    expect(xml).toContain('Order="512345"');
    expect(xml).toContain('Id="512345"');
  });

  it("can represent a fail-closed hide without changing price, family or identity", () => {
    const hidden = catalogProduct("BOTTLE", { saleableAsMain: false, useAsDirectSale: false });
    const xml = renderAgoraCatalogProductXml(hidden, xmlProfile());

    expect(xml).toContain('Id="500001"');
    expect(xml).toContain('FamilyId="10"');
    expect(xml).toContain('MainPrice="25.00"');
    expect(xml).toContain('UseAsDirectSale="false"');
    expect(xml).toContain('SaleableAsMain="false"');
  });

  it("rejects a multi-product plan before credentials or transport", async () => {
    const request: HttpRequestPort = { request: vi.fn() };
    const read = vi.fn(async () => "fixture-agora-token");

    await expect(applyCatalogPlan(
      catalogTransport(request),
      catalogPlan(catalogProduct("BOTTLE"), catalogProduct("GLASS")),
      read,
    )).resolves.toMatchObject({
      ok: false,
      code: "APPLY_REJECTED",
      diagnostic: {
        operation: "catalog.apply",
        route: "catalog.precondition",
        errorCode: "AGORA_CATALOG_APPLY_PRECONDITION_REJECTED",
      },
    });
    expect(read).not.toHaveBeenCalled();
    expect(request.request).not.toHaveBeenCalled();
  });

  it("returns an exact fingerprint only after the hardened transport readback matches", async () => {
    const product = catalogProduct();
    const productXml = renderAgoraCatalogProductXml(product, xmlProfile());
    const responses = [
      xmlResponse(agoraMaster()),
      xmlResponse('<ImportResult Success="true" />'),
      xmlResponse(agoraMaster(productXml)),
    ];
    const request: HttpRequestPort = { request: vi.fn(async () => responses.shift()!) };

    const result = await applyCatalogPlan(catalogTransport(request), catalogPlan(product));

    expect(result).toEqual({
      ok: true,
      receipt: {
        status: "applied",
        appliedProductIds: ["500001"],
        canonicalProductFingerprints: {
          "500001": await catalogProductCanonicalFingerprint(product),
        },
      },
    });
    const calls = (request.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((call) => [new URL(call[0]).pathname, call[1].method])).toEqual([
      ["/api/export-master/", "GET"],
      ["/api/import/", "POST"],
      ["/api/export-master/", "GET"],
    ]);
    expect(String(calls[1][1].body)).toContain(productXml);
  });

  it("returns duplicate with the same fingerprint when exact pre-read already matches", async () => {
    const product = catalogProduct("GLASS");
    const productXml = renderAgoraCatalogProductXml(product, xmlProfile());
    const request: HttpRequestPort = { request: vi.fn(async () => xmlResponse(agoraMaster(productXml))) };

    await expect(applyCatalogPlan(catalogTransport(request), catalogPlan(product))).resolves.toEqual({
      ok: true,
      receipt: {
        status: "duplicate",
        appliedProductIds: ["700001"],
        canonicalProductFingerprints: {
          "700001": await catalogProductCanonicalFingerprint(product),
        },
      },
    });
    expect(request.request).toHaveBeenCalledOnce();
  });

  it("fails with a conflict when post-import readback drifts", async () => {
    const product = catalogProduct();
    const productXml = renderAgoraCatalogProductXml(product, xmlProfile());
    const drifted = productXml.replace('MainPrice="25.00"', 'MainPrice="26.00"');
    const responses = [
      xmlResponse(agoraMaster()),
      xmlResponse('<ImportResult Success="true" />'),
      xmlResponse(agoraMaster(drifted)),
      xmlResponse(agoraMaster(drifted)),
      xmlResponse(agoraMaster(drifted)),
    ];
    const request: HttpRequestPort = { request: vi.fn(async () => responses.shift()!) };

    await expect(applyCatalogPlan(catalogTransport(request, true, async () => undefined), catalogPlan(product))).resolves.toMatchObject({
      ok: false,
      code: "APPLY_CONFLICT",
      diagnostic: {
        operation: "catalog.apply",
        route: "catalog.remote-readback",
        errorCode: "AGORA_READBACK_MISMATCH",
      },
    });
  });
});
