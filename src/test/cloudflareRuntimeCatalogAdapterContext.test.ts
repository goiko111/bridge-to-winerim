import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
  TransactionOptions,
} from "../../cloudflare/workers/middleware-api/src/db";
import { createPostgresCatalogAdapter } from "../../cloudflare/workers/middleware-runtime/src/adapters/catalog";
import type { CatalogRequest } from "../../cloudflare/workers/middleware-runtime/src/handlers/catalog";

type Route = (statement: SqlStatement) => QueryResult<Record<string, unknown>>;

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function fakeDatabase(route: Route) {
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
  return { database: { query, transaction } as DatabaseAdapter, statements, transactionOptions };
}

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function request(connectionId = CONNECTION_ID): CatalogRequest {
  return {
    action: "catalog.preview",
    canonicalAction: "preview",
    connectionId,
    dryRun: true,
    formats: ["BOTTLE", "GLASS"],
    wineSelection: { kind: "ids", ids: ["1"] },
  };
}

function contextRoute(statement: SqlStatement): QueryResult<Record<string, unknown>> {
  if (statement.text.includes("FROM public.pos_connections")) {
    return result([{
      id: CONNECTION_ID,
      provider: "agora",
      provider_config: {
        agora_vintage_disambiguation_product_ids: ["600001"],
        agora_product_name_overrides: { "600001": "B Test 2024" },
      },
      default_family_id: "10",
      updated_at: "2026-08-02T08:00:00Z",
      last_catalog_sync_at: "2026-08-02T08:00:00Z",
    }]);
  }
  if (statement.text.includes("FROM public.agora_master_data")) {
    return result([{
      families_json: [
        { Id: "10", Name: "TINTOS WINERIM" },
        { Id: "20", Name: "COPAS WINERIM" },
      ],
      products_summary_json: [{
        Id: "600001",
        Name: "B Test 2024",
        ButtonText: "B Test 2024",
        FamilyId: "10",
        raw_payload: { attributes: { BaseSaleFormatId: "864" } },
      }],
      fetched_at: "2026-08-02T08:01:00Z",
      updated_at: "2026-08-02T08:01:00Z",
    }]);
  }
  if (statement.text.includes("FROM public.winerim_wines")) {
    return result([{
      winerim_id: "1",
      name: "Test",
      vintage: "2024",
      wine_type: "red",
      price: 20,
      bottle_sale_price: 21,
      bottle_purchase_price: 8,
      glass_sale_price: 5,
      glass_cost_price: 1.5,
      magnum_sale_price: null,
      magnum_purchase_price: null,
      serve_by_glass: true,
      is_active: true,
      raw_payload: {},
      updated_at: "2026-08-02T08:02:00Z",
    }]);
  }
  if (statement.text.includes("FROM public.product_mappings")) {
    return result([{
      provider_product_id: "600001",
      provider_product_name: "B Test 2024",
      winerim_wine_id: "1",
      winerim_wine_name: "Test",
      format_type: "BOTTLE",
      agora_product_id: "600001",
      status: "CONFIRMED",
      match_method: "MANUAL",
      updated_at: "2026-08-02T08:03:00Z",
    }]);
  }
  if (statement.text.includes("FROM public.provider_products")) {
    return result([{
      provider_product_id: "700001",
      name: "C Test",
      family: "COPAS WINERIM",
      price: 5,
      sale_format: "GLASS",
      winerim_wine_id: "1",
      sync_status: "SYNCED",
      raw_payload: { FamilyId: "20", ButtonText: "C Test" },
      updated_at: "2026-08-02T08:04:00Z",
    }]);
  }
  if (statement.text.includes("FROM public.winerim_push_tracking")) {
    return result([{
      winerim_wine_id: "1",
      format: "GLASS",
      agora_product_id: "700001",
      agora_family_id: "20",
      sync_status: "VERIFIED",
      source: "WINERIM",
      updated_at: "2026-08-02T08:05:00Z",
    }]);
  }
  throw new Error(`Unexpected query: ${statement.text}`);
}

