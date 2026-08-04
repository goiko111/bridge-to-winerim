import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
  TransactionOptions,
} from "../../cloudflare/workers/middleware-api/src/db";
import { createPostgresCatalogAdapter } from "../../cloudflare/workers/middleware-runtime/src/adapters/catalog";
import type {
  CatalogPlan,
  CatalogRequest,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/catalog";

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
  return {
    database: { query, transaction } as DatabaseAdapter,
    statements,
    transactionOptions,
  };
}

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_KEY = `catalog:v1:${"a".repeat(64)}`;
const FINGERPRINT = "b".repeat(64);

function request(overrides: Partial<CatalogRequest> = {}): CatalogRequest {
  return {
    action: "catalog.apply",
    canonicalAction: "apply",
    connectionId: CONNECTION_ID,
    dryRun: false,
    formats: ["BOTTLE"],
    wineSelection: { kind: "ids", ids: ["1"] },
    ...overrides,
  };
}

function plan(name = "B Test"): CatalogPlan {
  return {
    version: 1,
    connectionId: CONNECTION_ID,
    provider: "agora",
    sourceRevision: "catalog-db:v1:revision",
    action: "apply",
    dryRun: false,
    readyToApply: true,
    formats: ["BOTTLE"],
    operations: [{
      kind: "create",
      changedFields: ["name", "familyId", "salePrice", "costPrice"],
      desired: {
        productId: "500001",
        winerimId: "1",
        format: "BOTTLE",
        label: { name, buttonText: name.slice(0, 20) },
        family: { id: "10", name: "TINTOS WINERIM" },
        salePrice: 20,
        costPrice: 8,
        useAsDirectSale: false,
        saleableAsMain: true,
      },
      idempotency: {
        version: 1,
        scope: "catalog-product-upsert",
        key: `catalog-product:v1:${"c".repeat(64)}`,
        fingerprint: "d".repeat(64),
        connectionId: CONNECTION_ID,
        provider: "agora",
        sourceRevision: "catalog-db:v1:revision",
        productId: "500001",
      },
    }],
    productLabelsById: { "500001": { name, buttonText: name.slice(0, 20) } },
    issues: [],
    summary: { requestedWines: 1, consideredVariants: 1, create: 1, update: 0, unchanged: 0, blocked: 0 },
    idempotency: {
      version: 1,
      scope: "catalog-plan",
      key: PLAN_KEY,
      fingerprint: FINGERPRINT,
      connectionId: CONNECTION_ID,
      provider: "agora",
      sourceRevision: "catalog-db:v1:revision",
    },
  };
}

function hiddenPlan(): CatalogPlan {
  const active = plan("B Hidden Test");
  return {
    ...active,
    operations: active.operations.map((operation) => ({
      ...operation,
      kind: "update" as const,
      changedFields: ["useAsDirectSale", "saleableAsMain"] as const,
      desired: {
        ...operation.desired,
        useAsDirectSale: false,
        saleableAsMain: false,
      },
    })),
    summary: { requestedWines: 1, consideredVariants: 1, create: 0, update: 1, unchanged: 0, blocked: 0 },
  };
}

function input(catalogPlan = plan()) {
  return {
    request: request(),
    plan: catalogPlan,
    idempotency: catalogPlan.idempotency,
  };
}

function successfulRoute(statement: SqlStatement): QueryResult<Record<string, unknown>> {
  if (statement.text.includes("FROM public.pos_connections")) {
    return result([{ id: CONNECTION_ID, provider: "agora" }]);
  }
  if (statement.text.includes("FROM public.product_mappings") && statement.text.includes("FOR UPDATE")) return result();
  if (statement.text.includes("FROM public.winerim_push_tracking") && statement.text.includes("FOR UPDATE")) return result();
  if (statement.text.includes("INSERT INTO public.runtime_idempotency")) {
    return result([{ idempotency_key: PLAN_KEY, job: "catalog.plan.db", status: "RUNNING", result: {} }]);
  }
  if (statement.text.includes("INSERT INTO public.product_mappings")) return result([{ provider_product_id: "500001" }]);
  if (statement.text.includes("INSERT INTO public.winerim_push_tracking")) return result();
  if (statement.text.includes("UPDATE public.runtime_idempotency")) {
    return result([{ idempotency_key: PLAN_KEY, job: "catalog.plan.db", status: "SUCCESS", result: {} }]);
  }
  throw new Error(`Unexpected query: ${statement.text}`);
}

