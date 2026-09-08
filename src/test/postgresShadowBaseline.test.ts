import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPostgresShadowClient,
  exportPostgresShadow,
  parseArgs,
  PostgresShadowError,
} from "../../scripts/export-postgres-shadow-baseline.mjs";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PostgreSQL shadow baseline", () => {
  it("requires an explicit rescue target before writing a private artifact", () => {
    expect(parseArgs([
      "--output", "/private/tmp/own.json",
      "--connection-id", CONNECTION_ID,
      "--from-business-day", "2026-08-01",
      "--through-business-day", "2026-08-04",
    ])).toMatchObject({ apply: false, connectionId: CONNECTION_ID });
    expect(() => parseArgs([
      "--output", "/private/tmp/own.json",
      "--connection-id", CONNECTION_ID,
      "--from-business-day", "2026-08-01",
      "--through-business-day", "2026-08-04",
      "--apply",
      "--confirm-target-ref", "wrong",
    ])).toThrowError(expect.objectContaining<Partial<PostgresShadowError>>({ code: "CLI_USAGE" }));
  });

  it("uses only parameterized, connection-scoped queries", async () => {
    const query = vi.fn(async (text: string, values: unknown[]) => ({ rows: [{ id: CONNECTION_ID }] }));
    const client = createPostgresShadowClient({ query } as never);
    await client.fetchAllById({ table: "pos_connections", filters: { id: `eq.${CONNECTION_ID}` } });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE id = $1::uuid"), [CONNECTION_ID]);
    await expect(client.fetchAllById({ table: "provider_credentials", filters: { connection_id: `eq.${CONNECTION_ID}` } }))
      .rejects.toMatchObject({ code: "QUERY_SCOPE" });
  });

  it("preserves PostgreSQL DATE values as local calendar dates", async () => {
    const localMidnight = new Date("2026-08-03T22:00:00.000Z");
    vi.spyOn(localMidnight, "getFullYear").mockReturnValue(2026);
    vi.spyOn(localMidnight, "getMonth").mockReturnValue(7);
    vi.spyOn(localMidnight, "getDate").mockReturnValue(4);
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM public.pos_connections")) {
        return {
          rows: [{
            id: CONNECTION_ID,
            last_business_day_synced: localMidnight,
            last_sync_at: "2026-08-04T10:00:00Z",
            updated_at: "2026-08-04T10:00:00Z",
          }],
        };
      }
      if (text.includes("FROM public.sales_events")) {
        return {
          rows: [{
            id: EVENT_ID,
            provider_doc_id: "invoice-1",
            business_day: localMidnight,
            doc_type: "Invoice",
            created_at: "2026-08-04T10:00:00Z",
          }],
        };
      }
      return { rows: [] };
    });
    const client = createPostgresShadowClient({ query } as never);
    const [connection] = await client.fetchAllById({
      table: "pos_connections",
      filters: { id: `eq.${CONNECTION_ID}` },
    });
    const [event] = await client.fetchAllById({
      table: "sales_events",
      filters: {
        connection_id: `eq.${CONNECTION_ID}`,
        business_day: "gte.2026-08-01",
        and: "(business_day.lte.2026-08-04)",
      },
    });
    expect(connection.last_business_day_synced).toBe("2026-08-04");
    expect(event.business_day).toBe("2026-08-04");
    expect(localMidnight.toISOString().slice(0, 10)).toBe("2026-08-03");
  });

  it("serializes timestamp-without-time-zone sale times as UTC text", async () => {
    const query = vi.fn(async (text: string) => {
      expect(text).toContain(
        "to_char(provider_sold_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS provider_sold_at",
      );
      return {
        rows: [{
          id: "33333333-3333-4333-8333-333333333333",
          sales_event_id: EVENT_ID,
          provider_product_id: "p1",
          provider_sold_at: "2026-08-02T14:23:53.483000Z",
        }],
      };
    });
    const client = createPostgresShadowClient({ query } as never);
    const [line] = await client.fetchAllById({
      table: "sales_line_items",
      filters: {
        connection_id: `eq.${CONNECTION_ID}`,
        sales_event_id: `in.(${EVENT_ID})`,
      },
    });
    expect(line.provider_sold_at).toBe("2026-08-02T14:23:53.483000Z");
  });

  it("captures one repeatable read-only transaction and writes mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "postgres-shadow-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "artifact.json");
    const queries: string[] = [];
    const query = vi.fn(async (text: string) => {
      queries.push(text);
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM public.pos_connections")) {
        return { rows: [{ id: CONNECTION_ID, last_business_day_synced: "2026-08-04", last_sync_at: new Date("2026-08-04T10:00:00.722Z"), updated_at: new Date("2026-08-04T10:00:00.694Z") }] };
      }
      if (text.includes("FROM public.sales_events")) {
        return { rows: [{ id: EVENT_ID, provider_doc_id: "invoice-1", business_day: "2026-08-04", doc_type: "Invoice", created_at: "2026-08-04T10:00:00Z" }] };
      }
      if (text.includes("FROM public.sales_line_items")) {
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333", sales_event_id: EVENT_ID, provider_product_id: "p1", name: "Wine", family: "WINERIM", format: "BOTTLE", quantity: 1, unit_price: 10, total_amount: 10, provider_sold_at: "2026-08-04T10:00:00Z", created_at: "2026-08-04T10:00:00Z", mapped: false, winerim_product_id: null }] };
      }
      if (text.includes("FROM public.stock_sync_log") && !text.includes("sales_event_id IS NULL")) {
        return { rows: [{
          id: "44444444-4444-4444-8444-444444444444",
          sales_event_id: EVENT_ID,
          idempotency_key: null,
          status: "SUCCESS",
          created_at: new Date("2026-08-04T10:01:00.190Z"),
          winerim_response: null,
          stock_id: "4201",
          quantity: "1.000",
          variant: "bottle",
          winerim_product_id: "wine-1",
          provider_product_id: "p1",
          synced_at: new Date("2026-08-04T10:02:00.316Z"),
        }] };
      }
      return { rows: [] };
    });
    const result = await exportPostgresShadow({
      options: parseArgs([
        "--output", output,
        "--connection-id", CONNECTION_ID,
        "--from-business-day", "2026-08-01",
        "--through-business-day", "2026-08-04",
        "--apply",
        "--confirm-target-ref", "piyvadlzagtracciquap",
      ]),
      client: { query } as never,
      now: () => new Date("2026-08-04T10:05:00Z"),
    });
    expect(result).toMatchObject({ result: "POSTGRES_SHADOW_READY", writes: { remote: false } });
    expect(queries[0]).toContain("REPEATABLE READ READ ONLY DEFERRABLE");
    expect(queries.at(-1)).toBe("COMMIT");
    const artifact = JSON.parse(await readFile(output, "utf8"));
    expect(artifact.capture).toMatchObject({ mode: "POSTGRES_REPEATABLE_READ_ONLY", authoritative: true });
    expect(artifact.connections[0].cursor).toMatchObject({
      lastSyncAt: "2026-08-04T10:00:00.722Z",
      updatedAt: "2026-08-04T10:00:00.694Z",
    });
    expect(artifact.connections[0].events[0].lines[0].providerLineId).toMatch(/^content:[a-f0-9]{64}:1$/);
    expect(artifact.connections[0].receipts[0].receiptId).toMatch(/^content:[a-f0-9]{64}:1$/);
    const stockQueries = queries.filter((text) => text.includes("FROM public.stock_sync_log"));
    expect(stockQueries).toHaveLength(2);
    for (const text of stockQueries) {
      expect(text).toContain("stock_id, quantity, variant, winerim_product_id, provider_product_id, synced_at");
    }
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });
});