describe("PostgreSQL catalog adapter context", () => {
  it("loads and normalizes connection, master, wines, mappings, provider products and tracking", async () => {
    const fake = fakeDatabase(contextRoute);
    const adapter = createPostgresCatalogAdapter(fake.database);

    const loaded = await adapter.loadPlanningContext(request());

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.context).toMatchObject({
      provider: "agora",
      existingFamilies: [
        { id: "10", name: "TINTOS WINERIM" },
        { id: "20", name: "COPAS WINERIM" },
      ],
      familyRouting: {
        byFormat: { GLASS: { id: "20", name: "COPAS WINERIM" } },
        byWineType: { tinto: { id: "10", name: "TINTOS WINERIM" } },
        defaultFamily: { id: "10", name: "TINTOS WINERIM" },
      },
      labelPolicy: {
        buttonTextMaxLength: 20,
        vintageDisambiguationProductIds: ["600001"],
        nameOverridesByProductId: { "600001": "B Test 2024" },
      },
    });
    expect(loaded.context.wines).toEqual([expect.objectContaining({
      winerimId: "1",
      name: "Test",
      wineType: "tinto",
      active: true,
      variants: [
        expect.objectContaining({ format: "BOTTLE", salePrice: 21, explicitProductId: "600001" }),
        expect.objectContaining({ format: "GLASS", salePrice: 5, explicitProductId: "700001" }),
      ],
    })]);
    expect(loaded.context.existingProducts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: "600001",
        baseSaleFormatId: "864",
        name: "B Test 2024",
        familyId: "10",
      }),
      expect.objectContaining({ productId: "700001", name: "C Test", familyId: "20", salePrice: 5 }),
    ]));
    expect(loaded.context.productIdPolicy?.explicitIds).toMatchObject({
      "1:BOTTLE": "600001",
      "1:GLASS": "700001",
    });
    expect(loaded.context.sourceRevision).toContain("catalog-db:v1");
    expect(loaded.context.sourceRevision).toContain("1@2026-08-02T08:05:00Z");
    expect(fake.statements).toHaveLength(6);
    expect(fake.statements.map((statement) => statement.text)).toEqual([
      expect.stringContaining("FROM public.pos_connections"),
      expect.stringContaining("FROM public.agora_master_data"),
      expect.stringContaining("FROM public.winerim_wines"),
      expect.stringContaining("FROM public.product_mappings"),
      expect.stringContaining("FROM public.provider_products"),
      expect.stringContaining("FROM public.winerim_push_tracking"),
    ]);
    expect(fake.statements[2].values).toEqual([CONNECTION_ID, ["1"], ["1"]]);
    expect(fake.transactionOptions).toEqual([{ isolationLevel: "repeatable-read", readOnly: true }]);
  });

  it("prefers a newer exact provider readback over a stale master snapshot", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.agora_master_data")) {
        return result([{
          families_json: [
            { Id: "10", Name: "TINTOS WINERIM" },
            { Id: "20", Name: "COPAS WINERIM" },
          ],
          products_summary_json: [{
            Id: "700001",
            Name: "C Test",
            FamilyId: "20",
            MainPrice: 4,
          }],
          fetched_at: "2026-08-02T08:01:00Z",
          updated_at: "2026-08-02T08:01:00Z",
        }]);
      }
      return contextRoute(statement);
    });

    const loaded = await createPostgresCatalogAdapter(fake.database).loadPlanningContext(request());

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.context.existingProducts).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: "700001", salePrice: 5 }),
    ]));
  });

  it("keeps a fresher master snapshot authoritative over an older provider cache row", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.agora_master_data")) {
        return result([{
          families_json: [
            { Id: "10", Name: "TINTOS WINERIM" },
            { Id: "20", Name: "COPAS WINERIM" },
          ],
          products_summary_json: [{
            Id: "700001",
            Name: "C Test",
            FamilyId: "20",
            MainPrice: 6,
          }],
          fetched_at: "2026-08-02T08:06:00Z",
          updated_at: "2026-08-02T08:06:00Z",
        }]);
      }
      return contextRoute(statement);
    });

    const loaded = await createPostgresCatalogAdapter(fake.database).loadPlanningContext(request());

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.context.existingProducts).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: "700001", salePrice: 6 }),
    ]));
  });

  it("keeps connection and selection values out of SQL text", async () => {
    const fake = fakeDatabase(contextRoute);
    const injectedConnection = "x' OR true; DELETE FROM public.pos_connections --";
    const loaded = await createPostgresCatalogAdapter(fake.database)
      .loadPlanningContext(request(injectedConnection));

    expect(loaded.ok).toBe(true);
    for (const statement of fake.statements) {
      expect(statement.text).not.toContain(injectedConnection);
      expect(statement.values).toContain(injectedConnection);
    }
    expect(fake.statements[2].text).toContain("winerim_id = ANY");
    expect(fake.statements[2].text).not.toContain("'1'");
  });

  it("does not treat mapping or tracking rows as proof that a product exists remotely", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.agora_master_data")) {
        return result([{
          families_json: [
            { Id: "10", Name: "TINTOS WINERIM" },
            { Id: "20", Name: "COPAS WINERIM" },
          ],
          products_summary_json: [],
          fetched_at: "2026-08-02T08:01:00Z",
          updated_at: "2026-08-02T08:01:00Z",
        }]);
      }
      if (statement.text.includes("FROM public.provider_products")) return result([]);
      return contextRoute(statement);
    });

    const loaded = await createPostgresCatalogAdapter(fake.database).loadPlanningContext(request());

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.context.existingProducts).toEqual([]);
    expect(loaded.context.productIdPolicy?.explicitIds).toMatchObject({
      "1:BOTTLE": "600001",
      "1:GLASS": "700001",
    });
  });

  it("prefers verified Winerim tracking over a legacy sales mapping for catalog identity", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.product_mappings")) {
        return result([{
          provider_product_id: "818",
          provider_product_name: "CAMPILLO 2021 CRIANZA",
          winerim_wine_id: "1",
          winerim_wine_name: "Test",
          format_type: "BOTTLE",
          agora_product_id: "818",
          status: "CONFIRMED",
          match_method: "MANUAL",
          updated_at: "2026-08-02T08:03:00Z",
        }]);
      }
      if (statement.text.includes("FROM public.winerim_push_tracking")) {
        return result([{
          winerim_wine_id: "1",
          format: "BOTTLE",
          agora_product_id: "656694",
          agora_family_id: "10",
          sync_status: "VERIFIED",
          source: "WINERIM",
          updated_at: "2026-08-02T08:05:00Z",
        }]);
      }
      return contextRoute(statement);
    });

    const loaded = await createPostgresCatalogAdapter(fake.database).loadPlanningContext(request());

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.context.productIdPolicy?.explicitIds).toMatchObject({
      "1:BOTTLE": "656694",
    });
    expect(loaded.context.wines[0]?.variants).toEqual(expect.arrayContaining([
      expect.objectContaining({ format: "BOTTLE", explicitProductId: "656694" }),
    ]));
  });

  it("fails closed when master families are missing", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.pos_connections")) return contextRoute(statement);
      if (statement.text.includes("FROM public.agora_master_data")) {
        return result([{ families_json: [], products_summary_json: [], fetched_at: null, updated_at: null }]);
      }
      throw new Error("must stop before loading catalog tables");
    });

    await expect(createPostgresCatalogAdapter(fake.database).loadPlanningContext(request()))
      .resolves.toEqual({ ok: false, code: "CONTEXT_INVALID" });
    expect(fake.statements).toHaveLength(2);
  });

  it("sanitizes database failures as context unavailable", async () => {
    const fake = fakeDatabase(() => {
      throw new Error("postgres://user:secret@host/database");
    });

    const loaded = await createPostgresCatalogAdapter(fake.database).loadPlanningContext(request());

    expect(loaded).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect(JSON.stringify(loaded)).not.toContain("secret");
  });
});
