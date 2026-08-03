import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
  TransactionOptions,
} from "../../middleware-api/src/db";
import type { RuntimeEnvelopeV1 } from "../../middleware-runtime/src/contracts";
import { createRuntimeEnvelope } from "../../middleware-runtime/src/idempotency";
import {
  advanceSalesCursorFailClosed,
  executeAgoraSalesEnvelope,
  normalizeAgoraDefinitiveInvoices,
  parseAgoraInvoicesPayload,
  salesBusinessDays,
  salesConnectionGateFailure,
  salesLaneFlags,
  salesLaneGateFailure,
  SalesLaneError,
  type SalesLaneConnection,
} from "./sales";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function result<Row extends Record<string, unknown>>(rows: Row[] = [], rowCount = rows.length): QueryResult<Row> {
  return { rows, rowCount };
}

function databaseHarness(
  route: (statement: SqlStatement) => QueryResult<Record<string, unknown>>,
) {
  const statements: SqlStatement[] = [];
  const transactions: TransactionOptions[] = [];
  const query = async <Row extends Record<string, unknown>>(statement: SqlStatement): Promise<QueryResult<Row>> => {
    statements.push(statement);
    return route(statement) as QueryResult<Row>;
  };
  const database: DatabaseAdapter = {
    query,
    transaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>, options = {}) => {
      transactions.push(options);
      return work({ query });
    },
  };
  return { database, statements, transactions };
}

async function envelope(
  job: "sales.auto-sync" | "sales.sync-intraday",
  payload: RuntimeEnvelopeV1["payload"] = { scheduled: true },
): Promise<RuntimeEnvelopeV1> {
  return createRuntimeEnvelope({
    connectionId: CONNECTION_ID,
    job,
    dedupeScope: `sales-worker:${job}`,
    payload,
    source: { kind: "queue", eventId: `sales-worker:${job}` },
    createdAt: "2026-08-03T12:00:00.000Z",
  });
}

function connection(overrides: Partial<SalesLaneConnection> = {}): SalesLaneConnection {
  return {
    connectionId: CONNECTION_ID,
    provider: "agora",
    baseUrl: "https://agora.example.test",
    enabled: true,
    lastBusinessDaySynced: "2026-08-01",
    providerConfig: {
      time_zone: "Europe/Madrid",
      intraday_sales_sync_enabled: true,
      runtime_sales_cutover_business_day: "2026-08-02",
    },
    ...overrides,
  };
}

function invoicePayload() {
  return {
    Invoices: [{
      InvoiceId: "INV-42",
      TicketId: "TICKET-42",
      BusinessDay: "2026-08-03",
      DocumentType: "BasicInvoice",
      InvoiceItems: [{
        Lines: [{
          Index: 1,
          ProductId: "500100",
          SaleFormatId: "500100",
          ProductName: "B Test Bottle",
          SaleFormatName: "Botella",
          FamilyName: "TINTOS WINERIM",
          Quantity: 1,
          UnitPrice: 25,
          TotalAmount: 25,
          CreationDate: "2026-08-03T13:00:00",
        }, {
          Index: 2,
          ProductId: 0,
          SaleFormatId: "700101",
          ProductName: "C Test Glass",
          SaleFormatName: "Copa",
          FamilyName: "COPAS WINERIM",
          Quantity: 2,
          UnitPrice: 6,
          TotalAmount: 12,
          CreationDate: "2026-08-03T13:02:00",
        }],
      }],
    }],
  };
}

