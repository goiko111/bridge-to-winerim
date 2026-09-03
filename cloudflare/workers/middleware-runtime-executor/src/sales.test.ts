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
  planSalesRun,
  type SalesLineResolution,
  type SalesPlan,
} from "../../middleware-runtime/src/handlers/sales";
import {
  advanceSalesCursorFailClosed,
  boundSalesExecutionPlan,
  DEFAULT_MAX_SALES_INTENTS_PER_RUN,
  executeAgoraSalesEnvelope,
  normalizeAgoraDefinitiveInvoices,
  normalizeAgoraOpenTickets,
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
  job: "sales.auto-sync" | "sales.sync-intraday" | "sales.sync-open-tickets",
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

function invoicePayloadWithLines(lines: Array<Record<string, unknown>>) {
  return {
    Invoices: [{
      InvoiceId: "INV-UNRESOLVED",
      TicketId: "TICKET-UNRESOLVED",
      BusinessDay: "2026-08-03",
      DocumentType: "BasicInvoice",
      InvoiceItems: [{ Lines: lines }],
    }],
  };
}

function invoiceXmlPayload() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Export>
  <Invoices>
    <InvoiceModel InvoiceId="INV-XML-42" TicketId="TICKET-XML-42" BusinessDay="2026-08-03" DocumentType="BasicInvoice" UpdatedAt="2026-08-03T13:06:00">
      <InvoiceItems>
        <InvoiceItemModel>
          <Lines>
            <InvoiceLineModel Index="1" ProductId="500100" SaleFormatId="500100" ProductName="B Test Bottle" SaleFormatName="Botella" FamilyName="TINTOS WINERIM" Quantity="1" UnitPrice="25.00" TotalAmount="25.00" CreationDate="2026-08-03T13:00:00" />
            <InvoiceLineModel Index="2" ProductId="0" SaleFormatId="700101" ProductName="C Test Glass" SaleFormatName="Copa" FamilyName="COPAS WINERIM" Quantity="2" UnitPrice="6.00" TotalAmount="12.00" CreationDate="2026-08-03T13:02:00" />
          </Lines>
        </InvoiceItemModel>
      </InvoiceItems>
    </InvoiceModel>
  </Invoices>
</Export>`;
}

function openTicketXml(input: {
  globalId?: string;
  productId?: string;
  saleFormatId?: string;
  productName?: string;
  quantity?: string;
} = {}) {
  const globalId = input.globalId ?? "TICKET-OPEN-42";
  const productId = input.productId ?? "547593";
  const saleFormatId = input.saleFormatId ?? productId;
  const productName = input.productName ?? "B B349 - Soverribas Albariño";
  const quantity = input.quantity ?? "1.00";
  return `<?xml version="1.0" encoding="utf-8"?>
<Export>
  <Tickets>
    <TicketModel GlobalId="${globalId}" BusinessDay="2026-08-03" Date="">
      <Lines>
        <Line Index="14" CreationDate="2026-08-03T13:14:05" ProductId="${productId}" ProductName="${productName}" SaleFormatId="${saleFormatId}" SaleFormatName="Botella" FamilyName="BLANCOS WINERIM" Quantity="${quantity}" UnitPrice="67.00" TotalAmount="67.00" />
      </Lines>
    </TicketModel>
  </Tickets>
</Export>`;
}

function openTicketJson() {
  return {
    Tickets: [{
      GlobalId: "TICKET-OPEN-JSON",
      BusinessDay: "2026-08-03",
      Lines: [{
        Index: 7,
        CreationDate: "2026-08-03T13:20:00",
        ProductId: "547593",
        ProductName: "B B349 - Soverribas Albariño",
        SaleFormatId: "547593",
        SaleFormatName: "Botella",
        FamilyName: "BLANCOS WINERIM",
        Quantity: 1,
        UnitPrice: 67,
        TotalAmount: 67,
      }],
    }],
  };
}

const OPEN_TICKET_MAPPING: SalesLineResolution = {
  winerimWineId: "47593",
  variant: "BOTTLE",
  stockId: "475931",
  stockActive: true,
};

async function executeUnresolvedClosedDay(
  payload: ReturnType<typeof invoicePayloadWithLines>,
  mappings: Array<Record<string, unknown>> = [],
  classifications: Array<Record<string, unknown>> = [],
  job: "sales.auto-sync" | "sales.sync-intraday" = "sales.auto-sync",
) {
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
        provider_config: {
          time_zone: "Europe/Madrid",
          intraday_sales_sync_enabled: true,
          runtime_sales_cutover_business_day: "2026-08-03",
        },
      }]);
    }
    if (query.includes("FROM public.product_mappings")) return result(mappings);
    if (query.includes("FROM public.provider_products")) return result(classifications);
    if (query.includes("FROM public.runtime_idempotency")) return result();
    if (query.includes("conflict_count")) return result([{ conflict_count: 0 }]);
    if (query.includes("INSERT INTO public.sales_events")) {
      eventIndex += 1;
      return result([{ id: `22222222-2222-4222-8222-${String(eventIndex).padStart(12, "0")}` }]);
    }
    if (query.includes("DELETE FROM public.sales_line_items")) return result();
    if (query.includes("INSERT INTO public.sales_line_items")) return result();
    if (query.includes("UPDATE public.pos_connections") && job === "sales.sync-intraday") {
      return result([{}], 1);
    }
    throw new Error(`unexpected SQL after unresolved line: ${query}`);
  });
  const request = vi.fn<typeof fetch>(async (input) => {
    if (String(input).startsWith("https://agora.example.test/api/export/")) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Winerim must remain untouched while any line is unresolved");
  });

  const execution = await executeAgoraSalesEnvelope(
    await envelope(job, { businessDay: "2026-08-03" }),
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
  return { execution, fake, request };
}

async function executeInactiveSalesOnly(input: {
  variant: "GLASS" | "BOTTLE";
  stockActivity: boolean | "missing";
}) {
  const isGlass = input.variant === "GLASS";
  const providerProductId = isGlass ? "700200" : "500200";
  const wineId = isGlass ? "200" : "201";
  const exactStockId = isGlass ? 2002 : 2011;
  const decoyStockId = isGlass ? 2092 : 2091;
  const winerimVariant = isGlass ? "copa" : "botella";
  const payload = invoicePayloadWithLines([{
    Index: 1,
    ProductId: providerProductId,
    SaleFormatId: providerProductId,
    ProductName: `${isGlass ? "C" : "B"} Inactive sales-only`,
    FamilyName: isGlass ? "COPAS WINERIM" : "TINTOS WINERIM",
    SaleFormatName: isGlass ? "Copa" : "Botella",
    Quantity: 1,
    UnitPrice: isGlass ? 7 : 28,
    TotalAmount: isGlass ? 7 : 28,
    CreationDate: "2026-08-03T13:05:00",
  }]);
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
        provider_config: {
          time_zone: "Europe/Madrid",
          intraday_sales_sync_enabled: true,
          runtime_sales_cutover_business_day: "2026-08-03",
        },
      }]);
    }
    if (query.includes("FROM public.product_mappings")) {
      return result([{
        mapping_id: `mapping-${input.variant.toLowerCase()}-inactive`,
        provider_product_id: providerProductId,
        provider_product_name: `${isGlass ? "C" : "B"} Inactive sales-only`,
        winerim_wine_id: wineId,
        format_type: input.variant,
        stock_id: String(exactStockId),
        stock_active: false,
      }]);
    }
    if (query.includes("FROM public.provider_products")) return result();
    if (query.includes("FROM public.runtime_idempotency")) return result();
    if (query.includes("conflict_count")) return result([{ conflict_count: 0 }]);
    if (query.includes("INSERT INTO public.sales_events")) {
      eventIndex += 1;
      return result([{ id: `22222222-2222-4222-8222-${String(eventIndex).padStart(12, "0")}` }]);
    }
    if (query.includes("DELETE FROM public.sales_line_items")) return result();
    if (query.includes("INSERT INTO public.sales_line_items")) return result();
    if (query.includes("INSERT INTO public.runtime_idempotency")) {
      return result([{
        idempotency_key: "sales-only-claim",
        message_id: "sales-only-order",
        job: "sales.claim",
        status: "RUNNING",
        applied_quantity: 0,
        lease_expired: false,
        result: { appliedQuantity: 0 },
        updated_at: "2026-08-03T12:00:00.000Z",
      }]);
    }
    if (query.includes("UPDATE public.runtime_idempotency")) {
      return result([{ idempotency_key: "sales-only-claim" }]);
    }
    if (query.includes("UPDATE public.pos_connections")) return result([{}], 1);
    throw new Error(`unexpected SQL in inactive sales-only execution: ${query}`);
  });
  const httpCalls: Array<{ url: string; method: string; body: unknown }> = [];
  const request = vi.fn<typeof fetch>(async (rawUrl, init) => {
    const url = String(rawUrl);
    const method = String(init?.method ?? "GET");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    httpCalls.push({ url, method, body });
    if (url.startsWith("https://agora.example.test/api/export/")) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith(`/api/v2/stock/wine/${wineId}`)) {
      const exact = {
        id: exactStockId,
        stock: isGlass ? 24 : 5,
        ...(input.stockActivity === "missing" ? {} : { stockActive: input.stockActivity }),
        winePrice: { variant: winerimVariant },
      };
      return new Response(JSON.stringify({ stocks: [{
        id: decoyStockId,
        stock: 99,
        stockActive: true,
        winePrice: { variant: winerimVariant },
      }, exact] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "POST" && url.endsWith("/api/v2/sales/import")) {
      const orderId = (body as { sales: Array<{ orderId: string }> }).sales[0].orderId;
      return new Response(JSON.stringify({
        sales: [{ orderId, status: "imported", stockApplied: false }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected HTTP ${method} ${url}`);
  });
  const beforeMutation = vi.fn(async () => undefined);
  const execution = await executeAgoraSalesEnvelope(
    await envelope("sales.sync-intraday", { businessDay: "2026-08-03" }),
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
  return { beforeMutation, exactStockId, execution, fake, httpCalls };
}

