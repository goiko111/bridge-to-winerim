import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
  TransactionOptions,
} from "../../cloudflare/workers/middleware-api/src/db";
import {
  createPostgresSalesAdapter,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/sales";
import type {
  ProviderSalesDocument,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/sales";

type Route = (
  statement: SqlStatement,
) => QueryResult<Record<string, unknown>> | Promise<QueryResult<Record<string, unknown>>>;

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function fakeDatabase(route: Route) {
  const statements: SqlStatement[] = [];
  const transactionOptions: TransactionOptions[] = [];
  const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
    statements.push(statement);
    return route(statement) as Promise<QueryResult<Row>>;
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

function salesDocument(): ProviderSalesDocument {
  return {
    provider: "agora",
    documentId: "invoice:inv-100",
    lifecycleId: "ticket-100",
    identitySource: "PROVIDER",
    businessDay: "2026-07-29",
    kind: "DEFINITIVE_INVOICE",
    isRefund: false,
    observedAt: "2026-07-29T13:05:00Z",
    lines: [
      {
        lineId: "line-1",
        providerProductId: "547593",
        productName: "B Vi de Glass",
        familyName: "VINOS",
        quantity: 1,
        unitPrice: 29,
        totalAmount: 29,
        soldAt: "2026-07-29T13:04:00Z",
        suggestedVariant: "BOTTLE",
      },
      {
        lineId: "line-2",
        providerProductId: "service-1",
        productName: "Service not mapped",
        quantity: 1,
        unitPrice: 3,
        totalAmount: 3,
      },
    ],
  };
}

describe("PostgreSQL sales adapter mapping and persistence", () => {
  it("resolves only exact confirmed provider_product_id mappings", async () => {
    const fake = fakeDatabase((statement) => {
      expect(statement.text).toContain("pm.provider_product_id = ANY");
      expect(statement.text).toContain("pm.status = 'CONFIRMED'");
      expect(statement.text).not.toContain("ILIKE");
      expect(statement.text).not.toContain("provider_product_name =");
      return result([{
        mapping_id: "mapping-1",
        provider_product_id: "547593",
        provider_product_name: "B Vi de Glass",
        winerim_wine_id: "47593",
        format_type: "BOTTLE",
        stock_id: "stock-47593",
        wine_active: true,
      }]);
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });
    const document = salesDocument();

    const mapping = await adapter.resolveLine({
      connectionId: CONNECTION_ID,
      provider: "agora",
      document,
      line: document.lines[0],
    });

    expect(mapping).toEqual(expect.objectContaining({
      mappingId: "mapping-1",
      providerProductId: "547593",
      winerimWineId: "47593",
      variant: "BOTTLE",
      stockId: "stock-47593",
      stockActive: true,
    }));
    expect(fake.statements[0].values).toEqual([CONNECTION_ID, ["547593"]]);
  });

  it("reads explicit provider-product classifications without name matching", async () => {
    const fake = fakeDatabase((statement) => {
      expect(statement.text).toContain("FROM public.provider_products");
      expect(statement.text).toContain("provider_product_id = ANY");
      expect(statement.text).toContain("lower(btrim(COALESCE(family, ''))) = ANY");
      expect(statement.text).not.toContain("ILIKE");
      return result([{
        provider_product_id: "wine-1",
        family: "VINOS",
        is_wine_candidate: true,
        classification_override: "AUTO",
        last_score: 100,
        wine_score: 100,
      }, {
        provider_product_id: "food-1",
        family: "COCINA",
        is_wine_candidate: false,
        classification_override: "NOT_WINE",
        last_score: 0,
        wine_score: 0,
      }, {
        provider_product_id: "review-1",
        family: "VINOS",
        is_wine_candidate: false,
        classification_override: "AUTO",
        last_score: 25,
        wine_score: 25,
      }]);
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await expect(adapter.readProductClassifications(
      ["wine-1", "food-1", "review-1"],
      ["VINOS", "COCINA"],
    )).resolves.toEqual([
      expect.objectContaining({ providerProductId: "wine-1", classification: "WINE" }),
      expect.objectContaining({ providerProductId: "food-1", classification: "NOT_WINE" }),
      expect.objectContaining({ providerProductId: "review-1", classification: "AMBIGUOUS" }),
    ]);
    expect(fake.transactionOptions).toEqual([{ isolationLevel: "repeatable-read", readOnly: true }]);
  });

  it("upserts an event and replaces its mapped/unmapped lines atomically", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.product_mappings")) {
        return result([{
          mapping_id: "mapping-1",
          provider_product_id: "547593",
          provider_product_name: "B Vi de Glass",
          winerim_wine_id: "47593",
          format_type: "BOTTLE",
          stock_id: "stock-47593",
          wine_active: true,
        }]);
      }
      if (statement.text.includes("INSERT INTO public.sales_events")) {
        return result([{ id: "22222222-2222-4222-8222-222222222222" }]);
      }
      return result();
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await adapter.persistDocuments([salesDocument()]);

    expect(fake.transactionOptions).toEqual([{ isolationLevel: "serializable", readOnly: false }]);
    expect(fake.statements.map((statement) => statement.text)).toEqual([
      expect.stringContaining("FROM public.product_mappings"),
      expect.stringContaining("INSERT INTO public.sales_events"),
      expect.stringContaining("DELETE FROM public.sales_line_items"),
      expect.stringContaining("INSERT INTO public.sales_line_items"),
      expect.stringContaining("INSERT INTO public.sales_line_items"),
    ]);

    const eventUpsert = fake.statements.find((statement) => statement.text.includes("INSERT INTO public.sales_events"))!;
    expect(eventUpsert.text).toContain("ON CONFLICT (connection_id, provider_doc_id) DO UPDATE");
    expect(eventUpsert.text).not.toContain("invoice:inv-100");
    expect(eventUpsert.values).toContain("invoice:inv-100");

    const inserts = fake.statements.filter((statement) => statement.text.includes("INSERT INTO public.sales_line_items"));
    expect(inserts[0].text).not.toContain("B Vi de Glass");
    expect(inserts[0].values).toEqual(expect.arrayContaining([
      "547593",
      "B Vi de Glass",
      "BOTTLE",
      "47593",
      true,
    ]));
    expect(inserts[1].values).toEqual(expect.arrayContaining([
      "service-1",
      "Service not mapped",
      null,
      false,
    ]));
  });

  it("persists an exact SaleFormatId mapping without rewriting the provider product identity", async () => {
    const document = salesDocument();
    document.lines[0] = {
      ...document.lines[0],
      providerProductId: "parent-product-1",
      saleFormatId: "547593",
    };
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.product_mappings")) {
        expect(statement.values).toEqual([CONNECTION_ID, expect.arrayContaining(["547593", "parent-product-1"])]);
        return result([{
          mapping_id: "mapping-format-1",
          provider_product_id: "547593",
          provider_product_name: "B Vi de Glass",
          winerim_wine_id: "47593",
          format_type: "BOTTLE",
          stock_id: "stock-47593",
          wine_active: true,
        }]);
      }
      if (statement.text.includes("INSERT INTO public.sales_events")) {
        return result([{ id: "22222222-2222-4222-8222-222222222222" }]);
      }
      return result();
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await adapter.persistDocuments([document]);

    const lineInsert = fake.statements.find((statement) => (
      statement.text.includes("INSERT INTO public.sales_line_items")
      && statement.values.includes("parent-product-1")
    ));
    expect(lineInsert?.values).toEqual(expect.arrayContaining([
      "parent-product-1",
      "47593",
      true,
    ]));
  });

  it("rejects documents outside the adapter provider scope before opening a transaction", async () => {
    const fake = fakeDatabase(() => {
      throw new Error("database must not be opened");
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await expect(adapter.persistDocuments([{ ...salesDocument(), provider: "revo" }]))
      .rejects.toMatchObject({ code: "SALES_ADAPTER_PROVIDER_SCOPE_MISMATCH" });
    expect(fake.database.transaction).not.toHaveBeenCalled();
  });
});
