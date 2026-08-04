import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
  TransactionOptions,
} from "../../cloudflare/workers/middleware-api/src/db";
import { createPostgresCatalogChangeQueue } from "../../cloudflare/workers/middleware-runtime-executor/src/catalogChanges";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function database(route: (statement: SqlStatement) => QueryResult<Record<string, unknown>>) {
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
  return { adapter: { query, transaction } as DatabaseAdapter, statements, transactionOptions };
}

describe("PostgreSQL differential catalog change queue", () => {
  it("claims a bounded pending row under SKIP LOCKED and increments its exact attempt", async () => {
    const fake = database(() => result([{
      connection_id: CONNECTION_ID,
      winerim_wine_id: "42",
      format: "BOTTLE",
      source_fingerprint: "a".repeat(64),
      attempt: 3,
    }]));

    const claimed = await createPostgresCatalogChangeQueue(fake.adapter).claim({
      connectionId: CONNECTION_ID,
      limit: 99,
    });

    expect(claimed).toEqual([{
      connectionId: CONNECTION_ID,
      winerimWineId: "42",
      format: "BOTTLE",
      sourceFingerprint: "a".repeat(64),
      attempt: 3,
    }]);
    expect(fake.statements[0].text).toContain("FOR UPDATE SKIP LOCKED");
    expect(fake.statements[0].text).toContain("attempt = change.attempt + 1");
    expect(fake.statements[0].values).toEqual([CONNECTION_ID, 10]);
    expect(fake.transactionOptions).toEqual([{ isolationLevel: "read-committed" }]);
  });

  it("settles only the still-running exact fingerprint and attempt", async () => {
    const fake = database(() => result([{ connection_id: CONNECTION_ID }]));
    const queue = createPostgresCatalogChangeQueue(fake.adapter);
    const settled = await queue.settle({
      connectionId: CONNECTION_ID,
      winerimWineId: "42",
      format: "GLASS",
      sourceFingerprint: "b".repeat(64),
      attempt: 2,
    }, { status: "PENDING", retryAfterSeconds: 9000, error: "temporary conflict" });

    expect(settled).toBe(true);
    expect(fake.statements[0].text).toContain("source_fingerprint =");
    expect(fake.statements[0].text).toContain("status = 'RUNNING'");
    expect(fake.statements[0].values).toContain("b".repeat(64));
    expect(fake.statements[0].values).toContain(2);
    expect(fake.statements[0].values).toContain("CATALOG_CHANGE_FAILED");
    const retryAt = fake.statements[0].values.find((value) => typeof value === "string" && value.includes("T"));
    expect(new Date(String(retryAt)).getTime()).toBeLessThanOrEqual(Date.now() + 3_601_000);
  });

  it("rejects malformed database rows before they can reach a remote mutation", async () => {
    const fake = database(() => result([{
      connection_id: CONNECTION_ID,
      winerim_wine_id: "not-a-wine",
      format: "BOTTLE",
      source_fingerprint: "a".repeat(64),
      attempt: 0,
    }]));

    await expect(createPostgresCatalogChangeQueue(fake.adapter).peek({
      connectionId: CONNECTION_ID,
      limit: 1,
    })).rejects.toThrow("CATALOG_CHANGE_ROW_INVALID");
  });
});
