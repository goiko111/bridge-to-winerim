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
const EVENT_ID = "22222222-2222-4222-8222-222222222222";

function connectionRow(enabled = true) {
  return {
    id: CONNECTION_ID,
    location_name: "Test Restaurant",
    provider: "agora",
    enabled,
    sync_mode: "BIDIRECTIONAL",
    sync_frequency_minutes: 5,
    last_business_day_synced: "2026-08-01",
    provider_config: {
      intraday_sales_sync_enabled: true,
      open_tickets_sync_enabled: true,
      open_tickets_stock_sync_enabled: true,
    },
  };
}

function invoice(provider = "agora"): ProviderSalesDocument {
  return {
    provider,
    documentId: "invoice:200",
    lifecycleId: "ticket-200",
    identitySource: "PROVIDER",
    businessDay: "2026-08-02",
    kind: "DEFINITIVE_INVOICE",
    isRefund: false,
    lines: [{
      lineId: "line-1",
      providerProductId: "500200",
      productName: "B Test Wine",
      quantity: 1,
      unitPrice: 25,
      suggestedVariant: "BOTTLE",
    }],
  };
}

function mappingRow() {
  return {
    mapping_id: "mapping-2",
    provider_product_id: "500200",
    provider_product_name: "B Test Wine",
    winerim_wine_id: "200",
    format_type: "BOTTLE",
    stock_id: "stock-bottle-200",
    stock_active: true,
  };
}

describe("sales preparation ports execution", () => {
  it("uses the transactional adapter and injected mutation port for an enabled run", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.pos_connections")) return result([connectionRow()]);
      if (statement.text.includes("FROM public.product_mappings")) return result([mappingRow()]);
      if (statement.text.includes("FROM public.runtime_idempotency")) return result();
      if (statement.text.includes("INSERT INTO public.sales_events")) return result([{ id: EVENT_ID }]);
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) {
        return result([{ status: "RUNNING", applied_quantity: 0, result: { appliedQuantity: 0 } }]);
      }
      if (statement.text.includes("status = 'SUCCESS'")) {
        return result([{ idempotency_key: "claim-complete" }]);
      }
      return result();
    });
    const documents = { loadDocuments: vi.fn().mockResolvedValue([invoice()]) };
    const applyStock = vi.fn().mockResolvedValue({ ok: true, stockMoved: true });
    const importSales = vi.fn();
    const factory = createSalesPreparationFactory({
      database: fake.database,
      documents,
      mutations: { applyStock, importSales },
    });

    const prepared = await factory.prepare({
      connectionId: CONNECTION_ID,
      runKind: "INTRADAY",
      dryRun: false,
    });

    expect(prepared.handler.execution.items[0]).toMatchObject({ status: "APPLIED", appliedDelta: 1 });
    expect(applyStock).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: CONNECTION_ID,
      stockId: "stock-bottle-200",
      winerimWineId: "200",
      decrementQuantity: 1,
    }));
    expect(importSales).not.toHaveBeenCalled();
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.sales_events"))).toBe(true);
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.sales_line_items"))).toBe(true);
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.runtime_idempotency"))).toBe(true);
    expect(fake.statements.some((statement) => statement.text.includes("UPDATE public.pos_connections"))).toBe(false);
    expect(fake.transactionOptions).toContainEqual({ isolationLevel: "serializable", readOnly: false });
    expect(prepared.cursor.executable).toBe(false);
  });

  it("fails closed before loading POS documents when execution gates are missing", async () => {
    for (const scenario of [
      { enabled: false, mutations: { applyStock: vi.fn(), importSales: vi.fn() }, code: "SALES_CONNECTION_DISABLED" },
      { enabled: true, mutations: undefined, code: "SALES_MUTATION_PORTS_REQUIRED" },
    ]) {
      const fake = fakeDatabase((statement) => {
        if (statement.text.includes("FROM public.pos_connections")) return result([connectionRow(scenario.enabled)]);
        throw new Error("only connection read is allowed");
      });
      const documents = { loadDocuments: vi.fn() };
      const factory = createSalesPreparationFactory({
        database: fake.database,
        documents,
        mutations: scenario.mutations,
      });

      await expect(factory.prepare({
        connectionId: CONNECTION_ID,
        runKind: "INTRADAY",
        dryRun: false,
      })).rejects.toMatchObject({ code: scenario.code });
      expect(documents.loadDocuments).not.toHaveBeenCalled();
      expect(fake.statements).toHaveLength(1);
    }
  });

  it("rejects documents from a different provider before mappings or writes", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.pos_connections")) return result([connectionRow()]);
      throw new Error("mapping or write SQL must not execute");
    });
    const documents = { loadDocuments: vi.fn().mockResolvedValue([invoice("revo")]) };
    const factory = createSalesPreparationFactory({ database: fake.database, documents });

    await expect(factory.prepare({
      connectionId: CONNECTION_ID,
      runKind: "INTRADAY",
      dryRun: true,
    })).rejects.toMatchObject({ code: "SALES_SOURCE_PROVIDER_SCOPE_MISMATCH" });
    expect(fake.statements).toHaveLength(1);
  });
});