describe("private sales executor invoice loader", () => {
  it("recognizes only bounded invoice containers and preserves legacy document identity", () => {
    expect(parseAgoraInvoicesPayload(invoicePayload())).toMatchObject({ recognized: true });
    expect(parseAgoraInvoicesPayload({ Data: invoicePayload() })).toMatchObject({ recognized: true });
    expect(parseAgoraInvoicesPayload({ unknown: {}, alsoUnknown: true })).toEqual({
      recognized: false,
      invoices: [],
    });

    const [document] = normalizeAgoraDefinitiveInvoices(invoicePayload(), "2026-08-03");
    expect(document).toMatchObject({
      documentId: "INV-42",
      lifecycleId: "TICKET-42",
      identitySource: "PROVIDER",
      businessDay: "2026-08-03",
      kind: "DEFINITIVE_INVOICE",
      isRefund: false,
    });
    expect(document.lines).toEqual([
      expect.objectContaining({
        lineId: "INV-42:0:1",
        providerProductId: "500100",
        saleFormatId: "500100",
        suggestedVariant: "BOTTLE",
        quantity: 1,
        soldAt: "2026-08-03T13:00:00",
      }),
      expect.objectContaining({
        lineId: "INV-42:0:2",
        providerProductId: "700101",
        saleFormatId: "700101",
        suggestedVariant: "GLASS",
        quantity: 2,
        soldAt: "2026-08-03T13:02:00",
      }),
    ]);
  });

  it("keeps refunds auditable and rejects an unrecognized successful payload", () => {
    const refund = normalizeAgoraDefinitiveInvoices({ Invoices: [{
      Number: 7,
      Serie: "R",
      DocumentType: "BasicRefund",
      BusinessDay: "2026-08-03",
      Totals: { GrossAmount: -10 },
      InvoiceItems: [],
    }] }, "2026-08-03");
    expect(refund[0]).toMatchObject({
      documentId: "refund:2026-08-03:r:7",
      isRefund: true,
    });
    expect(() => normalizeAgoraDefinitiveInvoices({ status: "ok" }, "2026-08-03"))
      .toThrowError(expect.objectContaining({ code: "AGORA_INVOICES_PAYLOAD_UNRECOGNIZED" }));
  });
});

describe("private sales executor gates and scheduling", () => {
  it("keeps every live switch closed unless sales, cursor and DLQ are all attested", () => {
    const disabled = salesLaneFlags({});
    expect(disabled).toEqual({ executionEnabled: false, cursorEnabled: false, dlqReady: false });
    expect(salesLaneGateFailure(disabled, false)).toBe("RUNTIME_SALES_EXECUTION_DISABLED");
    expect(salesLaneGateFailure({ ...disabled, executionEnabled: true }, false))
      .toBe("RUNTIME_SALES_CURSOR_DISABLED");
    expect(salesLaneGateFailure({ executionEnabled: true, cursorEnabled: true, dlqReady: false }, false))
      .toBe("RUNTIME_SALES_DLQ_NOT_READY");
    expect(salesLaneGateFailure({ executionEnabled: true, cursorEnabled: true, dlqReady: true }, false))
      .toBeNull();
    expect(salesLaneGateFailure(disabled, true)).toBeNull();
  });

  it("processes definitive closed days in order and intraday only for today", async () => {
    expect(salesBusinessDays(
      await envelope("sales.auto-sync"),
      connection(),
      Date.parse("2026-08-03T12:00:00.000Z"),
      2,
    )).toEqual(["2026-08-02"]);
    expect(salesBusinessDays(
      await envelope("sales.sync-intraday"),
      connection(),
      Date.parse("2026-08-03T12:00:00.000Z"),
    )).toEqual(["2026-08-03"]);
  });

  it("honors the per-connection intraday kill switch while preserving dry-run", () => {
    const disabled = connection({
      providerConfig: {
        intraday_sales_sync_enabled: false,
        runtime_sales_cutover_business_day: "2026-08-02",
      },
    });
    expect(salesConnectionGateFailure(disabled, "sales.sync-intraday", false))
      .toBe("SALES_INTRADAY_SYNC_DISABLED");
    expect(salesConnectionGateFailure(disabled, "sales.sync-intraday", true)).toBeNull();
    expect(salesConnectionGateFailure(disabled, "sales.auto-sync", false)).toBeNull();
  });

  it("requires an explicit cutover day and rejects pre-cutover documents", async () => {
    const missing = connection({ providerConfig: { intraday_sales_sync_enabled: true } });
    expect(salesConnectionGateFailure(missing, "sales.auto-sync", false))
      .toBe("SALES_CUTOVER_DAY_REQUIRED");
    const beforeCutover = await envelope("sales.auto-sync", { businessDay: "2026-08-01" });
    expect(() => salesBusinessDays(
      beforeCutover,
      connection(),
      Date.parse("2026-08-03T12:00:00.000Z"),
    )).toThrowError(expect.objectContaining({ code: "SALES_BEFORE_CUTOVER_REJECTED" }));
  });
});