describe("PostgreSQL catalog adapter plan persistence", () => {
  it("executes the exact persistence path in a rollback-only preflight transaction", async () => {
    const fake = fakeDatabase(successfulRoute);
    const preflight = await createPostgresCatalogAdapter(fake.database).preflightApplyPlan(input());

    expect(preflight).toEqual({
      ok: true,
      receipt: { status: "applied", appliedProductIds: ["500001"] },
    });
    expect(fake.transactionOptions).toEqual([{ isolationLevel: "serializable", readOnly: false }]);
    expect(fake.statements.map((statement) => statement.text)).toEqual([
      expect.stringContaining("FROM public.pos_connections"),
      expect.stringContaining("FROM public.product_mappings"),
      expect.stringContaining("FROM public.winerim_push_tracking"),
      expect.stringContaining("INSERT INTO public.runtime_idempotency"),
      expect.stringContaining("INSERT INTO public.product_mappings"),
      expect.stringContaining("INSERT INTO public.winerim_push_tracking"),
      expect.stringContaining("UPDATE public.runtime_idempotency"),
    ]);
  });

  it("fails preflight on an RLS-like mapping denial before tracking can be certified", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("INSERT INTO public.product_mappings")) {
        throw new Error("RLS_DENIED");
      }
      return successfulRoute(statement);
    });

    await expect(createPostgresCatalogAdapter(fake.database).preflightApplyPlan(input())).resolves.toEqual({
      ok: false,
      code: "APPLY_UNAVAILABLE",
    });
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.winerim_push_tracking")))
      .toBe(false);
  });

  it("persists the active variant as an exact CONFIRMED sales mapping and VERIFIED tracking", async () => {
    const fake = fakeDatabase(successfulRoute);
    const applied = await createPostgresCatalogAdapter(fake.database).applyPlan(input());

    expect(applied).toEqual({
      ok: true,
      receipt: { status: "applied", appliedProductIds: ["500001"] },
    });
    expect(fake.transactionOptions).toEqual([{ isolationLevel: "serializable", readOnly: false }]);
    const texts = fake.statements.map((statement) => statement.text);
    expect(texts).toEqual([
      expect.stringContaining("FROM public.pos_connections"),
      expect.stringContaining("FROM public.product_mappings"),
      expect.stringContaining("FROM public.winerim_push_tracking"),
      expect.stringContaining("INSERT INTO public.runtime_idempotency"),
      expect.stringContaining("INSERT INTO public.product_mappings"),
      expect.stringContaining("INSERT INTO public.winerim_push_tracking"),
      expect.stringContaining("UPDATE public.runtime_idempotency"),
    ]);
    const mapping = fake.statements.find((statement) => statement.text.includes("INSERT INTO public.product_mappings"))!;
    expect(mapping.text).toContain("'RESCUE_EXACT_ID_WINE_VARIANT'");
    expect(mapping.text).toContain("'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'");
    expect(mapping.text).toContain("'CONFIRMED'");
    expect(mapping.text).not.toContain("'RUNTIME_CATALOG_PLAN'");
    expect(mapping.text).toContain("stock_contract.stock_count = 1");
    expect(mapping.values).toContainEqual(["EXACT_PROVIDER_READBACK", `plan:${PLAN_KEY}`]);
    const tracking = fake.statements.find((statement) => statement.text.includes("INSERT INTO public.winerim_push_tracking"))!;
    expect(tracking.values).toContain("VERIFIED");
    expect(tracking.values).not.toContain("HIDDEN");
    expect(tracking.text).toContain("sync_status = EXCLUDED.sync_status");
    expect(tracking.text).toContain("pushed_at = EXCLUDED.pushed_at");
    expect(tracking.text).toContain("verified_at = EXCLUDED.verified_at");
    expect(texts.join("\n")).not.toContain("provider_products");
    expect(texts.join("\n")).not.toContain("agora_master_data");
  });

  it("fails closed when exact provider certification has no unique Winerim stock contract", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.pos_connections")) {
        return result([{ id: CONNECTION_ID, provider: "agora" }]);
      }
      if (statement.text.includes("FROM public.product_mappings") && statement.text.includes("FOR UPDATE")) return result();
      if (statement.text.includes("FROM public.winerim_push_tracking") && statement.text.includes("FOR UPDATE")) return result();
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) {
        return result([{ idempotency_key: PLAN_KEY, job: "catalog.plan.db", status: "RUNNING", result: {} }]);
      }
      if (statement.text.includes("INSERT INTO public.product_mappings")) return result();
      throw new Error(`Unexpected query: ${statement.text}`);
    });

    await expect(createPostgresCatalogAdapter(fake.database).applyPlan(input())).resolves.toEqual({
      ok: false,
      code: "APPLY_REJECTED",
    });
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.winerim_push_tracking")))
      .toBe(false);
  });

  it("persists an exact certified hide as HIDDEN without preserving a stale VERIFIED state", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.pos_connections")) {
        return result([{ id: CONNECTION_ID, provider: "agora" }]);
      }
      if (statement.text.includes("FROM public.product_mappings") && statement.text.includes("FOR UPDATE")) return result();
      if (statement.text.includes("FROM public.winerim_push_tracking") && statement.text.includes("FOR UPDATE")) {
        return result([{
          winerim_wine_id: "1",
          format: "BOTTLE",
          agora_product_id: "500001",
          agora_family_id: "10",
          sync_status: "VERIFIED",
          source: "WINERIM",
        }]);
      }
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) {
        return result([{ idempotency_key: PLAN_KEY, job: "catalog.plan.db", status: "RUNNING", result: {} }]);
      }
      if (statement.text.includes("INSERT INTO public.product_mappings")) return result([{ provider_product_id: "500001" }]);
      if (statement.text.includes("INSERT INTO public.winerim_push_tracking")) return result();
      if (statement.text.includes("UPDATE public.runtime_idempotency")) {
        return result([{ idempotency_key: PLAN_KEY, job: "catalog.plan.db", status: "SUCCESS", result: {} }]);
      }
      throw new Error(`Unexpected query: ${statement.text}`);
    });

    const applied = await createPostgresCatalogAdapter(fake.database).applyPlan(input(hiddenPlan()));

    expect(applied).toEqual({
      ok: true,
      receipt: { status: "applied", appliedProductIds: ["500001"] },
    });
    const tracking = fake.statements.find((statement) => statement.text.includes("INSERT INTO public.winerim_push_tracking"))!;
    expect(tracking.values).toContain("HIDDEN");
    expect(tracking.values).not.toContain("VERIFIED");
    expect(tracking.text).not.toContain("THEN winerim_push_tracking.sync_status");
  });

  it("rejects a direct dry-run apply before opening a transaction", async () => {
    const fake = fakeDatabase(() => {
      throw new Error("database must remain untouched");
    });
    const dryRunPlan = { ...plan(), action: "preview" as const, dryRun: true };
    const applied = await createPostgresCatalogAdapter(fake.database).applyPlan({
      request: request({ action: "catalog.preview", canonicalAction: "preview", dryRun: true }),
      plan: dryRunPlan,
      idempotency: dryRunPlan.idempotency,
    });

    expect(applied).toEqual({ ok: false, code: "APPLY_REJECTED" });
    expect(fake.database.transaction).not.toHaveBeenCalled();
    expect(fake.statements).toEqual([]);
  });

  it("returns a duplicate without rewriting mappings or tracking", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.pos_connections")) return result([{ id: CONNECTION_ID, provider: "agora" }]);
      if (statement.text.includes("FROM public.product_mappings")) return result();
      if (statement.text.includes("FROM public.winerim_push_tracking")) return result();
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result();
      if (statement.text.includes("FROM public.runtime_idempotency")) {
        return result([{
          idempotency_key: PLAN_KEY,
          job: "catalog.plan.db",
          status: "SUCCESS",
          result: { fingerprint: FINGERPRINT, state: "DB_PLAN_PREPARED" },
        }]);
      }
      throw new Error(`Unexpected query: ${statement.text}`);
    });

    const applied = await createPostgresCatalogAdapter(fake.database).applyPlan(input());

    expect(applied).toEqual({
      ok: true,
      receipt: { status: "duplicate", appliedProductIds: ["500001"] },
    });
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.product_mappings"))).toBe(false);
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.winerim_push_tracking"))).toBe(false);
  });

  it("fails closed on an existing mapping identity conflict before claiming idempotency", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.pos_connections")) return result([{ id: CONNECTION_ID, provider: "agora" }]);
      if (statement.text.includes("FROM public.product_mappings")) {
        return result([{
          provider_product_id: "500001",
          provider_product_name: "Different wine",
          winerim_wine_id: "99",
          format_type: "BOTTLE",
          status: "CONFIRMED",
        }]);
      }
      if (statement.text.includes("FROM public.winerim_push_tracking")) return result();
      throw new Error(`Unexpected query: ${statement.text}`);
    });

    const applied = await createPostgresCatalogAdapter(fake.database).applyPlan(input());

    expect(applied).toEqual({ ok: false, code: "APPLY_CONFLICT" });
    expect(fake.statements.some((statement) => statement.text.includes("runtime_idempotency"))).toBe(false);
  });

  it("parameterizes labels, IDs, arrays and plan metadata", async () => {
    const malicious = "B Test'); DELETE FROM public.product_mappings; --";
    const fake = fakeDatabase(successfulRoute);

    await createPostgresCatalogAdapter(fake.database).applyPlan(input(plan(malicious)));

    const allText = fake.statements.map((statement) => statement.text).join("\n");
    expect(allText).not.toContain(malicious);
    expect(fake.statements.some((statement) => statement.values.includes(malicious))).toBe(true);
    expect(allText).not.toContain(PLAN_KEY);
    expect(fake.statements.some((statement) => statement.values.includes(PLAN_KEY))).toBe(true);
  });

  it("maps unexpected database failures to an unavailable result without leaking details", async () => {
    const fake = fakeDatabase(() => {
      throw new Error("postgres://user:secret@host/database");
    });

    const applied = await createPostgresCatalogAdapter(fake.database).applyPlan(input());

    expect(applied).toEqual({ ok: false, code: "APPLY_UNAVAILABLE" });
    expect(JSON.stringify(applied)).not.toContain("secret");
  });
});
