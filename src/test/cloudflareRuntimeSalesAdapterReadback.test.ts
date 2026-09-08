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

describe("PostgreSQL sales adapter readback", () => {
  it("reads events and lines in one repeatable read-only snapshot", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("FROM public.sales_events")) {
        return result([{
          id: EVENT_ID,
          connection_id: CONNECTION_ID,
          provider_doc_id: "invoice:inv-100",
          business_day: "2026-07-29",
          doc_type: "BasicInvoice",
          line_count: 1,
          total_amount: "29.00",
          raw_json: { documentId: "invoice:inv-100" },
          created_at: "2026-07-29T13:05:00Z",
        }]);
      }
      if (statement.text.includes("FROM public.sales_line_items")) {
        return result([{
          id: "line-db-1",
          sales_event_id: EVENT_ID,
          provider_product_id: "547593",
          name: "B Vi de Glass",
          format: "BOTTLE",
          quantity: "1",
          unit_price: "29",
          total_amount: "29",
          mapped: true,
          winerim_product_id: "47593",
          provider_sold_at: "2026-07-29T13:04:00",
        }]);
      }
      return result();
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    const readback = await adapter.readDocuments({
      fromBusinessDay: "2026-07-29",
      toBusinessDay: "2026-07-29",
      providerDocumentIds: ["invoice:inv-100"],
      limit: 10,
    });

    expect(readback.events[0]).toMatchObject({
      providerDocumentId: "invoice:inv-100",
      lineCount: 1,
      totalAmount: 29,
    });
    expect(readback.lines[0]).toMatchObject({
      providerProductId: "547593",
      mapped: true,
      winerimProductId: "47593",
    });
    expect(fake.transactionOptions).toEqual([{ isolationLevel: "repeatable-read", readOnly: true }]);
    expect(fake.statements[0].text).not.toContain("invoice:inv-100");
    expect(fake.statements[0].values).toEqual([
      CONNECTION_ID,
      "2026-07-29",
      "2026-07-29",
      "2026-07-29",
      "2026-07-29",
      ["invoice:inv-100"],
      ["invoice:inv-100"],
      10,
    ]);
    expect(fake.statements[1].values).toEqual([CONNECTION_ID, [EVENT_ID]]);
  });

  it("returns a non-executable cursor plan and never queries the database", () => {
    const fake = fakeDatabase(() => {
      throw new Error("cursor planning must not query the database");
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    const plan = adapter.planCursorAdvance({
      throughBusinessDay: "2026-07-29",
      reason: "readback reconciled",
    });

    expect(plan).toMatchObject({
      kind: "SALES_CURSOR_ADVANCE",
      executable: false,
      connectionId: CONNECTION_ID,
      throughBusinessDay: "2026-07-29",
    });
    expect(plan.statement.text).toContain("last_business_day_synced");
    expect(plan.statement.values).toEqual([CONNECTION_ID, "2026-07-29"]);
    expect(fake.database.query).not.toHaveBeenCalled();
    expect(fake.database.transaction).not.toHaveBeenCalled();
  });
});
