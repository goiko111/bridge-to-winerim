import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
  TransactionOptions,
} from "../../cloudflare/workers/middleware-api/src/db";
import { createPostgresWinerimCatalogRefreshPort } from "../../cloudflare/workers/middleware-runtime-executor/src/catalogRefresh";
import type { HttpTimerPort } from "../../cloudflare/workers/middleware-runtime/src/adapters/http";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function timer(): HttpTimerPort {
  return {
    now: () => Date.now(),
    schedule: vi.fn(() => Symbol("timer")),
    cancel: vi.fn(),
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type ChangeStateFixture = Readonly<{
  winerim_wine_id: string;
  format: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "BLOCKED";
  source_fingerprint: string;
}>;

function fakeDatabase(options: Readonly<{
  existingPrice?: number;
  changeStates?: readonly ChangeStateFixture[];
  evidenceMarker?: string;
  unrelatedEvidenceMarker?: string;
}> = {}) {
  const existingPrice = options.existingPrice ?? 10;
  const statements: SqlStatement[] = [];
  const transactionOptions: TransactionOptions[] = [];
  const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
    statements.push(statement);
    if (statement.text.includes("FROM public.winerim_wines")) {
      return result([{
        winerim_id: "42",
        name: "Test wine",
        vintage: "2024",
        wine_type: "tinto",
        is_active: true,
        bottle_sale_price: existingPrice,
        bottle_purchase_price: 4,
        glass_sale_price: null,
        glass_cost_price: null,
        magnum_sale_price: null,
        magnum_purchase_price: null,
      }]) as QueryResult<Row>;
    }
    if (statement.text.includes("AS connection_evidence")) {
      const marker = options.evidenceMarker ?? "stable";
      return result([{
        connection_evidence: { defaultFamilyId: 10 },
        master_evidence: {
          families: [{ Id: 10, Name: "TINTOS WINERIM" }],
          products: [
            { Id: "500042", marker },
            { Id: "500999", marker: options.unrelatedEvidenceMarker ?? "stable" },
          ],
        },
        mapping_evidence: [],
        provider_product_evidence: [],
        tracking_evidence: [],
      }]) as QueryResult<Row>;
    }
    if (statement.text.includes("FROM public.runtime_catalog_changes")) {
      return result([...(options.changeStates ?? [])]) as QueryResult<Row>;
    }
    return result([]) as QueryResult<Row>;
  });
  const transaction: DatabaseAdapter["transaction"] = vi.fn(async (work, options = {}) => {
    transactionOptions.push(options);
    return work({ query } as DatabaseTransaction);
  });
  return { adapter: { query, transaction } as DatabaseAdapter, statements, transactionOptions, transaction };
}

function request(price: number | null) {
  return vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v2/wines") {
      return json({
        success: true,
        pagination: { total_pages: 1 },
        wines: [{ id: 42, name: "Test wine" }],
      });
    }
    return json({
      success: true,
      wines: [{
        id: 42,
        name: "Test wine",
        vintage: 2024,
        type: "Tinto",
        prices: price === null ? [] : [{ variant: "botella", price }],
        bottle_purchase_price: 4,
      }],
    });
  });
}

function refresh(fake: ReturnType<typeof fakeDatabase>, http: ReturnType<typeof request>) {
  return createPostgresWinerimCatalogRefreshPort({
    database: fake.adapter,
    baseUrl: "https://winerim.example.test",
    allowedHosts: ["winerim.example.test"],
    request: { request: http },
    timer: timer(),
  });
}