describe("private sales executor fail-closed cursor", () => {
  it("verifies documents, sales claims and stock claims in the same serializable transaction", async () => {
    const fake = databaseHarness((statement) => {
      if (statement.text.includes("FROM public.pos_connections") && statement.text.includes("FOR UPDATE")) {
        return result([{ enabled: true, provider: "agora", last_business_day_synced: "2026-08-01" }]);
      }
      if (statement.text.includes("FROM public.sales_events")) return result([{ event_count: 2 }]);
      if (statement.text.includes("job = 'sales.claim'")) return result([{ successful: 2 }]);
      if (statement.text.includes("job = 'stock.mutation'")) return result([{ successful: 2 }]);
      if (statement.text.includes("UPDATE public.pos_connections")) {
        return result([{ last_business_day_synced: "2026-08-02" }]);
      }
      throw new Error(`unexpected SQL: ${statement.text}`);
    });

    await expect(advanceSalesCursorFailClosed({
      database: fake.database,
      connectionId: CONNECTION_ID,
      throughBusinessDay: "2026-08-02",
      providerDocumentIds: ["invoice-1", "invoice-2"],
      claimKeys: ["claim-1", "claim-2"],
      mutationKeys: ["mutation-1", "mutation-2"],
      now: Date.parse("2026-08-03T12:00:00.000Z"),
    })).resolves.toBe(true);
    expect(fake.transactions).toEqual([{ isolationLevel: "serializable", readOnly: false }]);
    expect(fake.statements.at(-1)?.text).toContain("UPDATE public.pos_connections");
  });

  it("does not update the cursor when persisted document readback is incomplete", async () => {
    const fake = databaseHarness((statement) => {
      if (statement.text.includes("FROM public.pos_connections")) {
        return result([{ enabled: true, provider: "agora", last_business_day_synced: "2026-08-01" }]);
      }
      if (statement.text.includes("FROM public.sales_events")) return result([{ event_count: 0 }]);
      throw new Error("no later SQL is allowed");
    });

    await expect(advanceSalesCursorFailClosed({
      database: fake.database,
      connectionId: CONNECTION_ID,
      throughBusinessDay: "2026-08-02",
      providerDocumentIds: ["invoice-1"],
      claimKeys: [],
      mutationKeys: [],
      now: Date.parse("2026-08-03T12:00:00.000Z"),
    })).rejects.toMatchObject({ code: "SALES_CURSOR_DOCUMENT_READBACK_FAILED" });
    expect(fake.statements.some((statement) => statement.text.includes("UPDATE public.pos_connections"))).toBe(false);
  });
});

