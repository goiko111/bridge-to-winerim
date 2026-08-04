import { describe, expect, it, vi } from "vitest";

import type { HttpRequestPort } from "../../middleware-runtime/src/adapters/http";
import type { OutboundTask } from "../../middleware-runtime/src/handlers/outbound";
import {
  createAgoraOutboundTransport,
  type AgoraOutboundTransportOptions,
} from "./agoraOutboundTransport";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function task(taskType: string, payload: Record<string, unknown>, externalId: string | null = null): OutboundTask {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    connectionId: CONNECTION_ID,
    provider: "agora",
    taskType,
    payload,
    status: "RUNNING",
    attempts: 1,
    maxAttempts: 3,
    createdAt: "2026-08-03T10:00:00.000Z",
    idempotencyKey: "outbound-fixture-1",
    externalId,
  };
}

function master(...products: string[]): string {
  return `<?xml version="1.0"?><Export><Products>${products.join("")}</Products></Export>`;
}

const bottle = '<Product Id="500101" Name="B Test" FamilyId="10" VatId="1" UseAsDirectSale="true" SaleableAsMain="true"><Prices><Price PriceListId="1" MainPrice="25.00" /></Prices></Product>';
const secondBottle = '<Product Id="500102" Name="B Test Two" FamilyId="10" VatId="1" UseAsDirectSale="true" SaleableAsMain="true"><Prices><Price PriceListId="1" MainPrice="30.00" /></Prices></Product>';
const migratedBottle = '<Product Id="500101" Name="B Test" FamilyId="20" VatId="1" UseAsDirectSale="true" SaleableAsMain="true"><Prices><Price PriceListId="1" MainPrice="25.00" /></Prices></Product>';
const hiddenBottle = '<Product Id="500101" Name="B Test" FamilyId="10" VatId="1" UseAsDirectSale="false" SaleableAsMain="false"><Prices><Price PriceListId="1" MainPrice="25.00" /></Prices></Product>';

