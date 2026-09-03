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
      expect(statement.text).toContain("jsonb_array_elements");
      expect(statement.text).toContain("ww.raw_payload->'prices'");
      expect(statement.text).toContain("price_entry->'erpStock'");
      expect(statement.text).toContain("ww.raw_payload->'stocks'");
      expect(statement.text).toContain("stock_entry->>'stockActive'");
      expect(statement.text).toContain("stock_contract.stock_count = 1");
      expect(statement.text).toContain("RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY");
      expect(statement.text).not.toContain("COALESCE((\n        SELECT (stock_entry->>'stockActive')::boolean");
      expect(statement.text).not.toContain("ILIKE");
      expect(statement.text).not.toContain("provider_product_name =");
      return result([{
        mapping_id: "mapping-1",
        provider_product_id: "547593",
        provider_product_name: "B Vi de Glass",
        winerim_wine_id: "47593",
        format_type: "BOTTLE",
        stock_id: "stock-47593",
        stock_active: true,
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

  it("preserves an exact inactive variant as sales-only instead of using wine activity", async () => {
    const fake = fakeDatabase(() => result([{
      mapping_id: "mapping-glass-1",
      provider_product_id: "947593",
      provider_product_name: "C Vi de Glass",
      winerim_wine_id: "47593",
      format_type: "GLASS",
      stock_id: "stock-glass-47593",
      stock_active: false,
    }]));
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });
    const glassDocument = salesDocument();
    const glassLine = {
      ...glassDocument.lines[0],
      providerProductId: "947593",
      productName: "C Vi de Glass",
      suggestedVariant: "GLASS" as const,
    };

    await expect(adapter.resolveLine({
      connectionId: CONNECTION_ID,
      provider: "agora",
      document: glassDocument,
      line: glassLine,
    })).resolves.toMatchObject({
      providerProductId: "947593",
      variant: "GLASS",
      stockId: "stock-glass-47593",
      stockActive: false,
    });
  });

  it("requires exactly one explicit stock activity record in the mapping query", async () => {
    const fake = fakeDatabase((statement) => {
      expect(statement.text).toContain("jsonb_typeof(ww.raw_payload->'prices') = 'array'");
      expect(statement.text).toContain("jsonb_typeof(price_entry->'erpStock') = 'object'");
      expect(statement.text).toContain("jsonb_typeof(stock_entry->'stockActive') = 'boolean'");
      expect(statement.text).toContain("stock_contract.stock_count = 1");
      return result();
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });
    const document = salesDocument();
    await expect(adapter.resolveLine({
      connectionId: CONNECTION_ID,
      provider: "agora",
      document,
      line: document.lines[0],
    })).resolves.toBeNull();
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
          stock_active: true,
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

    expect(fake.transactionOptions).toEqual([{ isolationLevel: "read-committed", readOnly: false }]);
    expect(fake.statements.map((statement) => statement.text)).toEqual([
      expect.stringContaining("FROM public.product_mappings"),
      expect.stringContaining("INSERT INTO public.sales_events"),
    ]);

    const persistence = fake.statements.find((statement) => statement.text.includes("INSERT INTO public.sales_events"))!;
    expect(persistence.text).toContain("ON CONFLICT (connection_id, provider_doc_id) DO UPDATE");
    expect(persistence.text).toContain("DELETE FROM public.sales_line_items");
    expect(persistence.text).toContain("INSERT INTO public.sales_line_items");
    expect(persistence.text).toContain("jsonb_to_recordset");
    expect(persistence.text).not.toContain("invoice:inv-100");
    const linePayload = persistence.values.find((value) => (
      typeof value === "string" && value.includes("\"mapped\"")
    ));
    const persistedLines = JSON.parse(String(linePayload));
    expect(persistedLines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerProductId: "547593",
        productName: "B Vi de Glass",
        format: "BOTTLE",
        winerimWineId: "47593",
        mapped: true,
      }),
      expect.objectContaining({
        providerProductId: "service-1",
        productName: "Service not mapped",
        winerimWineId: null,
        mapped: false,
      }),
    ]));
  });

  it("persists an exact native ProductId + SaleFormatId mapping without rewriting either identity", async () => {
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
          mapping_id: "unrelated-flat-collision",
          provider_product_id: "547593",
          provider_product_name: "Unrelated product using the same numeric ID",
          winerim_wine_id: "99999",
          format_type: "BOTTLE",
          stock_id: "stock-unrelated",
          stock_active: true,
        }]);
      }
      if (statement.text.includes("FROM public.agora_sales_variant_mappings")) {
        expect(statement.values).toEqual([
          CONNECTION_ID,
          ["parent-product-1"],
          ["547593"],
        ]);
        return result([{
          mapping_id: "mapping-format-1",
          provider_product_id: "parent-product-1",
          provider_sale_format_id: "547593",
          provider_product_name: "Vi de Glass",
          provider_sale_format_name: "Botella Vi de Glass",
          winerim_wine_id: "47593",
          format_type: "BOTTLE",
          stock_id: "stock-47593",
          stock_active: true,
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

    const persistence = fake.statements.find((statement) => (
      statement.text.includes("INSERT INTO public.sales_line_items")
    ))!;
    const linePayload = persistence.values.find((value) => (
      typeof value === "string" && value.includes("\"mapped\"")
    ));
    expect(JSON.parse(String(linePayload))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerProductId: "parent-product-1",
        winerimWineId: "47593",
        mapped: true,
      }),
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