describe("full Winerim catalog refresh", () => {
  it("persists a changed price and queues only its exact variant atomically", async () => {
    const fake = fakeDatabase();
    const outcome = await refresh(fake, request(12)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-1",
      idempotencyKey: "catalog-envelope-1",
      dryRun: false,
      credential: { read: () => "credential-secret" },
    });

    expect(outcome).toEqual({ ok: true, outcome: "complete", changed: 1 });
    expect(fake.transaction).toHaveBeenCalledOnce();
    expect(fake.transactionOptions).toEqual([{ isolationLevel: "serializable" }]);
    expect(fake.statements.some((statement) => statement.text.includes("INSERT INTO public.winerim_wines"))).toBe(true);
    const queued = fake.statements.find((statement) => statement.text.includes("INSERT INTO public.runtime_catalog_changes"));
    expect(queued?.values).toEqual(expect.arrayContaining([CONNECTION_ID, "42", "BOTTLE", "catalog-message-1"]));
    expect(JSON.stringify(fake.statements)).not.toContain("credential-secret");
  });

  it("queues an exact hide transition when a previously priced variant disappears", async () => {
    const fake = fakeDatabase();
    const outcome = await refresh(fake, request(null)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-hide",
      idempotencyKey: "catalog-envelope-hide",
      dryRun: false,
      credential: { read: () => "credential-secret" },
    });

    expect(outcome).toEqual({ ok: true, outcome: "complete", changed: 1 });
    const queued = fake.statements.find((statement) => statement.text.includes("INSERT INTO public.runtime_catalog_changes"));
    expect(queued?.values).toEqual(expect.arrayContaining(["42", "BOTTLE", "catalog-message-hide"]));
    const upsert = fake.statements.find((statement) => statement.text.includes("INSERT INTO public.winerim_wines"));
    expect(upsert?.values).toContain(null);
  });

  it("keeps dry-run read-only while returning the exact change count", async () => {
    const fake = fakeDatabase();
    const outcome = await refresh(fake, request(12)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-preview",
      idempotencyKey: "catalog-envelope-preview",
      dryRun: true,
      credential: { read: () => "credential-secret" },
    });

    expect(outcome).toEqual({ ok: true, outcome: "complete", changed: 1 });
    expect(fake.transaction).not.toHaveBeenCalled();
    expect(fake.statements).toHaveLength(3);
  });

  it("keeps BLOCKED closed for identical evidence and reopens only after relevant evidence changes", async () => {
    const initial = fakeDatabase({ existingPrice: 10 });
    await refresh(initial, request(12)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-initial",
      idempotencyKey: "catalog-envelope-initial",
      dryRun: false,
      credential: { read: () => "credential-secret" },
    });
    const initialQueue = initial.statements.find((statement) =>
      statement.text.includes("INSERT INTO public.runtime_catalog_changes")
    )!;
    const fingerprint = initialQueue.values.find((value) =>
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ) as string;
    const blocked: ChangeStateFixture = {
      winerim_wine_id: "42",
      format: "BOTTLE",
      status: "BLOCKED",
      source_fingerprint: fingerprint,
    };
    const unchanged = fakeDatabase({ existingPrice: 12, changeStates: [blocked] });
    const unchangedOutcome = await refresh(unchanged, request(12)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-blocked-same",
      idempotencyKey: "catalog-envelope-blocked-same",
      dryRun: false,
      credential: { read: () => "credential-secret" },
    });

    expect(unchangedOutcome).toEqual({ ok: true, outcome: "duplicate", changed: 0 });
    expect(unchanged.statements.some((statement) =>
      statement.text.includes("INSERT INTO public.runtime_catalog_changes")
    )).toBe(false);

    const changed = fakeDatabase({
      existingPrice: 12,
      changeStates: [blocked],
      evidenceMarker: "provider-master-drift",
    });
    const changedOutcome = await refresh(changed, request(12)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-blocked-drift",
      idempotencyKey: "catalog-envelope-blocked-drift",
      dryRun: false,
      credential: { read: () => "credential-secret" },
    });

    expect(changedOutcome).toEqual({ ok: true, outcome: "complete", changed: 1 });
    const queued = changed.statements.find((statement) => statement.text.includes("INSERT INTO public.runtime_catalog_changes"));
    expect(queued?.values).toEqual(expect.arrayContaining(["42", "BOTTLE", "catalog-message-blocked-drift"]));
    expect(queued?.text).toContain("source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint");
    expect(queued?.text).toContain("lease_expires_at = NULL");
  });

  it("does not reopen BLOCKED when only another product's evidence changes", async () => {
    const initial = fakeDatabase({ existingPrice: 10 });
    await refresh(initial, request(12)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-unrelated-seed",
      idempotencyKey: "catalog-envelope-unrelated-seed",
      dryRun: false,
      credential: { read: () => "credential-secret" },
    });
    const initialQueue = initial.statements.find((statement) =>
      statement.text.includes("INSERT INTO public.runtime_catalog_changes")
    )!;
    const fingerprint = initialQueue.values.find((value) =>
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ) as string;
    const unchanged = fakeDatabase({
      existingPrice: 12,
      changeStates: [{
        winerim_wine_id: "42",
        format: "BOTTLE",
        status: "BLOCKED",
        source_fingerprint: fingerprint,
      }],
      unrelatedEvidenceMarker: "changed-other-product",
    });

    const outcome = await refresh(unchanged, request(12)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-unrelated-drift",
      idempotencyKey: "catalog-envelope-unrelated-drift",
      dryRun: false,
      credential: { read: () => "credential-secret" },
    });

    expect(outcome).toEqual({ ok: true, outcome: "duplicate", changed: 0 });
    expect(unchanged.statements.some((statement) =>
      statement.text.includes("INSERT INTO public.runtime_catalog_changes")
    )).toBe(false);
  });

  it("revalidates a prior SUCCESS when semantic provider evidence drifts", async () => {
    const initial = fakeDatabase({ existingPrice: 10 });
    await refresh(initial, request(12)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-success-seed",
      idempotencyKey: "catalog-envelope-success-seed",
      dryRun: false,
      credential: { read: () => "credential-secret" },
    });
    const initialQueue = initial.statements.find((statement) =>
      statement.text.includes("INSERT INTO public.runtime_catalog_changes")
    )!;
    const fingerprint = initialQueue.values.find((value) =>
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ) as string;
    const success: ChangeStateFixture = {
      winerim_wine_id: "42",
      format: "BOTTLE",
      status: "SUCCESS",
      source_fingerprint: fingerprint,
    };
    const drifted = fakeDatabase({
      existingPrice: 12,
      changeStates: [success],
      evidenceMarker: "changed-tracking-or-master",
    });

    const outcome = await refresh(drifted, request(12)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-success-drift",
      idempotencyKey: "catalog-envelope-success-drift",
      dryRun: false,
      credential: { read: () => "credential-secret" },
    });

    expect(outcome).toEqual({ ok: true, outcome: "complete", changed: 1 });
    expect(drifted.statements.some((statement) =>
      statement.text.includes("INSERT INTO public.runtime_catalog_changes")
    )).toBe(true);
  });
});