describe("private sales executor operational composition", () => {
  it("loads definitive Invoices, persists documents and applies bottle plus certified live glass", async () => {
    let eventIndex = 0;
    const fake = databaseHarness((statement) => {
      const query = statement.text;
      if (query.includes("FROM public.pos_connections") && !query.includes("FOR UPDATE")) {
        return result([{
          connection_id: CONNECTION_ID,
          provider: "agora",
          base_url: "https://agora.example.test",
          enabled: true,
          last_business_day_synced: "2026-08-02",
          provider_config: { time_zone: "Europe/Madrid", intraday_sales_sync_enabled: true, runtime_sales_cutover_business_day: "2026-08-03" },
        }]);
      }
      if (query.includes("FROM public.product_mappings")) {
        return result([{
          mapping_id: "mapping-bottle",
          provider_product_id: "500100",
          provider_product_name: "B Test Bottle",
          winerim_wine_id: "100",
          format_type: "BOTTLE",
          stock_id: "1001",
          wine_active: true,
        }, {
          mapping_id: "mapping-glass",
          provider_product_id: "700101",
          provider_product_name: "C Test Glass",
          winerim_wine_id: "101",
          format_type: "GLASS",
          stock_id: "1012",
          wine_active: true,
        }]);
      }
      if (query.includes("FROM public.runtime_idempotency")) {
        return result();
      }
      if (query.includes("INSERT INTO public.sales_events")) {
        eventIndex += 1;
        return result([{ id: `22222222-2222-4222-8222-${String(eventIndex).padStart(12, "0")}` }]);
      }
      if (query.includes("conflict_count")) return result([{ conflict_count: 0 }]);
      if (query.includes("FROM public.stock_sync_log") && query.includes("FOR UPDATE")) return result();
      if (query.includes("INSERT INTO public.runtime_idempotency")) {
        return result([{
          idempotency_key: "reserved",
          message_id: "order",
          connection_id: CONNECTION_ID,
          job: "claim",
          status: "RUNNING",
          attempt: 1,
          applied_quantity: 0,
          lease_expired: false,
          result: { appliedQuantity: 0 },
          updated_at: "2026-08-03T12:00:00.000Z",
        }]);
      }
      if (query.includes("UPDATE public.runtime_idempotency")) {
        return result([{ idempotency_key: "updated" }]);
      }
      if (query.includes("FROM public.runtime_execution_log")) return result();
      if (query.includes("FROM public.stock_sync_log")) return result();
      if (query.includes("UPDATE public.pos_connections")) return result([{}], 1);
      return result();
    });

    const httpCalls: Array<{ url: string; method: string; body: unknown }> = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      httpCalls.push({ url, method, body });
      if (url.startsWith("https://agora.example.test/api/export/")) {
        return new Response(JSON.stringify(invoicePayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/v2/stock/wine/100")) {
        return new Response(JSON.stringify({ stocks: [{
          id: 1001,
          stock: 10,
          stockActive: true,
          winePrice: { variant: "botella" },
        }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/v2/stock/wine/101")) {
        return new Response(JSON.stringify({ stocks: [{
          id: 1011,
          stock: 8,
          stockActive: true,
          winePrice: { variant: "botella" },
        }, {
          id: 1012,
          stock: 48,
          stockActive: true,
          winePrice: { variant: "copa" },
        }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "PUT" && url.endsWith("/api/v2/stock/1001")) {
        return new Response(JSON.stringify({ stock: 9 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url.endsWith("/api/v2/sales/import")) {
        return new Response(JSON.stringify({ sales: [{
          orderId: (body as { sales: Array<{ orderId: string }> }).sales[0].orderId,
          stockApplied: true,
        }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected HTTP ${method} ${url}`);
    });

    const runtimeEnvelope = await envelope("sales.sync-intraday");
    const beforeMutation = vi.fn(async () => undefined);
    const execution = await executeAgoraSalesEnvelope(
      runtimeEnvelope,
      { executionEnabled: true, cursorEnabled: true, dlqReady: true },
      {
        database: fake.database,
        agoraCredential: { read: () => "agora-fixture" },
        winerimCredential: { read: () => "winerim-fixture" },
        winerimBaseUrl: "https://winerim.example.test",
        winerimAllowedHosts: ["winerim.example.test"],
        request,
        now: () => Date.parse("2026-08-03T12:00:00.000Z"),
        sleep: vi.fn(async () => undefined),
        beforeMutation,
      },
    );

    expect(execution).toEqual({ ok: true, detail: "sales:complete:1:1:2" });
    expect(beforeMutation).toHaveBeenCalledTimes(2);
    expect(httpCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://agora.example.test/api/export/?business-day=2026-08-03&filter=Invoices",
        method: "GET",
      }),
      expect.objectContaining({
        url: "https://winerim.example.test/api/v2/stock/1001",
        method: "PUT",
        body: { stock: 9 },
      }),
      expect.objectContaining({
        url: "https://winerim.example.test/api/v2/sales/import",
        method: "POST",
        body: expect.objectContaining({
          live: true,
          sales: [expect.objectContaining({ soldAt: "2026-08-03T13:02:00" })],
        }),
      }),
    ]));
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.sales_events"))).toBe(true);
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.sales_line_items"))).toBe(true);
    expect(fake.statements.some((statement) => statement.values.some((value) => (
      typeof value === "string" && value.includes('"soldAt":"2026-08-03T13:00:00"')
    )))).toBe(true);
    expect(fake.statements.some((statement) => statement.text.includes("UPDATE public.pos_connections"))).toBe(true);
  });

  it("routes a detached legacy receipt matched by old orderId prefix to DLQ without mutating Winerim", async () => {
    const detachedLegacyOrderId = "agora:11111111:2026-08-03:100:bot:legacyhash";
    const fake = databaseHarness((statement) => {
      const query = statement.text;
      if (query.includes("FROM public.pos_connections")) return result([{
        connection_id: CONNECTION_ID,
        provider: "agora",
        base_url: "https://agora.example.test",
        enabled: true,
        last_business_day_synced: "2026-08-02",
        provider_config: { time_zone: "Europe/Madrid", intraday_sales_sync_enabled: true, runtime_sales_cutover_business_day: "2026-08-03" },
      }]);
      if (query.includes("FROM public.product_mappings")) return result([{
        mapping_id: "mapping-bottle",
        provider_product_id: "500100",
        provider_product_name: "B Test Bottle",
        winerim_wine_id: "100",
        format_type: "BOTTLE",
        stock_id: "1001",
        wine_active: true,
      }, {
        mapping_id: "mapping-glass",
        provider_product_id: "700101",
        provider_product_name: "C Test Glass",
        winerim_wine_id: "101",
        format_type: "GLASS",
        stock_id: "1012",
        wine_active: true,
      }]);
      if (query.includes("FROM public.runtime_idempotency")) return result();
      if (query.includes("INSERT INTO public.sales_events")) {
        return result([{ id: "22222222-2222-4222-8222-000000000001" }]);
      }
      if (query.includes("conflict_count")) {
        const prefixes = statement.values.find((value): value is string[] => (
          Array.isArray(value) && value.some((item) => String(item).startsWith("agora:"))
        )) ?? [];
        const detectsNullLinkedLegacyReceipt = query.includes("LEFT JOIN public.sales_line_items")
          && query.includes("COALESCE(ssl.sales_event_id, sli.sales_event_id)")
          && query.includes("sales_event_id IS NULL")
          && query.includes("receipt_order_id LIKE legacy.prefix || '%'")
          && query.includes("'{salesImport,orderId}'")
          && prefixes.some((prefix) => detachedLegacyOrderId.startsWith(prefix));
        return result([{ conflict_count: detectsNullLinkedLegacyReceipt ? 1 : 0 }]);
      }
      return result();
    });
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith("https://agora.example.test/api/export/")) {
        return new Response(JSON.stringify(invoicePayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("Winerim must remain untouched");
    });

    const execution = await executeAgoraSalesEnvelope(
      await envelope("sales.sync-intraday"),
      { executionEnabled: true, cursorEnabled: true, dlqReady: true },
      {
        database: fake.database,
        agoraCredential: { read: () => "agora-fixture" },
        winerimCredential: { read: () => "winerim-fixture" },
        winerimBaseUrl: "https://winerim.example.test",
        winerimAllowedHosts: ["winerim.example.test"],
        request,
        now: () => Date.parse("2026-08-03T12:00:00.000Z"),
        sleep: vi.fn(async () => undefined),
      },
    );

    expect(execution).toEqual({
      ok: false,
      failure: {
        httpStatus: 503,
        message: "SALES_LEGACY_IDEMPOTENCY_RECONCILIATION_REQUIRED",
        retryableLine: true,
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    const conflictQuery = fake.statements.find((statement) => statement.text.includes("conflict_count"));
    expect(conflictQuery?.values.some((value) => (
      Array.isArray(value) && value.some((item) => String(item).startsWith("mw:v1:agora:"))
    ))).toBe(true);
    expect(conflictQuery?.values).toEqual(expect.arrayContaining([
      expect.arrayContaining([
        "agora:11111111:2026-08-03:100:bot:",
        "agora:11111111:2026-08-03:101:cop:",
      ]),
    ]));
  });

  it("fails closed for a busy sales claim before Winerim or cursor writes", async () => {
    const fake = databaseHarness((statement) => {
      const query = statement.text;
      if (query.includes("FROM public.pos_connections")) return result([{
        connection_id: CONNECTION_ID,
        provider: "agora",
        base_url: "https://agora.example.test",
        enabled: true,
        last_business_day_synced: "2026-08-02",
        provider_config: { time_zone: "Europe/Madrid", intraday_sales_sync_enabled: true, runtime_sales_cutover_business_day: "2026-08-03" },
      }]);
      if (query.includes("FROM public.product_mappings")) return result([{
        mapping_id: "mapping-bottle",
        provider_product_id: "500100",
        provider_product_name: "B Test Bottle",
        winerim_wine_id: "100",
        format_type: "BOTTLE",
        stock_id: "1001",
        wine_active: true,
      }, {
        mapping_id: "mapping-glass",
        provider_product_id: "700101",
        provider_product_name: "C Test Glass",
        winerim_wine_id: "101",
        format_type: "GLASS",
        stock_id: "1012",
        wine_active: true,
      }]);
      if (query.includes("FROM public.runtime_idempotency")) {
        const claimKeys = statement.values.find(Array.isArray) as string[] | undefined;
        return result(claimKeys?.length ? [{
          idempotency_key: claimKeys[0],
          message_id: "busy-order",
          job: "sales.claim",
          status: "RUNNING",
          applied_quantity: 0,
          lease_expires_at: "2026-08-03T12:02:00.000Z",
          result: { appliedQuantity: 0 },
          updated_at: "2026-08-03T12:00:00.000Z",
        }] : []);
      }
      if (query.includes("INSERT INTO public.sales_events")) {
        return result([{ id: "22222222-2222-4222-8222-000000000001" }]);
      }
      if (query.includes("UPDATE public.pos_connections")) {
        throw new Error("cursor/timestamp must not advance while a claim is busy");
      }
      return result();
    });
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith("https://agora.example.test/api/export/")) {
        return new Response(JSON.stringify(invoicePayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("Winerim must remain untouched while a claim is busy");
    });

    const execution = await executeAgoraSalesEnvelope(
      await envelope("sales.sync-intraday"),
      { executionEnabled: true, cursorEnabled: true, dlqReady: true },
      {
        database: fake.database,
        agoraCredential: { read: () => "agora-fixture" },
        winerimCredential: { read: () => "winerim-fixture" },
        winerimBaseUrl: "https://winerim.example.test",
        winerimAllowedHosts: ["winerim.example.test"],
        request,
        now: () => Date.parse("2026-08-03T12:00:00.000Z"),
        sleep: vi.fn(async () => undefined),
      },
    );

    expect(execution).toEqual({
      ok: false,
      failure: {
        httpStatus: 503,
        message: "SALES_CLAIM_BUSY_FOR_DLQ",
        retryableLine: true,
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(fake.statements.some((statement) => statement.text.includes("UPDATE public.pos_connections"))).toBe(false);
  });
});

describe("private sales executor error contract", () => {
  it("uses code-only errors and never exposes upstream text", () => {
    const error = new SalesLaneError("AGORA_INVOICES_HTTP_404", 503, true);
    expect(error.message).toBe("AGORA_INVOICES_HTTP_404");
  });
});
