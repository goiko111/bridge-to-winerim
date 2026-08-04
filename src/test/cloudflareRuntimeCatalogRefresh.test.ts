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

function fakeDatabase(existingPrice = 10, blockedFormats: string[] = []) {
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
    if (statement.text.includes("FROM public.runtime_catalog_changes")) {
      return result(blockedFormats.map((format) => ({
        winerim_wine_id: "42",
        format,
      }))) as QueryResult<Row>;
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
    expect(fake.statements).toHaveLength(2);
  });

  it("reopens a retryable blocked variant even when its Winerim source did not change", async () => {
    const fake = fakeDatabase(10, ["BOTTLE"]);
    const outcome = await refresh(fake, request(10)).refresh({
      connectionId: CONNECTION_ID,
      messageId: "catalog-message-reopen",
      idempotencyKey: "catalog-envelope-reopen",
      dryRun: false,
      credential: { read: () => "credential-secret" },
    });

    expect(outcome).toEqual({ ok: true, outcome: "complete", changed: 1 });
    const queued = fake.statements.find((statement) => statement.text.includes("INSERT INTO public.runtime_catalog_changes"));
    expect(queued?.values).toEqual(expect.arrayContaining(["42", "BOTTLE", "catalog-message-reopen"]));
    expect(queued?.text).toContain("ELSE 'PENDING'");
  });
});
