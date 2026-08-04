import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
} from "../../cloudflare/workers/middleware-api/src/db";
import { createPostgresCatalogAdapter } from "../../cloudflare/workers/middleware-runtime/src/adapters/catalog";
import { createPostgresSalesAdapter } from "../../cloudflare/workers/middleware-runtime/src/adapters/sales";
import {
  buildCatalogPlan,
  type CatalogPlanningContext,
  type CatalogRequest,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/catalog";
import {
  catalogProductCanonicalFingerprint,
  createAgoraCatalogPlanApplyAndReadbackPort,
  renderAgoraCatalogProductXml,
  type AgoraCatalogXmlProfile,
} from "../../cloudflare/workers/middleware-runtime-executor/src/catalog";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function profile(): AgoraCatalogXmlProfile {
  return {
    vatId: "1",
    priceListIds: ["1"],
    warehouseIds: ["1"],
    colorByFormat: { BOTTLE: "#8B0000", GLASS: "#FFFFFF", MAGNUM: "#333333" },
    preparationTypeId: "3",
    preparationOrderId: "4",
    orderByProductId: { "500042": "42" },
  };
}

function master(productXml: string): string {
  return `<?xml version="1.0"?><Export><Products>${productXml}</Products></Export>`;
}

function xml(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
}

describe("catalog zero-price to sales mapping chain", () => {
  it("certifies price 0 as HIDDEN and leaves an exact sales-readable mapping", async () => {
    const request: CatalogRequest = {
      action: "catalog.apply",
      canonicalAction: "apply",
      connectionId: CONNECTION_ID,
      dryRun: false,
      formats: ["BOTTLE"],
      wineSelection: { kind: "ids", ids: ["42"] },
    };
    const context: CatalogPlanningContext = {
      connectionId: CONNECTION_ID,
      provider: "agora",
      sourceRevision: "e2e-zero-price",
      wines: [{
        winerimId: "42",
        name: "Retired E2E",
        wineType: "tinto",
        active: true,
        variants: [{
          format: "BOTTLE",
          salePrice: 0,
          costPrice: 0,
          enabled: false,
          explicitProductId: "500042",
        }],
      }],
      existingFamilies: [{ id: "10", name: "TINTOS WINERIM" }],
      existingProducts: [{
        productId: "500042",
        name: "B Retired E2E",
        buttonText: "B Retired E2E",
        familyId: "10",
        salePrice: 25,
        costPrice: 8,
        useAsDirectSale: false,
        saleableAsMain: true,
      }],
    };
    const plan = await buildCatalogPlan(request, context);
    expect(plan).toMatchObject({
      readyToApply: true,
      operations: [{
        kind: "update",
        desired: { productId: "500042", saleableAsMain: false },
        changedFields: ["saleableAsMain"],
      }],
    });

    const desired = plan.operations[0].desired;
    const baselineXml = renderAgoraCatalogProductXml({ ...desired, saleableAsMain: true }, profile());
    const hiddenXml = renderAgoraCatalogProductXml(desired, profile());
    const responses = [
      xml(master(baselineXml)),
      xml(master(baselineXml)),
      xml('<ImportResult Success="true" />'),
      xml(master(hiddenXml)),
    ];
    const remote = createAgoraCatalogPlanApplyAndReadbackPort({
      enabled: true,
      connectionId: CONNECTION_ID,
      baseUrl: "https://agora.example.test",
      allowedHosts: ["agora.example.test"],
      request: { request: vi.fn(async () => responses.shift()!) },
      profile: profile(),
    });
    const remoteResult = await remote.applyAndReadback({
      connectionId: CONNECTION_ID,
      messageId: "22222222-2222-4222-8222-222222222222",
      envelopeIdempotencyKey: "e2e-envelope",
      plan,
      credential: { read: () => "fixture-token" },
    });
    expect(remoteResult).toEqual({
      ok: true,
      receipt: {
        status: "applied",
        appliedProductIds: ["500042"],
        canonicalProductFingerprints: {
          "500042": await catalogProductCanonicalFingerprint(desired),
        },
      },
    });

    let mappingCertified = false;
    let trackingHidden = false;
    const statements: SqlStatement[] = [];
    const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
      statements.push(statement);
      if (statement.text.includes("FROM public.pos_connections")) {
        return result([{ id: CONNECTION_ID, provider: "agora" }]) as QueryResult<Row>;
      }
      if (statement.text.includes("FROM public.product_mappings") && statement.text.includes("FOR UPDATE")) {
        return result() as QueryResult<Row>;
      }
      if (statement.text.includes("FROM public.winerim_push_tracking") && statement.text.includes("FOR UPDATE")) {
        return result() as QueryResult<Row>;
      }
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) {
        return result([{
          idempotency_key: plan.idempotency.key,
          job: "catalog.plan.db",
          status: "RUNNING",
          result: {},
        }]) as QueryResult<Row>;
      }
      if (statement.text.includes("INSERT INTO public.product_mappings")) {
        mappingCertified = statement.text.includes("'CONFIRMED'")
          && statement.text.includes("'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'")
          && statement.text.includes("stock_contract.stock_count = 1");
        return result(mappingCertified ? [{ provider_product_id: "500042" }] : []) as QueryResult<Row>;
      }
      if (statement.text.includes("INSERT INTO public.winerim_push_tracking")) {
        trackingHidden = statement.values.includes("HIDDEN");
        return result() as QueryResult<Row>;
      }
      if (statement.text.includes("UPDATE public.runtime_idempotency")) {
        return result([{
          idempotency_key: plan.idempotency.key,
          job: "catalog.plan.db",
          status: "SUCCESS",
          result: {},
        }]) as QueryResult<Row>;
      }
      if (statement.text.includes("FROM public.product_mappings pm")) {
        return result(mappingCertified && trackingHidden ? [{
          mapping_id: "mapping-1",
          provider_product_id: "500042",
          provider_product_name: "B Retired E2E",
          winerim_wine_id: "42",
          format_type: "BOTTLE",
          stock_id: "stock-42",
          stock_active: false,
        }] : []) as QueryResult<Row>;
      }
      throw new Error(`Unexpected query: ${statement.text}`);
    });
    const transaction: DatabaseAdapter["transaction"] = vi.fn(async (work) =>
      work({ query } as DatabaseTransaction)
    );
    const database = { query, transaction } as DatabaseAdapter;

    await expect(createPostgresCatalogAdapter(database).applyPlan({
      request,
      plan,
      idempotency: plan.idempotency,
    })).resolves.toEqual({
      ok: true,
      receipt: { status: "applied", appliedProductIds: ["500042"] },
    });
    expect(mappingCertified).toBe(true);
    expect(trackingHidden).toBe(true);

    const mappings = await createPostgresSalesAdapter(database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    }).readExactMappings(["500042"]);
    expect(mappings).toEqual([{
      mappingId: "mapping-1",
      mappingStatus: "CONFIRMED",
      providerProductId: "500042",
      providerProductName: "B Retired E2E",
      winerimWineId: "42",
      variant: "BOTTLE",
      stockId: "stock-42",
      stockActive: false,
    }]);
    const salesLookup = statements.find((statement) => statement.text.includes("FROM public.product_mappings pm"))!;
    expect(salesLookup.text).toContain("pm.status = 'CONFIRMED'");
    expect(salesLookup.text).toContain("pm.match_method = 'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'");
  });
});
