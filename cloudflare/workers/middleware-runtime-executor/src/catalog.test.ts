import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  SqlStatement,
} from "../../middleware-api/src/db";
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

type MemoryIntentRow = Record<string, unknown> & {
  idempotency_key: string;
  connection_id: string;
  job: string;
  status: string;
  result: Record<string, unknown>;
  lease_active: boolean;
  lease_token: string | null;
};

function intentDatabase(order: string[] = []) {
  let row: MemoryIntentRow | null = null;
  let failNextTransaction = false;
  let failNextQueryFragment: string | null = null;
  const query = vi.fn(async (statement: SqlStatement) => {
    const compact = statement.text.replace(/\s+/g, " ").trim();
    if (failNextQueryFragment && compact.includes(failNextQueryFragment)) {
      failNextQueryFragment = null;
      throw new Error("fixture DB failure");
    }
    if (compact.startsWith("INSERT INTO public.runtime_idempotency")) {
      order.push("intent.prepare");
      if (row) return { rows: [], rowCount: 0 };
      row = {
        idempotency_key: String(statement.values[0]),
        connection_id: String(statement.values[2]),
        job: String(statement.values[3]),
        status: "RUNNING",
        result: JSON.parse(String(statement.values[6])) as Record<string, unknown>,
        lease_active: true,
        lease_token: String(statement.values[5]),
      };
      return { rows: [{ ...row, lease_active: false }], rowCount: 1 };
    }
    if (compact.startsWith("SELECT") && compact.includes("FROM public.runtime_idempotency")) {
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (compact.startsWith("UPDATE public.runtime_idempotency") && compact.includes("attempt = attempt + 1")) {
      if (!row || row.lease_active) return { rows: [], rowCount: 0 };
      row.lease_token = String(statement.values[2]);
      row.lease_active = true;
      return { rows: [{ ...row, lease_active: false }], rowCount: 1 };
    }
    if (compact.startsWith("UPDATE public.runtime_idempotency") && compact.includes("result = result ||")) {
      if (!row || row.lease_token !== String(statement.values[4])) return { rows: [], rowCount: 0 };
      row.result = {
        ...row.result,
        ...JSON.parse(String(statement.values[0])) as Record<string, unknown>,
      };
      if (compact.includes("status = 'SUCCESS'")) {
        row.status = "SUCCESS";
        row.lease_token = null;
        row.lease_active = false;
      }
      return { rows: [{ ...row, lease_active: false }], rowCount: 1 };
    }
    throw new Error(`unexpected fixture SQL: ${compact}`);
  });
  const transaction = vi.fn(async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => {
    if (failNextTransaction) {
      failNextTransaction = false;
      throw new Error("fixture transaction failure");
    }
    return work({ query });
  });
  return {
    database: { query, transaction } as DatabaseAdapter,
    expireLease() {
      if (row) row.lease_active = false;
    },
    failPrepare() {
      failNextTransaction = true;
    },
    failNextQuery(fragment: string) {
      failNextQueryFragment = fragment;
    },
    snapshot() {
      return row ? structuredClone(row) : null;
    },
  };
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

function fixture(remote?: AgoraCatalogApplyAndReadbackPort, order: string[] = []) {
  const intent = intentDatabase(order);
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
  const preflightPlan = vi.fn(async ({ plan }: { plan: CatalogPlan }) => successfulReceipt(plan));
  const persistPlan = vi.fn(async ({ plan }: { plan: CatalogPlan }) => successfulReceipt(plan));
  const adapterFactory = vi.fn(() => ({
    loadPlanningContext,
    preflightApplyPlan: preflightPlan,
    applyPlan: persistPlan,
  })) as unknown as PostgresCatalogAdapterFactory;
  const options: PrivateCatalogCompositionOptions = {
    allowedConnectionId: CONNECTION_ID,
    switches: { executionEnabled: true, applyEnabled: true },
    database: intent.database,
    connections: { load: loadConnection },
    credentials: { open: openCredential },
    adapterFactory,
    ...(remote ? { agoraApply: remote } : {}),
  };
  return {
    options,
    loadConnection,
    openCredential,
    loadPlanningContext,
    preflightPlan,
    persistPlan,
    intent,
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

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 409, message: "CATALOG_APPLY_CONFLICT" },
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
    const configured = fixture({ applyAndReadback }, order);
    configured.preflightPlan.mockImplementation(async ({ plan }: { plan: CatalogPlan }) => {
      order.push("preflight");
      return successfulReceipt(plan);
    });
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
    expect(order).toEqual(["preflight", "intent.prepare", "remote", "persist"]);
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

  it("fails closed when the durable intent cannot commit before Agora mutation", async () => {
    const applyAndReadback = vi.fn(async (input: Parameters<AgoraCatalogApplyAndReadbackPort["applyAndReadback"]>[0]) =>
      successfulRemoteReceipt(input.plan)
    );
    const configured = fixture({ applyAndReadback });
    configured.intent.failPrepare();

    await expect(createPrivateCatalogLaneExecutor(configured.options).execute(
      await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] }),
    )).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_APPLY_UNAVAILABLE" },
    });
    expect(applyAndReadback).not.toHaveBeenCalled();
    expect(configured.persistPlan).not.toHaveBeenCalled();
    expect(configured.intent.snapshot()).toBeNull();
  });

  it("keeps a lost remote acknowledgement visible and reconciles by exact duplicate readback", async () => {
    const applyAndReadback = vi.fn()
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockImplementation(async (input: Parameters<AgoraCatalogApplyAndReadbackPort["applyAndReadback"]>[0]) => ({
        ...(await successfulRemoteReceipt(input.plan)),
        receipt: {
          ...(await successfulRemoteReceipt(input.plan) as Extract<AgoraCatalogApplyAndReadbackResult, { ok: true }>).receipt,
          status: "duplicate" as const,
        },
      }));
    const configured = fixture({ applyAndReadback });
    const runtimeEnvelope = await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] });
    const executor = createPrivateCatalogLaneExecutor(configured.options);

    await expect(executor.execute(runtimeEnvelope)).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_APPLY_UNAVAILABLE" },
    });
    expect(configured.intent.snapshot()?.result).toMatchObject({
      state: "REMOTE_OUTCOME_UNKNOWN",
      remoteOutcome: "UNKNOWN",
    });

    await expect(executor.execute(runtimeEnvelope)).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_APPLY_UNAVAILABLE" },
    });
    expect(applyAndReadback).toHaveBeenCalledTimes(1);

    configured.intent.expireLease();
    await expect(executor.execute(runtimeEnvelope)).resolves.toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^catalog:duplicate:1:/),
    });
    expect(applyAndReadback).toHaveBeenCalledTimes(2);
    expect(configured.persistPlan).toHaveBeenCalledOnce();
    expect(configured.intent.snapshot()).toMatchObject({
      status: "SUCCESS",
      result: { state: "COMPLETED", remoteOutcome: "DUPLICATE" },
    });
  });

  it("reconciles an applied remote mutation when recording its readback initially fails", async () => {
    let remoteAttempt = 0;
    const applyAndReadback = vi.fn(async (input: Parameters<AgoraCatalogApplyAndReadbackPort["applyAndReadback"]>[0]) => {
      const result = await successfulRemoteReceipt(input.plan);
      return result.ok
        ? { ...result, receipt: { ...result.receipt, status: remoteAttempt++ === 0 ? "applied" as const : "duplicate" as const } }
        : result;
    });
    const configured = fixture({ applyAndReadback });
    configured.intent.failNextQuery("result = result ||");
    const runtimeEnvelope = await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] });
    const executor = createPrivateCatalogLaneExecutor(configured.options);

    await expect(executor.execute(runtimeEnvelope)).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_APPLY_UNAVAILABLE" },
    });
    expect(configured.intent.snapshot()?.result).toMatchObject({ state: "PREPARED" });
    expect(configured.persistPlan).not.toHaveBeenCalled();

    configured.intent.expireLease();
    await expect(executor.execute(runtimeEnvelope)).resolves.toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^catalog:duplicate:1:/),
    });
    expect(applyAndReadback).toHaveBeenCalledTimes(2);
    expect(configured.persistPlan).toHaveBeenCalledOnce();
    expect(configured.intent.snapshot()?.result).toMatchObject({ state: "COMPLETED" });
  });

  it("persists after remote readback and finishes idempotently when DB plan persistence retries", async () => {
    let remoteAttempt = 0;
    const applyAndReadback = vi.fn(async (input: Parameters<AgoraCatalogApplyAndReadbackPort["applyAndReadback"]>[0]) => {
      const result = await successfulRemoteReceipt(input.plan);
      return result.ok
        ? { ...result, receipt: { ...result.receipt, status: remoteAttempt++ === 0 ? "applied" as const : "duplicate" as const } }
        : result;
    });
    const configured = fixture({ applyAndReadback });
    configured.persistPlan
      .mockResolvedValueOnce({ ok: false, code: "APPLY_UNAVAILABLE" })
      .mockImplementation(async ({ plan }: { plan: CatalogPlan }) => successfulReceipt(plan));
    const runtimeEnvelope = await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] });
    const executor = createPrivateCatalogLaneExecutor(configured.options);

    await expect(executor.execute(runtimeEnvelope)).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_APPLY_UNAVAILABLE" },
    });
    expect(configured.intent.snapshot()?.result).toMatchObject({ state: "REMOTE_CONFIRMED" });

    configured.intent.expireLease();
    await expect(executor.execute(runtimeEnvelope)).resolves.toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^catalog:duplicate:1:/),
    });
    expect(applyAndReadback).toHaveBeenCalledTimes(2);
    expect(configured.persistPlan).toHaveBeenCalledTimes(2);
    expect(configured.intent.snapshot()?.result).toMatchObject({ state: "COMPLETED" });
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

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 409, message: "CATALOG_APPLY_CONFLICT" },
    });
    expect(configured.persistPlan).not.toHaveBeenCalled();
  });

  it("rejects a multi-product plan before invoking remote apply", async () => {
    const applyAndReadback = vi.fn(async (input: Parameters<AgoraCatalogApplyAndReadbackPort["applyAndReadback"]>[0]) =>
      successfulRemoteReceipt(input.plan)
    );
    const configured = fixture({ applyAndReadback });
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

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 422, message: "CATALOG_APPLY_REJECTED" },
    });
    expect(applyAndReadback).not.toHaveBeenCalled();
    expect(configured.persistPlan).not.toHaveBeenCalled();
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

  it("fails closed on DB/RLS preflight denial before any remote mutation", async () => {
    const applyAndReadback = vi.fn(async (input: Parameters<AgoraCatalogApplyAndReadbackPort["applyAndReadback"]>[0]) =>
      successfulRemoteReceipt(input.plan)
    );
    const configured = fixture({ applyAndReadback });
    configured.preflightPlan.mockResolvedValue({ ok: false, code: "APPLY_UNAVAILABLE" });

    const result = await createPrivateCatalogLaneExecutor(configured.options).execute(
      await envelope({ winerimWineIds: ["1"], formatTypes: ["BOTTLE"] }),
    );

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_APPLY_UNAVAILABLE" },
    });
    expect(configured.preflightPlan).toHaveBeenCalledOnce();
    expect(applyAndReadback).not.toHaveBeenCalled();
    expect(configured.persistPlan).not.toHaveBeenCalled();
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
) {
  return createAgoraCatalogPlanApplyAndReadbackPort({
    enabled,
    connectionId: CONNECTION_ID,
    baseUrl: "https://agora.example.test",
    allowedHosts: ["agora.example.test"],
    request,
    profile: xmlProfile(),
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

    await expect(applyCatalogPlan(port, catalogPlan(catalogProduct()), read)).resolves.toEqual({
      ok: false,
      code: "APPLY_REJECTED",
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

  it("can represent a fail-closed hide without changing price, family or identity", () => {
    const hidden = catalogProduct("BOTTLE", { saleableAsMain: false, useAsDirectSale: false });
    const xml = renderAgoraCatalogProductXml(hidden, xmlProfile());

    expect(xml).toContain('Id="500001"');
    expect(xml).toContain('FamilyId="10"');
    expect(xml).toContain('MainPrice="25.00"');
    expect(xml).toContain('UseAsDirectSale="false"');
    expect(xml).toContain('SaleableAsMain="false"');
  });

  it("hides through an exact live baseline and certifies the resulting desired fingerprint", async () => {
    const hidden = catalogProduct("BOTTLE", { saleableAsMain: false, useAsDirectSale: false });
    const activeBaseline = { ...hidden, saleableAsMain: true };
    const baselineXml = renderAgoraCatalogProductXml(activeBaseline, xmlProfile());
    const hiddenXml = renderAgoraCatalogProductXml(hidden, xmlProfile());
    const basePlan = catalogPlan(hidden);
    const plan: CatalogPlan = {
      ...basePlan,
      operations: [{
        ...basePlan.operations[0],
        changedFields: ["saleableAsMain"],
      }],
    };
    const responses = [
      xmlResponse(agoraMaster(baselineXml)),
      xmlResponse(agoraMaster(baselineXml)),
      xmlResponse('<ImportResult Success="true" />'),
      xmlResponse(agoraMaster(hiddenXml)),
    ];
    const request: HttpRequestPort = { request: vi.fn(async () => responses.shift()!) };

    await expect(applyCatalogPlan(catalogTransport(request), plan)).resolves.toEqual({
      ok: true,
      receipt: {
        status: "applied",
        appliedProductIds: ["500001"],
        canonicalProductFingerprints: {
          "500001": await catalogProductCanonicalFingerprint(hidden),
        },
      },
    });
    const post = (request.request as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[1].method === "POST");
    expect(String(post?.[1].body)).toContain('MainPrice="25.00"');
    expect(String(post?.[1].body)).toContain('FamilyId="10"');
    expect(String(post?.[1].body)).toContain('SaleableAsMain="false"');
  });

  it("rejects a multi-product plan before credentials or transport", async () => {
    const request: HttpRequestPort = { request: vi.fn() };
    const read = vi.fn(async () => "fixture-agora-token");

    await expect(applyCatalogPlan(
      catalogTransport(request),
      catalogPlan(catalogProduct("BOTTLE"), catalogProduct("GLASS")),
      read,
    )).resolves.toEqual({ ok: false, code: "APPLY_REJECTED" });
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
    ];
    const request: HttpRequestPort = { request: vi.fn(async () => responses.shift()!) };

    await expect(applyCatalogPlan(catalogTransport(request), catalogPlan(product))).resolves.toEqual({
      ok: false,
      code: "APPLY_CONFLICT",
    });
  });
});
