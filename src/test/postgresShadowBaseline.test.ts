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

  it("captures one repeatable read-only transaction and writes mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "postgres-shadow-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "artifact.json");
    const queries: string[] = [];
    const query = vi.fn(async (text: string) => {
      queries.push(text);
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM public.pos_connections")) {
        return { rows: [{ id: CONNECTION_ID, last_business_day_synced: "2026-08-04", last_sync_at: "2026-08-04T10:00:00Z", updated_at: "2026-08-04T10:00:00Z" }] };
      }
      if (text.includes("FROM public.sales_events")) {
        return { rows: [{ id: EVENT_ID, provider_doc_id: "invoice-1", business_day: "2026-08-04", doc_type: "Invoice", created_at: "2026-08-04T10:00:00Z" }] };
      }
      if (text.includes("FROM public.sales_line_items")) {
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333", sales_event_id: EVENT_ID, provider_product_id: "p1", name: "Wine", family: "WINERIM", format: "BOTTLE", quantity: 1, unit_price: 10, total_amount: 10, provider_sold_at: "2026-08-04T10:00:00Z", created_at: "2026-08-04T10:00:00Z", mapped: false, winerim_product_id: null }] };
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
    expect(artifact.connections[0].events[0].lines[0].providerLineId).toMatch(/^content:[a-f0-9]{64}:1$/);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });
});
