import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
  TransactionOptions,
} from "../../cloudflare/workers/middleware-api/src/db";
import {
  createSalesPreparationFactory,
  type PosSalesDocumentPort,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/sales/preparation";
import type { ProviderSalesDocument } from "../../cloudflare/workers/middleware-runtime/src/handlers/sales";

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function fakeDatabase(
  route: (statement: SqlStatement) => QueryResult<Record<string, unknown>>,
) {
  const statements: SqlStatement[] = [];
  const transactionOptions: TransactionOptions[] = [];
  const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
    statements.push(statement);
    return route(statement) as QueryResult<Row>;
  });
  const transaction: DatabaseAdapter["transaction"] = vi.fn(async (work, options = {}) => {
    transactionOptions.push(options);
    return work({ query } as DatabaseTransaction);
  });
  return {
    database: { query, transaction } as DatabaseAdapter,
    statements,
    transactionOptions,
  };
}

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function invoice(provider = "agora"): ProviderSalesDocument {
  return {
    provider,
    documentId: "invoice:100",
    lifecycleId: "ticket-100",
    identitySource: "PROVIDER",
    businessDay: "2026-08-02",
    kind: "DEFINITIVE_INVOICE",
    isRefund: false,
    lines: [{
      lineId: "line-1",
      providerProductId: "700100",
      productName: "C Test Wine",
      quantity: 1,
      unitPrice: 6,
      suggestedVariant: "GLASS",
    }],
  };
}

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    location_name: "Test Restaurant",
    provider: "agora",
    enabled: true,
    sync_mode: "BIDIRECTIONAL",
    sync_frequency_minutes: 5,
    last_business_day_synced: "2026-08-01",
    provider_config: {
      intraday_sales_sync_enabled: true,
      open_tickets_sync_enabled: true,
      nested: { api_token: "must-not-leak", visible: "yes" },
      secret: "must-not-leak",
    },
    ...overrides,
  };
}

function mappingRow() {
  return {
    mapping_id: "mapping-1",
    provider_product_id: "700100",
    provider_product_name: "C Test Wine",
    winerim_wine_id: "100",
    format_type: "GLASS",
    stock_id: "stock-glass-100",
    wine_active: true,
  };
}

describe("sales preparation ports dry-run", () => {
  it("loads safe connection config, batches exact mappings and performs zero writes", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.pos_connections")) return result([connectionRow()]);
      if (statement.text.includes("FROM public.product_mappings")) return result([mappingRow()]);
      if (statement.text.includes("FROM public.runtime_idempotency")) return result();
      throw new Error(`unexpected SQL: ${statement.text}`);
    });
    const documents: PosSalesDocumentPort = {
      loadDocuments: vi.fn().mockResolvedValue([invoice()]),
    };
    const applyStock = vi.fn();
    const importSales = vi.fn();
    const factory = createSalesPreparationFactory({
      database: fake.database,
      documents,
      mutations: { applyStock, importSales },
    });

    const prepared = await factory.prepare({
      connectionId: CONNECTION_ID,
      runKind: "INTRADAY",
      dryRun: true,
      fromBusinessDay: "2026-08-02",
      toBusinessDay: "2026-08-02",
    });

    expect(documents.loadDocuments).toHaveBeenCalledWith({
      connection: expect.objectContaining({
        id: CONNECTION_ID,
        provider: "agora",
        syncFrequencyMinutes: 5,
        providerConfig: {
          intraday_sales_sync_enabled: true,
          open_tickets_sync_enabled: true,
          nested: { visible: "yes" },
        },
      }),
      runKind: "INTRADAY",
      fromBusinessDay: "2026-08-02",
      toBusinessDay: "2026-08-02",
    });
    expect(prepared.mappings).toMatchObject({
      requestedProviderProductIds: ["700100"],
      mappedProviderProductIds: ["700100"],
      unmappedProviderProductIds: [],
    });
    expect(prepared.handler.execution.items[0]).toMatchObject({ status: "DRY_RUN", appliedDelta: 1 });
    expect(prepared.cursor).toMatchObject({
      executable: false,
      plan: { executable: false, throughBusinessDay: "2026-08-02" },
    });
    expect(applyStock).not.toHaveBeenCalled();
    expect(importSales).not.toHaveBeenCalled();

    expect(fake.statements.every((statement) => statement.text.trimStart().startsWith("SELECT"))).toBe(true);
    const connectionSql = fake.statements.find((statement) => statement.text.includes("FROM public.pos_connections"))!;
    expect(connectionSql.text).not.toMatch(/api_token|base_url|winerim_api_token/);
    expect(connectionSql.values).toEqual([CONNECTION_ID]);
    const mappingSql = fake.statements.find((statement) => statement.text.includes("FROM public.product_mappings"))!;
    expect(mappingSql.text).toContain("pm.provider_product_id = ANY");
    expect(mappingSql.text).toContain("pm.status = 'CONFIRMED'");
    expect(mappingSql.text).not.toContain("ILIKE");
    expect(mappingSql.values).toEqual([CONNECTION_ID, ["700100"]]);
    expect(fake.transactionOptions).toEqual([{ isolationLevel: "repeatable-read", readOnly: true }]);
  });

  it("never proposes a cursor for historical or OpenTicket preparation", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.pos_connections")) return result([connectionRow()]);
      if (statement.text.includes("FROM public.product_mappings")) return result([mappingRow()]);
      if (statement.text.includes("FROM public.runtime_idempotency")) return result();
      return result();
    });
    const historicalDocuments = { loadDocuments: vi.fn().mockResolvedValue([invoice()]) };
    const historicalFactory = createSalesPreparationFactory({
      database: fake.database,
      documents: historicalDocuments,
    });

    const historical = await historicalFactory.prepare({
      connectionId: CONNECTION_ID,
      runKind: "HISTORICAL",
      dryRun: true,
    });
    expect(historical.cursor).toEqual({
      executable: false,
      reason: "Historical sales-only runs never advance the operational cursor",
      plan: null,
    });
  });
});