describe("private sales executor invoice loader", () => {
  it("recognizes only bounded invoice containers and preserves legacy document identity", () => {
    expect(parseAgoraInvoicesPayload(invoicePayload())).toMatchObject({ recognized: true });
    expect(parseAgoraInvoicesPayload({ Data: invoicePayload() })).toMatchObject({ recognized: true });
    expect(parseAgoraInvoicesPayload({ unknown: {}, alsoUnknown: true })).toEqual({
      recognized: false,
      invoices: [],
    });
    expect(parseAgoraInvoicesPayload({})).toEqual({ recognized: true, invoices: [] });
    expect(parseAgoraInvoicesPayload(null)).toEqual({ recognized: true, invoices: [] });
    expect(parseAgoraInvoicesPayload("")).toEqual({ recognized: true, invoices: [] });
    expect(parseAgoraInvoicesPayload(
      '<?xml version="1.0" encoding="utf-8"?><Export xmlns="urn:agora" />',
    )).toEqual({ recognized: true, invoices: [] });
    expect(parseAgoraInvoicesPayload("<UnknownExport />")).toEqual({
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

  it("normalizes Agora XML InvoiceModel payloads from export invoices", () => {
    expect(parseAgoraInvoicesPayload(invoiceXmlPayload())).toMatchObject({ recognized: true });
    const [document] = normalizeAgoraDefinitiveInvoices(invoiceXmlPayload(), "2026-08-03");
    expect(document).toMatchObject({
      documentId: "INV-XML-42",
      lifecycleId: "TICKET-XML-42",
      identitySource: "PROVIDER",
      businessDay: "2026-08-03",
      kind: "DEFINITIVE_INVOICE",
      observedAt: "2026-08-03T13:06:00",
    });
    expect(document.lines).toEqual([
      expect.objectContaining({
        lineId: "INV-XML-42:0:1",
        providerProductId: "500100",
        saleFormatId: "500100",
        quantity: 1,
        unitPrice: 25,
        suggestedVariant: "BOTTLE",
      }),
      expect.objectContaining({
        lineId: "INV-XML-42:0:2",
        providerProductId: "700101",
        saleFormatId: "700101",
        quantity: 2,
        unitPrice: 6,
        suggestedVariant: "GLASS",
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

  it("keeps manual ProductId=0 food lines observable without blocking intraday sales", async () => {
    const { execution, fake, request } = await executeUnresolvedClosedDay(
      invoicePayloadWithLines([{
        Index: 1,
        ProductId: "0",
        ProductName: "BERBERECHOS",
        Quantity: 1,
        UnitPrice: 18,
        TotalAmount: 18,
      }]),
      [],
      [],
      "sales.sync-intraday",
    );

    expect(execution).toEqual({ ok: true, detail: "sales:complete:1:1:0" });
    expect(request).toHaveBeenCalledTimes(1);
    const lineInsert = fake.statements.find((statement) => (
      statement.text.includes("INSERT INTO public.sales_line_items")
    ));
    expect(lineInsert?.values).toEqual(expect.arrayContaining(["BERBERECHOS", false]));
  });
});

describe("private sales executor open-ticket loader", () => {
  it("normalizes the demonstrated XML TicketModel and JSON contracts", () => {
    const [xmlDocument] = normalizeAgoraOpenTickets(
      openTicketXml(),
      "2026-08-03",
      "2026-08-03T13:15:00.000Z",
    );
    expect(xmlDocument).toMatchObject({
      documentId: "open-ticket:TICKET-OPEN-42",
      lifecycleId: "TICKET-OPEN-42",
      identitySource: "PROVIDER",
      businessDay: "2026-08-03",
      kind: "OPEN_TICKET",
      observedAt: "2026-08-03T13:15:00.000Z",
      lines: [expect.objectContaining({
        lineId: "14",
        providerProductId: "547593",
        saleFormatId: "547593",
        productName: "B B349 - Soverribas Albariño",
        quantity: 1,
        unitPrice: 67,
        totalAmount: 67,
        suggestedVariant: "BOTTLE",
      })],
    });

    const [jsonDocument] = normalizeAgoraOpenTickets(openTicketJson(), "2026-08-03");
    expect(jsonDocument).toMatchObject({
      documentId: "open-ticket:TICKET-OPEN-JSON",
      lifecycleId: "TICKET-OPEN-JSON",
      kind: "OPEN_TICKET",
      lines: [expect.objectContaining({ providerProductId: "547593", quantity: 1 })],
    });
    expect(normalizeAgoraOpenTickets("<Export><Tickets /></Export>", "2026-08-03")).toEqual([]);
    expect(() => normalizeAgoraOpenTickets({ status: "ok" }, "2026-08-03"))
      .toThrowError(expect.objectContaining({ code: "AGORA_OPEN_TICKETS_PAYLOAD_UNRECOGNIZED" }));
  });

  it("shares lifecycle identity across replay and the definitive invoice", async () => {
    const [openDocument] = normalizeAgoraOpenTickets(openTicketXml(), "2026-08-03");
    const planningPorts = {
      resolveLine: async () => OPEN_TICKET_MAPPING,
      loadClaims: async () => [],
    };
    const openPlan = await planSalesRun({
      connectionId: CONNECTION_ID,
      provider: "agora",
      runKind: "OPEN_TICKET",
      openTicketPolicy: "PROVISIONAL_STOCK",
      documents: [openDocument],
    }, planningPorts);
    expect(openPlan.intents).toHaveLength(1);

    const claim = openPlan.intents[0];
    const replayPlan = await planSalesRun({
      connectionId: CONNECTION_ID,
      provider: "agora",
      runKind: "OPEN_TICKET",
      openTicketPolicy: "PROVISIONAL_STOCK",
      documents: [openDocument],
    }, {
      resolveLine: async () => OPEN_TICKET_MAPPING,
      loadClaims: async () => [{ claimKey: claim.claimKey, state: "COMPLETE", appliedQuantity: 1 }],
    });
    expect(replayPlan.intents).toEqual([]);
    expect(replayPlan.noops).toEqual([expect.objectContaining({
      claimKey: claim.claimKey,
      reason: "ALREADY_APPLIED",
    })]);

    const [definitiveDocument] = normalizeAgoraDefinitiveInvoices({ Invoices: [{
      InvoiceId: "INV-CLOSED-42",
      GlobalId: "TICKET-OPEN-42",
      TicketId: "AGORA-INTERNAL-TICKET-99",
      BusinessDay: "2026-08-03",
      InvoiceItems: [{ Lines: [{
        Index: 14,
        ProductId: "547593",
        SaleFormatId: "547593",
        ProductName: "B B349 - Soverribas Albariño",
        SaleFormatName: "Botella",
        FamilyName: "BLANCOS WINERIM",
        Quantity: 1,
        UnitPrice: 67,
        TotalAmount: 67,
      }] }],
    }] }, "2026-08-03");
    expect(definitiveDocument.lifecycleId).toBe(openDocument.lifecycleId);
    const finalPlan = await planSalesRun({
      connectionId: CONNECTION_ID,
      provider: "agora",
      runKind: "INTRADAY",
      documents: [definitiveDocument],
    }, {
      resolveLine: async () => OPEN_TICKET_MAPPING,
      loadClaims: async () => [{ claimKey: claim.claimKey, state: "COMPLETE", appliedQuantity: 1 }],
    });
    expect(finalPlan.intents).toEqual([]);
    expect(finalPlan.noops).toEqual([expect.objectContaining({
      claimKey: claim.claimKey,
      reason: "ALREADY_APPLIED",
    })]);
  });
});

describe("private sales executor gates and scheduling", () => {
  it("bounds live mutation work so a five-minute cycle can continue idempotently", () => {
    const intents = Array.from({ length: 6 }, (_, index) => ({
      orderId: `order-${index + 1}`,
    })) as SalesPlan["intents"];
    const input = {
      connectionId: CONNECTION_ID,
      provider: "agora",
      runKind: "INTRADAY",
      applyMode: "LIVE",
      documents: [],
      observations: [],
      blocked: [],
      noops: [],
      intents,
    } as SalesPlan;

    const bounded = boundSalesExecutionPlan(input);

    expect(DEFAULT_MAX_SALES_INTENTS_PER_RUN).toBe(4);
    expect(bounded.plan.intents.map((intent) => intent.orderId)).toEqual([
      "order-1",
      "order-2",
      "order-3",
      "order-4",
    ]);
    expect(bounded.pendingIntentCount).toBe(2);
    expect(() => boundSalesExecutionPlan(input, 0)).toThrowError(expect.objectContaining({
      code: "SALES_MAX_INTENTS_INVALID",
    }));
  });

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
    expect(salesLaneGateFailure(
      { executionEnabled: true, cursorEnabled: false, dlqReady: true },
      false,
      "sales.sync-open-tickets",
    )).toBeNull();
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
    expect(salesConnectionGateFailure(connection({
      providerConfig: { open_tickets_sync_enabled: false },
    }), "sales.sync-open-tickets", false)).toBe("SALES_OPEN_TICKETS_SYNC_DISABLED");
    expect(salesConnectionGateFailure(connection({
      providerConfig: { open_tickets_sync_enabled: true },
    }), "sales.sync-open-tickets", false)).toBeNull();
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
  it.each(["GLASS", "BOTTLE"] as const)(
    "imports an inactive %s mapping sales-only with live:false and its exact stockId",
    async (variant) => {
      const outcome = await executeInactiveSalesOnly({ variant, stockActivity: false });

      expect(outcome.execution).toEqual({ ok: true, detail: "sales:complete:1:1:1" });
      expect(outcome.beforeMutation).toHaveBeenCalledTimes(1);
      expect(outcome.httpCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({
          url: "https://winerim.example.test/api/v2/sales/import",
          method: "POST",
          body: expect.objectContaining({
            sales: [expect.objectContaining({ stockId: outcome.exactStockId, qty: 1 })],
          }),
        }),
      ]));
      expect(outcome.httpCalls.find((call) => call.url.endsWith("/api/v2/sales/import"))?.body)
        .not.toHaveProperty("live");
      expect(outcome.httpCalls.some((call) => call.method === "PUT")).toBe(false);
    },
  );

  it("imports sales-only without coupling history to live stock activity evidence", async () => {
    const outcome = await executeInactiveSalesOnly({ variant: "GLASS", stockActivity: "missing" });

    expect(outcome.execution).toEqual({ ok: true, detail: "sales:complete:1:1:1" });
    expect(outcome.beforeMutation).toHaveBeenCalledOnce();
    expect(outcome.httpCalls.some((call) => call.url.endsWith("/api/v2/sales/import"))).toBe(true);
    expect(outcome.httpCalls.some((call) => call.url.includes("/api/v2/stock/wine/"))).toBe(false);
  });

  it("persists XML open tickets idempotently in shadow mode without Winerim or cursor writes", async () => {
    const eventId = "22222222-2222-4222-8222-000000000042";
    const fake = databaseHarness((statement) => {
      const query = statement.text;
      if (query.includes("FROM public.pos_connections")) {
        return result([{
          connection_id: CONNECTION_ID,
          provider: "agora",
          base_url: "https://agora.example.test",
          enabled: true,
          last_business_day_synced: "2026-08-02",
          provider_config: {
            time_zone: "Europe/Madrid",
            open_tickets_sync_enabled: true,
            open_tickets_stock_sync_enabled: false,
          },
        }]);
      }
      if (query.includes("FROM public.product_mappings")) {
        return result([{
          mapping_id: "mapping-open-bottle",
          provider_product_id: "547593",
          provider_product_name: "B B349 - Soverribas Albariño",
          winerim_wine_id: "47593",
          format_type: "BOTTLE",
          stock_id: "475931",
          stock_active: true,
        }]);
      }
      if (query.includes("INSERT INTO public.sales_events")) return result([{ id: eventId }]);
      return result();
    });
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "https://agora.example.test/api/export/tickets/") {
        return new Response(openTicketXml(), {
          status: 200,
          headers: { "content-type": "application/xml" },
        });
      }
      throw new Error("shadow open-ticket execution must not contact Winerim");
    });
    const dependencies = {
      database: fake.database,
      agoraCredential: { read: () => "agora-fixture" },
      winerimCredential: { read: () => { throw new Error("must remain unopened"); } },
      winerimBaseUrl: "https://winerim.example.test",
      winerimAllowedHosts: ["winerim.example.test"],
      request,
      now: () => Date.parse("2026-08-03T12:00:00.000Z"),
      sleep: vi.fn(async () => undefined),
    };
    const runtimeEnvelope = await envelope("sales.sync-open-tickets");

    await expect(executeAgoraSalesEnvelope(
      runtimeEnvelope,
      { executionEnabled: true, cursorEnabled: false, dlqReady: true },
      dependencies,
    )).resolves.toEqual({ ok: true, detail: "sales:open-tickets:shadow:1:1:0:0" });
    await expect(executeAgoraSalesEnvelope(
      runtimeEnvelope,
      { executionEnabled: true, cursorEnabled: false, dlqReady: true },
      dependencies,
    )).resolves.toEqual({ ok: true, detail: "sales:open-tickets:shadow:1:1:0:0" });

    const eventWrites = fake.statements.filter((statement) => statement.text.includes("INSERT INTO public.sales_events"));
    expect(eventWrites).toHaveLength(2);
    expect(eventWrites.every((statement) => statement.text.includes("ON CONFLICT (connection_id, provider_doc_id)")))
      .toBe(true);
    expect(fake.statements.some((statement) => statement.text.includes("UPDATE public.pos_connections"))).toBe(false);
    expect(fake.statements.some((statement) => statement.text.includes("runtime_idempotency"))).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("persists the shadow observation but blocks provisional stock for ProductId=0 without an exact mapping", async () => {
    const fake = databaseHarness((statement) => {
      const query = statement.text;
      if (query.includes("FROM public.pos_connections")) {
        return result([{
          connection_id: CONNECTION_ID,
          provider: "agora",
          base_url: "https://agora.example.test",
          enabled: true,
          last_business_day_synced: "2026-08-02",
          provider_config: {
            time_zone: "Europe/Madrid",
            open_tickets_sync_enabled: true,
            open_tickets_stock_sync_enabled: true,
          },
        }]);
      }
      if (query.includes("FROM public.product_mappings")) return result();
      if (query.includes("FROM public.runtime_idempotency")) return result();
      if (query.includes("INSERT INTO public.sales_events")) {
        return result([{ id: "22222222-2222-4222-8222-000000000043" }]);
      }
      return result();
    });
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "https://agora.example.test/api/export/tickets/") {
        return new Response(openTicketXml({
          productId: "0",
          saleFormatId: "0",
          productName: "copa Muga",
        }), { status: 200, headers: { "content-type": "application/xml" } });
      }
      throw new Error("blocked ProductId=0 must not contact Winerim");
    });

    const execution = await executeAgoraSalesEnvelope(
      await envelope("sales.sync-open-tickets"),
      { executionEnabled: true, cursorEnabled: false, dlqReady: true },
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
      ok: true,
      detail: "sales:open-tickets:provisional-stock:1:1:1:0",
    });
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.sales_events"))).toBe(true);
    expect(fake.statements.some((statement) => statement.text.includes("UPDATE public.pos_connections"))).toBe(false);
    expect(fake.statements.some((statement) => statement.text.includes("stock_sync_log"))).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("persists a clearly non-wine Agora line as an observation without planning a mutation", async () => {
    const { execution, fake, request } = await executeUnresolvedClosedDay(invoicePayloadWithLines([{
      Index: 1,
      ProductId: "900001",
      ProductName: "Menu degustacion",
      FamilyName: "COCINA",
      Quantity: 1,
      UnitPrice: 45,
      TotalAmount: 45,
    }]), [], [{
      provider_product_id: "900001",
      family: "COCINA",
      is_wine_candidate: false,
      classification_override: "NOT_WINE",
      last_score: 0,
      wine_score: 0,
    }], "sales.sync-intraday");

    expect(execution).toEqual({ ok: true, detail: "sales:complete:1:1:0" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.sales_events"))).toBe(true);
    const lineInsert = fake.statements.find((statement) => statement.text.includes("INSERT INTO public.sales_line_items"));
    expect(lineInsert?.values).toEqual(expect.arrayContaining(["Menu degustacion", false]));
  });

  it("blocks the cursor for an explicit wine candidate without an exact mapping", async () => {
    const { execution, request } = await executeUnresolvedClosedDay(invoicePayloadWithLines([{
      Index: 1,
      ProductId: "900002",
      ProductName: "B Vino sin mapping",
      FamilyName: "TINTOS",
      SaleFormatName: "Botella",
      Quantity: 1,
      UnitPrice: 30,
      TotalAmount: 30,
    }]), [], [{
      provider_product_id: "900002",
      family: "TINTOS",
      is_wine_candidate: true,
      classification_override: "AUTO",
      last_score: 100,
      wine_score: 100,
    }]);

    expect(execution).toEqual({ ok: true, detail: "sales:complete:1:1:0:blocked:1" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not advance the closed-day cursor when even one Agora line remains unresolved", async () => {
    const { execution, fake, request } = await executeUnresolvedClosedDay(invoicePayloadWithLines([{
      Index: 1,
      ProductId: "500100",
      SaleFormatId: "500100",
      ProductName: "B Test Bottle",
      FamilyName: "TINTOS WINERIM",
      SaleFormatName: "Botella",
      Quantity: 1,
      UnitPrice: 25,
      TotalAmount: 25,
    }, {
      Index: 2,
      ProductId: "900003",
      ProductName: "Servicio no clasificado",
      FamilyName: "OTROS",
      Quantity: 1,
      UnitPrice: 3,
      TotalAmount: 3,
    }]), [{
      mapping_id: "mapping-bottle",
      provider_product_id: "500100",
      provider_product_name: "B Test Bottle",
      winerim_wine_id: "100",
      format_type: "BOTTLE",
      stock_id: "1001",
      stock_active: true,
    }], [{
      provider_product_id: "500100",
      family: "TINTOS WINERIM",
      is_wine_candidate: true,
      classification_override: "WINE",
      last_score: 100,
      wine_score: 100,
    }, {
      provider_product_id: "900003",
      family: "OTROS",
      is_wine_candidate: true,
      classification_override: "AUTO",
      last_score: 25,
      wine_score: 25,
    }]);

    expect(execution).toEqual({
      ok: true,
      detail: "sales:complete:1:1:0:pending:1:blocked:1",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(fake.statements.some((statement) => statement.text.includes("UPDATE public.pos_connections"))).toBe(false);
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.sales_events"))).toBe(true);
  });

  it("processes mapped wine in a mixed food invoice and persists the food observation", async () => {
    let eventIndex = 0;
    const mixedPayload = invoicePayload();
    mixedPayload.Invoices[0].InvoiceItems[0].Lines.push({
      Index: 3,
      ProductId: "900010",
      SaleFormatId: "900010",
      ProductName: "Menu degustacion",
      SaleFormatName: "Unidad",
      FamilyName: "COCINA",
      Quantity: 1,
      UnitPrice: 45,
      TotalAmount: 45,
      CreationDate: "2026-08-03T13:03:00",
    }, {
      Index: 4,
      ProductId: "900011",
      SaleFormatId: "900011",
      ProductName: "B Vino candidato pendiente mapping",
      SaleFormatName: "Botella",
      FamilyName: "TINTOS",
      Quantity: 1,
      UnitPrice: 29,
      TotalAmount: 29,
      CreationDate: "2026-08-03T13:04:00",
    });
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
          stock_active: true,
        }, {
          mapping_id: "mapping-glass",
          provider_product_id: "700101",
          provider_product_name: "C Test Glass",
          winerim_wine_id: "101",
          format_type: "GLASS",
          stock_id: "1012",
          stock_active: true,
        }]);
      }
      if (query.includes("FROM public.provider_products")) {
        return result([{
          provider_product_id: "900010",
          family: "COCINA",
          is_wine_candidate: false,
          classification_override: "NOT_WINE",
          last_score: 0,
          wine_score: 0,
        }, {
          provider_product_id: "900011",
          family: "TINTOS",
          is_wine_candidate: true,
          classification_override: "AUTO",
          last_score: 100,
          wine_score: 100,
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
        return new Response(JSON.stringify(mixedPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/v2/stock/wine/100")) {
        return new Response(JSON.stringify({ stocks: [{
          id: 1099,
          stock: 99,
          stockActive: true,
          winePrice: { variant: "botella" },
        }, {
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
          id: 1092,
          stock: 99,
          stockActive: true,
          winePrice: { variant: "copa" },
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
      if (method === "GET" && url === "https://winerim.example.test/api/v2/stock?page=1&limit=100") {
        return new Response(JSON.stringify({
          success: true,
          pagination: { page: 1, limit: 100, total_count: 1, total_pages: 1 },
          stocks: [{ id: 1001, stock: 9 }],
        }), { status: 200, headers: { "content-type": "application/json" } });
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

    expect(execution).toEqual({ ok: true, detail: "sales:complete:1:1:2:blocked:1" });
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
        url: "https://winerim.example.test/api/v2/stock?page=1&limit=100",
        method: "GET",
        body: undefined,
      }),
      expect.objectContaining({
        url: "https://winerim.example.test/api/v2/sales/import",
        method: "POST",
        body: expect.objectContaining({
          live: true,
          sales: [expect.objectContaining({
            stockId: 1012,
            soldAt: "2026-08-03T13:02:00",
          })],
        }),
      }),
    ]));
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.sales_events"))).toBe(true);
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.sales_line_items"))).toBe(true);
    const lineInserts = fake.statements.filter((statement) => statement.text.includes("INSERT INTO public.sales_line_items"));
    expect(lineInserts).toHaveLength(4);
    expect(lineInserts.find((statement) => statement.values.includes("Menu degustacion"))?.values)
      .toEqual(expect.arrayContaining(["Menu degustacion", false]));
    expect(lineInserts.find((statement) => statement.values.includes("B Vino candidato pendiente mapping"))?.values)
      .toEqual(expect.arrayContaining(["B Vino candidato pendiente mapping", true]));
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
        stock_active: true,
      }, {
        mapping_id: "mapping-glass",
        provider_product_id: "700101",
        provider_product_name: "C Test Glass",
        winerim_wine_id: "101",
        format_type: "GLASS",
        stock_id: "1012",
        stock_active: true,
      }]);
      if (query.includes("FROM public.runtime_idempotency") && !query.includes("conflict_count")) {
        return result();
      }
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
    expect(conflictQuery?.text).toContain("owned.job = 'stock.mutation'");
    expect(conflictQuery?.text).toContain("owned.idempotency_key = receipts.idempotency_key");
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
        stock_active: true,
      }, {
        mapping_id: "mapping-glass",
        provider_product_id: "700101",
        provider_product_name: "C Test Glass",
        winerim_wine_id: "101",
        format_type: "GLASS",
        stock_id: "1012",
        stock_active: true,
      }]);
      if (query.includes("jsonb_array_elements_text")) return result();
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

  it("persists sanitized diagnostics for unexpected sales lane errors", async () => {
    const execution = await executeAgoraSalesEnvelope(
      await envelope("sales.sync-intraday", {
        businessDay: "2026-08-03",
      }),
      { executionEnabled: true, cursorEnabled: true, dlqReady: true },
      {
        database: {
          query: async () => {
            throw new Error("database failed api-token=super-secret-value");
          },
          transaction: async () => {
            throw new Error("database failed api-token=super-secret-value");
          },
        },
        agoraCredential: { read: () => "agora-fixture" },
        winerimCredential: { read: () => "winerim-fixture" },
        winerimBaseUrl: "https://winerim.example.test",
        winerimAllowedHosts: ["winerim.example.test"],
        request: vi.fn(),
        now: () => Date.parse("2026-08-03T12:00:00.000Z"),
        sleep: vi.fn(async () => undefined),
      },
    );

    expect(execution).toMatchObject({
      ok: false,
      failure: {
        httpStatus: 503,
        message: "SALES_LANE_UNAVAILABLE",
        retryableLine: true,
        diagnostic: {
          operation: "sales.execute",
          errorCode: "SALES_LANE_UNAVAILABLE",
        },
      },
    });
    expect(JSON.stringify(execution)).toContain("[REDACTED]");
    expect(JSON.stringify(execution)).not.toContain("super-secret-value");
  });
});