function hidePayload(product = bottle, ids = ["500101"]): Record<string, unknown> {
  return {
    _product_ids: ids,
    _baseline_import_xml: `<Import><Products>${product}</Products></Import>`,
  };
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

function configured(
  request: HttpRequestPort,
  overrides: Partial<Pick<AgoraOutboundTransportOptions, "timeoutMs" | "maxResponseBytes">> = {},
) {
  return createAgoraOutboundTransport({
    connectionId: CONNECTION_ID,
    baseUrl: "https://agora.example.test",
    allowedHosts: ["agora.example.test"],
    credential: { read: () => "fixture-token" },
    request,
    ...overrides,
  });
}

async function execute(transport: ReturnType<typeof configured>, outboundTask: OutboundTask) {
  return transport.execute({
    task: outboundTask,
    context: { idempotencyKey: "outbound-fixture-1", attempt: 1, maxAttempts: 3 },
  });
}

describe("Agora outbound transport", () => {
  it("blocks a host outside the explicit allowlist without reading credentials or sending traffic", async () => {
    const read = vi.fn(() => "fixture-token");
    const request = { request: vi.fn() };
    const transport = createAgoraOutboundTransport({
      connectionId: CONNECTION_ID,
      baseUrl: "https://agora.example.test",
      allowedHosts: ["different.example.test"],
      credential: { read },
      request,
    });

    await expect(execute(transport, task("AGORA_HIDE_PRODUCT", { _product_ids: ["500101"] }))).resolves.toEqual({
      kind: "blocked",
      reason: "AGORA_HOST_NOT_ALLOWLISTED",
    });
    expect(read).not.toHaveBeenCalled();
    expect(request.request).not.toHaveBeenCalled();
  });

  it("blocks unsupported tasks and incomplete upserts before any HTTP request", async () => {
    const request = { request: vi.fn() };
    const transport = configured(request);

    await expect(execute(transport, task("AGORA_DELETE_PRODUCT", {}))).resolves.toMatchObject({
      kind: "blocked",
      reason: "AGORA_OUTBOUND_TASK_UNSUPPORTED",
    });
    await expect(execute(transport, task("AGORA_XML_UPSERT_PRODUCT", {
      _winerim_wine_id: "101",
      _format_types: ["BOTTLE"],
    }))).resolves.toMatchObject({
      kind: "blocked",
      reason: "AGORA_UPSERT_IMPORT_XML_REQUIRED",
    });
    expect(request.request).not.toHaveBeenCalled();
  });

  it("rejects a task from another connection or an altered idempotency context", async () => {
    const request = { request: vi.fn() };
    const transport = configured(request);
    const wrongConnection = { ...task("AGORA_HIDE_PRODUCT", { _product_ids: ["500101"] }), connectionId: "other" };

    await expect(execute(transport, wrongConnection)).resolves.toMatchObject({
      kind: "blocked",
      reason: "AGORA_OUTBOUND_TASK_IDENTITY_INVALID",
    });
    await expect(transport.execute({
      task: task("AGORA_HIDE_PRODUCT", { _product_ids: ["500101"] }),
      context: { idempotencyKey: "altered", attempt: 1, maxAttempts: 3 },
    })).resolves.toMatchObject({
      kind: "blocked",
      reason: "AGORA_OUTBOUND_EXECUTION_CONTEXT_INVALID",
    });
    expect(request.request).not.toHaveBeenCalled();
  });

  it("blocks an upsert whose expected Product.Id set differs from the supplied XML", async () => {
    const request = { request: vi.fn() };
    const transport = configured(request);

    await expect(execute(transport, task("AGORA_XML_UPSERT_PRODUCT", {
      _import_xml: `<Import><Products>${bottle}</Products></Import>`,
      _expected_product_ids: ["500999"],
    }))).resolves.toMatchObject({
      kind: "blocked",
      reason: "AGORA_UPSERT_PRODUCT_IDS_MISMATCH",
    });
    expect(request.request).not.toHaveBeenCalled();
  });

  it("blocks an upsert containing sections outside the exact Products envelope", async () => {
    const request = { request: vi.fn() };
    const transport = configured(request);

    await expect(execute(transport, task("AGORA_XML_UPSERT_PRODUCT", {
      _import_xml: `<Import><Families><Family Id="10" /></Families><Products>${bottle}</Products></Import>`,
      _expected_product_ids: ["500101"],
    }))).resolves.toMatchObject({
      kind: "blocked",
      reason: "AGORA_UPSERT_IMPORT_XML_AMBIGUOUS",
    });
    expect(request.request).not.toHaveBeenCalled();
  });

  it("rejects a multi-product upsert before any HTTP request", async () => {
    const request = { request: vi.fn() };

    await expect(execute(configured(request), task("AGORA_XML_UPSERT_PRODUCT", {
      _import_xml: `<Import><Products>${bottle}${secondBottle}</Products></Import>`,
      _expected_product_ids: ["500101", "500102"],
    }))).resolves.toEqual({
      kind: "blocked",
      reason: "AGORA_MULTI_PRODUCT_MUTATION_REJECTED",
    });
    expect(request.request).not.toHaveBeenCalled();
  });

  it("upserts only from complete XML and certifies only after exact master readback", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const request: HttpRequestPort = {
      request: vi.fn(async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) return response(master());
        if (calls.length === 2) return response("<ImportResult Success=\"true\" />");
        return response(master(bottle));
      }),
    };
    const transport = configured(request);
    const xml = `<?xml version="1.0"?><Import><Products>${bottle}</Products></Import>`;

    await expect(execute(transport, task("AGORA_XML_UPSERT_PRODUCT", {
      _import_xml: xml,
      _expected_product_ids: ["500101"],
    }))).resolves.toEqual({
      kind: "success",
      externalId: "500101",
      detail: "agora-import-readback-verified:500101",
    });
    expect(calls.map((call) => [new URL(call.url).pathname, call.init.method])).toEqual([
      ["/api/export-master/", "GET"],
      ["/api/import/", "POST"],
      ["/api/export-master/", "GET"],
    ]);
    expect(calls[1].init.body).toBe(xml);
    expect(calls[1].init.headers).toMatchObject({ "Content-Type": "application/xml; charset=utf-8" });
  });

  it("is idempotent by exact pre-read and does not repeat an already applied upsert", async () => {
    const request: HttpRequestPort = { request: vi.fn(async () => response(master(bottle))) };
    const transport = configured(request);

    await expect(execute(transport, task("AGORA_XML_UPSERT_PRODUCT", {
      _import_xml: `<Import><Products>${bottle}</Products></Import>`,
      _expected_product_ids: ["500101"],
    }))).resolves.toMatchObject({
      kind: "superseded",
      evidence: {
        verified: true,
        taskId: "22222222-2222-4222-8222-222222222222",
        connectionId: CONNECTION_ID,
        source: "provider_readback",
      },
    });
    expect(request.request).toHaveBeenCalledOnce();
    expect((request.request as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("GET");
  });

  it("never certifies a successful POST when the product readback differs", async () => {
    const mismatched = bottle.replace('MainPrice="25.00"', 'MainPrice="26.00"');
    const responses = [response(master()), response("ok"), response(master(mismatched))];
    const request: HttpRequestPort = { request: vi.fn(async () => responses.shift()!) };
    const transport = configured(request);

    await expect(execute(transport, task("AGORA_XML_UPSERT_PRODUCT", {
      _import_xml: `<Import><Products>${bottle}</Products></Import>`,
      _expected_product_ids: ["500101"],
    }))).resolves.toEqual({
      kind: "blocked",
      reason: "AGORA_READBACK_MISMATCH",
      detail: "500101",
    });
  });

  it("migrates a family by patching the complete live product and verifies the complete result", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [response(master(bottle)), response(master(bottle)), response("ok"), response(master(migratedBottle))];
    const request: HttpRequestPort = {
      request: vi.fn(async (url, init) => {
        calls.push({ url, init });
        return responses.shift()!;
      }),
    };

    await expect(execute(configured(request), task("AGORA_MIGRATE_FAMILY", {
      productId: "500101",
      targetFamilyId: "20",
      winerimWineId: "101",
      format: "BOTTLE",
    }, "500101"))).resolves.toMatchObject({ kind: "success", externalId: "500101" });
    const posted = String(calls.find((call) => call.init.method === "POST")?.init.body);
    expect(posted).toContain('FamilyId="20"');
    expect(posted).toContain('<Price PriceListId="1" MainPrice="25.00" />');
    expect(posted).toContain('Name="B Test"');
  });

  it("treats an already migrated family as verified superseded and sends no POST", async () => {
    const request: HttpRequestPort = { request: vi.fn(async () => response(master(migratedBottle))) };

    await expect(execute(configured(request), task("AGORA_MIGRATE_FAMILY", {
      productId: "500101",
      targetFamilyId: "20",
    }))).resolves.toMatchObject({ kind: "superseded" });
    expect(request.request).toHaveBeenCalledTimes(2);
    expect((request.request as ReturnType<typeof vi.fn>).mock.calls.every((call) => call[1].method === "GET")).toBe(true);
  });

  it("blocks migrate on pre-import drift instead of overwriting a concurrent product change", async () => {
    const drifted = bottle.replace('MainPrice="25.00"', 'MainPrice="27.00"');
    const responses = [response(master(bottle)), response(master(drifted))];
    const request: HttpRequestPort = { request: vi.fn(async () => responses.shift()!) };

    await expect(execute(configured(request), task("AGORA_MIGRATE_FAMILY", {
      productId: "500101",
      targetFamilyId: "20",
    }))).resolves.toEqual({
      kind: "blocked",
      reason: "AGORA_PRECONDITION_DRIFT",
      detail: "500101",
    });
    expect((request.request as ReturnType<typeof vi.fn>).mock.calls.every((call) => call[1].method === "GET")).toBe(true);
  });

  it("blocks migrate when the exact product is absent and never imports", async () => {
    const request: HttpRequestPort = { request: vi.fn(async () => response(master())) };

    await expect(execute(configured(request), task("AGORA_MIGRATE_FAMILY", {
      productId: "500101",
      targetFamilyId: "20",
    }))).resolves.toEqual({
      kind: "blocked",
      reason: "AGORA_MASTER_PRODUCT_MISSING",
      detail: "500101",
    });
    expect(request.request).toHaveBeenCalledOnce();
  });

  it("hides products by preserving their complete live shape and verifying both flags", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [response(master(bottle)), response(master(bottle)), response("ok"), response(master(hiddenBottle))];
    const request: HttpRequestPort = {
      request: vi.fn(async (url, init) => {
        calls.push({ url, init });
        return responses.shift()!;
      }),
    };

    await expect(execute(configured(request), task("AGORA_HIDE_PRODUCT", hidePayload())))
      .resolves.toMatchObject({ kind: "success", externalId: "500101" });
    const posted = String(calls.find((call) => call.init.method === "POST")?.init.body);
    expect(posted).toContain('UseAsDirectSale="false"');
    expect(posted).toContain('SaleableAsMain="false"');
    expect(posted).toContain('<Price PriceListId="1" MainPrice="25.00" />');
  });

  it("does not repeat a hide after exact readback shows it already applied", async () => {
    const request: HttpRequestPort = { request: vi.fn(async () => response(master(hiddenBottle))) };

    await expect(execute(configured(request), task("AGORA_HIDE_PRODUCT", hidePayload(hiddenBottle))))
      .resolves.toMatchObject({ kind: "superseded" });
    expect((request.request as ReturnType<typeof vi.fn>).mock.calls.every((call) => call[1].method === "GET")).toBe(true);
  });

  it("blocks a single-product hide when the requested Product.Id is absent", async () => {
    const request: HttpRequestPort = { request: vi.fn(async () => response(master(bottle))) };

    await expect(execute(configured(request), task("AGORA_HIDE_PRODUCT", hidePayload(secondBottle, ["500102"]))))
      .resolves.toEqual({
      kind: "blocked",
      reason: "AGORA_MASTER_PRODUCT_MISSING",
      detail: "500102",
    });
    expect(request.request).toHaveBeenCalledOnce();
  });

  it("fails closed before POST when the exact hide baseline has stale name, family or price", async () => {
    const live = bottle.replace('Name="B Test"', 'Name="B Live"').replace('MainPrice="25.00"', 'MainPrice="27.00"');
    const request: HttpRequestPort = { request: vi.fn(async () => response(master(live))) };

    await expect(execute(configured(request), task("AGORA_HIDE_PRODUCT", hidePayload())))
      .resolves.toEqual({
        kind: "blocked",
        reason: "AGORA_PRECONDITION_DRIFT",
        detail: "500101",
      });
    expect(request.request).toHaveBeenCalledOnce();
    expect((request.request as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("GET");
  });

  it("rejects a multi-product hide before POST even when every product exists", async () => {
    const request: HttpRequestPort = {
      request: vi.fn(async () => response(master(bottle, secondBottle))),
    };

    await expect(execute(configured(request), task("AGORA_HIDE_PRODUCT", {
      _product_ids: ["500101", "500102"],
    }))).resolves.toEqual({
      kind: "blocked",
      reason: "AGORA_MULTI_PRODUCT_MUTATION_REJECTED",
    });
    expect(request.request).toHaveBeenCalledOnce();
    expect((request.request as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("GET");
  });

  it("returns a retry-classifiable HTTP failure and does not claim success on readback outage", async () => {
    const responses = [response(master()), response("ok"), response("unavailable", 503)];
    const request: HttpRequestPort = { request: vi.fn(async () => responses.shift()!) };

    await expect(execute(configured(request), task("AGORA_XML_UPSERT_PRODUCT", {
      _import_xml: `<Import><Products>${bottle}</Products></Import>`,
      _expected_product_ids: ["500101"],
    }))).resolves.toEqual({
      kind: "failure",
      failure: { httpStatus: 503, message: "AGORA_READBACK_HTTP_503" },
    });
  });

  it("does not certify a POST when a 200 readback lacks the Products master container", async () => {
    const responses = [response(master()), response("ok"), response("<Export><Families /></Export>")];
    const request: HttpRequestPort = { request: vi.fn(async () => responses.shift()!) };

    await expect(execute(configured(request), task("AGORA_XML_UPSERT_PRODUCT", {
      _import_xml: `<Import><Products>${bottle}</Products></Import>`,
      _expected_product_ids: ["500101"],
    }))).resolves.toEqual({
      kind: "blocked",
      reason: "AGORA_PRODUCTS_CONTAINER_INVALID",
    });
  });

  it("rejects readback Products outside the unique direct Products container", async () => {
    const invalidReadbacks = [
      `<Export><Products /><Audit>${bottle}</Audit></Export>`,
      `<Export><Products /><Products>${bottle}</Products></Export>`,
      `<Export><Products><Wrapper>${bottle}</Wrapper></Products></Export>`,
    ];

    for (const invalidReadback of invalidReadbacks) {
      const responses = [response(master()), response("ok"), response(invalidReadback)];
      const request: HttpRequestPort = { request: vi.fn(async () => responses.shift()!) };
      const result = await execute(configured(request), task("AGORA_XML_UPSERT_PRODUCT", {
        _import_xml: `<Import><Products>${bottle}</Products></Import>`,
        _expected_product_ids: ["500101"],
      }));

      expect(result).toMatchObject({ kind: "blocked" });
    }
  });

  it("cancels a chunked readback as soon as the incremental byte limit is exceeded", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(64)));
      },
      cancel,
    });
    const request: HttpRequestPort = {
      request: vi.fn(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "application/xml" },
      })),
    };

    await expect(execute(configured(request, { maxResponseBytes: 32 }), task("AGORA_HIDE_PRODUCT", {
      _product_ids: ["500101"],
    }))).resolves.toEqual({
      kind: "blocked",
      reason: "AGORA_RESPONSE_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out and cancels a readback stream that never yields a body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const request: HttpRequestPort = {
      request: vi.fn(async () => new Response(stream, {
        status: 200,
        headers: { "content-type": "application/xml" },
      })),
    };

    await expect(execute(configured(request, { timeoutMs: 5 }), task("AGORA_HIDE_PRODUCT", {
      _product_ids: ["500101"],
    }))).resolves.toEqual({
      kind: "failure",
      failure: { httpStatus: 408, message: "AGORA_READBACK_TIMEOUT" },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("blocks malformed XML and credentials containing header injection", async () => {
    const request = { request: vi.fn() };
    const malformed = configured(request);
    await expect(execute(malformed, task("AGORA_XML_UPSERT_PRODUCT", {
      _import_xml: '<Import><Products><Product Id="500101"><Price></Products></Import>',
      _expected_product_ids: ["500101"],
    }))).resolves.toMatchObject({ kind: "blocked", reason: "AGORA_XML_NESTING_INVALID" });

    const injected = createAgoraOutboundTransport({
      connectionId: CONNECTION_ID,
      baseUrl: "https://agora.example.test",
      allowedHosts: ["agora.example.test"],
      credential: { read: () => "token\r\nInjected: true" },
      request,
    });
    await expect(execute(injected, task("AGORA_HIDE_PRODUCT", { _product_ids: ["500101"] }))).resolves.toMatchObject({
      kind: "blocked",
      reason: "AGORA_CREDENTIAL_UNAVAILABLE",
    });
    expect(request.request).not.toHaveBeenCalled();
  });
});
