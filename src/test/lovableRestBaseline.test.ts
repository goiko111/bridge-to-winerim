import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureConnection,
  createRestClient,
  exportRestBaseline,
  parseArgs,
  RestBaselineError,
} from "../../scripts/export-lovable-rest-baseline.mjs";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const LINE_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const MAPPING_ID = "55555555-5555-4555-8555-555555555555";
const temporaryDirectories: string[] = [];

function jsonResponse(rows: unknown[], status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(rows), { status, headers: { "Content-Type": "application/json", ...headers } });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Lovable REST baseline", () => {
  it("plans a bounded per-connection GET capture without requiring credentials", () => {
    const options = parseArgs([
      "--output-dir", "/encrypted/winerim/baseline",
      "--connection-id", CONNECTION_ID,
      "--from-business-day", "2026-08-01",
      "--through-business-day", "2026-08-04",
      "--passes", "2",
    ]);
    expect(options).toMatchObject({
      apply: false,
      connectionIds: [CONNECTION_ID],
      pageSize: 500,
      minIntervalMs: 500,
      passes: 2,
    });
    expect(() => parseArgs([
      "--output-dir", "/tmp/x",
      "--connection-id", CONNECTION_ID,
      "--from-business-day", "2026-01-01",
      "--through-business-day", "2026-08-04",
    ])).toThrowError(expect.objectContaining<Partial<RestBaselineError>>({ code: "CLI_USAGE" }));
  });

  it("serializes keyset pages and honors Retry-After without leaking the key", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const requests: URL[] = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer private-key");
      if (requests.length === 1) return jsonResponse([], 429, { "Retry-After": "2" });
      if (requests.length === 2) return jsonResponse([{ id: "a" }, { id: "b" }], 200, { "Content-Range": "0-1/3" });
      return jsonResponse([{ id: "c" }], 200, { "Content-Range": "0-0/1" });
    });
    const client = createRestClient({
      baseUrl: "https://source.example",
      apiKey: "private-key",
      pageSize: 2,
      minIntervalMs: 250,
      fetchImpl,
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    });
    const rows = await client.fetchAllById({ table: "sales_events", select: "id", filters: {} });
    expect(rows.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(client.metrics).toMatchObject({ requests: 3, retries: 1, rateLimitRetries: 1, rows: 3 });
    expect(sleeps).toContain(2000);
    expect(requests[2].searchParams.get("id")).toBe("gt.b");
    expect(JSON.stringify({ rows, metrics: client.metrics })).not.toContain("private-key");
  });

  it("continues when PostgREST caps a page below the requested limit", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "a" }], 200, { "Content-Range": "0-0/2" }))
      .mockResolvedValueOnce(jsonResponse([{ id: "b" }], 200, { "Content-Range": "0-0/1" }));
    const client = createRestClient({
      baseUrl: "https://source.example",
      apiKey: "private-key",
      pageSize: 2,
      minIntervalMs: 250,
      fetchImpl,
      nowImpl: () => 1000,
      sleepImpl: async () => undefined,
    });
    await expect(client.fetchAllById({ table: "sales_events", select: "id", filters: {} }))
      .resolves.toEqual([{ id: "a" }, { id: "b" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("builds a sanitized shadow artifact and detects marker drift", async () => {
    let markerReads = 0;
    const tables: Record<string, Record<string, unknown>[]> = {
      pos_connections: [],
      product_mappings: [{
        id: MAPPING_ID,
        provider_product_id: "product-7",
        winerim_wine_id: "wine-7",
        status: "CONFIRMED",
        format_type: "GLASS",
      }],
      sales_events: [{
        id: EVENT_ID,
        provider_doc_id: "invoice-7",
        business_day: "2026-08-04",
        doc_type: "BasicInvoice",
        created_at: "2026-08-04T10:00:00Z",
      }],
      sales_line_items: [{
        id: LINE_ID,
        sales_event_id: EVENT_ID,
        provider_product_id: "product-7",
        name: "Portable Line",
        family: "WINERIM",
        format: "GLASS",
        quantity: "2.000",
        unit_price: "7.50",
        total_amount: "15.00",
        provider_sold_at: "2026-08-04T12:00:00",
        created_at: "2026-08-04T10:00:00Z",
        mapped: true,
        winerim_product_id: "wine-7",
      }],
      stock_sync_log: [{
        id: RECEIPT_ID,
        sales_event_id: EVENT_ID,
        idempotency_key: "stock:invoice-7:glass",
        status: "SUCCESS",
        created_at: "2026-08-04T10:01:00Z",
        stock_id: "4201",
        quantity: "2.000",
        variant: "glass",
        winerim_product_id: "wine-7",
        provider_product_id: "product-7",
        synced_at: "2026-08-04T10:02:00Z",
        winerim_response: {
          businessDay: "2026-08-04",
          salesImport: { orderId: "order-7", live: true, stockApplied: true },
        },
      }],
    };
    const client = {
      metrics: { requests: 0, retries: 0, rateLimitRetries: 0, rows: 0 },
      fetchAllById: vi.fn(async ({ table, filters }: { table: string; filters: Record<string, string> }) => {
        client.metrics.requests += 1;
        if (table === "pos_connections") {
          markerReads += 1;
          return [{
            id: CONNECTION_ID,
            last_business_day_synced: "2026-08-04",
            last_sync_at: "2026-08-04T10:00:00Z",
            updated_at: markerReads === 1 ? "2026-08-04T10:00:00Z" : "2026-08-04T10:02:00Z",
          }];
        }
        if (table === "stock_sync_log" && filters.sales_event_id === "is.null") return [];
        return tables[table] || [];
      }),
    };
    const result = await captureConnection({
      client,
      connectionId: CONNECTION_ID,
      fromBusinessDay: "2026-08-04",
      throughBusinessDay: "2026-08-04",
      now: () => new Date("2026-08-04T10:03:00Z"),
    });
    expect(result.artifact.capture).toMatchObject({
      mode: "OBSERVATIONAL_READ_ONLY",
      authoritative: false,
      sourceMarkerStable: false,
    });
    expect(result.summary).toMatchObject({ events: 1, lines: 1, receipts: 1, mappings: 1 });
    const connection = result.artifact.connections[0];
    expect(connection.events[0].lines[0]).toMatchObject({
      providerLineId: expect.stringMatching(/^content:[a-f0-9]{64}:1$/),
      providerProductId: "product-7",
      format: "GLASS",
      qty: "2",
      mapping: { mapped: true, status: "CONFIRMED", winerimProductId: "wine-7" },
    });
    expect(connection.events[0]).not.toHaveProperty("orderId");
    expect(connection.receipts[0]).toMatchObject({
      orderId: "order-7",
      live: true,
      stockApplied: true,
    });
    expect(client.fetchAllById).toHaveBeenCalledWith(expect.objectContaining({
      table: "stock_sync_log",
      select: expect.stringContaining("stock_id,quantity,variant,winerim_product_id,provider_product_id,synced_at"),
    }));
    expect(JSON.stringify(result.artifact)).not.toMatch(/api.?token|authorization|private-key/i);
  });

  it("uses stable complete stock material for synthetic receipt fingerprints", async () => {
    const marker = {
      id: CONNECTION_ID,
      last_business_day_synced: "2026-08-04",
      last_sync_at: "2026-08-04T10:00:00Z",
      updated_at: "2026-08-04T10:00:00Z",
    };
    const baseReceipt = {
      id: RECEIPT_ID,
      sales_event_id: null,
      idempotency_key: null,
      status: "SUCCESS",
      created_at: "2026-08-04T10:01:00Z",
      winerim_response: null,
      stock_id: "4201",
      quantity: "2.000",
      variant: "bottle",
      winerim_product_id: "wine-7",
      provider_product_id: "product-7",
      synced_at: "2026-08-04T12:02:00+02:00",
    };
    const captureReceipt = async (receipt: Record<string, unknown>) => {
      const client = {
        metrics: { requests: 0, retries: 0, rateLimitRetries: 0, rows: 0 },
        fetchAllById: vi.fn(async ({ table }: { table: string }) => {
          if (table === "pos_connections") return [marker];
          if (table === "stock_sync_log") return [receipt];
          return [];
        }),
      };
      const captured = await captureConnection({
        client,
        connectionId: CONNECTION_ID,
        fromBusinessDay: "2026-08-04",
        throughBusinessDay: "2026-08-04",
        now: () => new Date("2026-08-04T10:03:00Z"),
      });
      return captured.artifact.connections[0].receipts[0];
    };

    const baseline = await captureReceipt(baseReceipt);
    const equivalent = await captureReceipt({
      ...baseReceipt,
      stock_id: 4201,
      quantity: 2,
      variant: "BOTTLE",
      synced_at: "2026-08-04T10:02:00Z",
    });
    expect(equivalent).toMatchObject({
      receiptId: baseline.receiptId,
      payloadSha256: baseline.payloadSha256,
    });

    const adversarial = await Promise.all([
      captureReceipt({ ...baseReceipt, stock_id: "4202" }),
      captureReceipt({ ...baseReceipt, quantity: "3.000" }),
      captureReceipt({ ...baseReceipt, variant: "glass" }),
      captureReceipt({ ...baseReceipt, winerim_product_id: "wine-8" }),
      captureReceipt({ ...baseReceipt, provider_product_id: "product-8" }),
      captureReceipt({ ...baseReceipt, synced_at: "2026-08-04T10:02:01Z" }),
    ]);
    expect(new Set([baseline, ...adversarial].map(({ receiptId }) => receiptId)).size).toBe(7);
    expect(new Set([baseline, ...adversarial].map(({ payloadSha256 }) => payloadSha256)).size).toBe(7);

    const keyedBaseline = await captureReceipt({ ...baseReceipt, idempotency_key: "stock:fixed" });
    const keyedMutation = await captureReceipt({
      ...baseReceipt,
      idempotency_key: "stock:fixed",
      stock_id: "4202",
    });
    expect(keyedMutation.receiptId).toBe(keyedBaseline.receiptId);
    expect(keyedMutation.payloadSha256).not.toBe(keyedBaseline.payloadSha256);
  });

  it("writes private per-connection passes and never marks REST as merge eligible", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rest-baseline-test-"));
    temporaryDirectories.push(parent);
    const outputDir = join(parent, "artifact");
    const marker = {
      id: CONNECTION_ID,
      last_business_day_synced: "2026-08-04",
      last_sync_at: "2026-08-04T10:00:00Z",
      updated_at: "2026-08-04T10:00:00Z",
    };
    const client = {
      metrics: { requests: 0, retries: 0, rateLimitRetries: 0, rows: 0 },
      fetchAllById: vi.fn(async ({ table }: { table: string }) => {
        client.metrics.requests += 1;
        return table === "pos_connections" ? [marker] : [];
      }),
    };
    const options = parseArgs([
      "--output-dir", outputDir,
      "--connection-id", CONNECTION_ID,
      "--from-business-day", "2026-08-04",
      "--through-business-day", "2026-08-04",
      "--passes", "2",
      "--pass-delay-ms", "0",
      "--confirm-source", "lovable-production",
      "--apply",
    ]);
    const result = await exportRestBaseline({ options, client, now: () => new Date("2026-08-04T10:00:00Z") });
    expect(result).toMatchObject({ result: "REST_BASELINE_OBSERVATIONAL_READY", connections: 1, passes: 2 });
    const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8"));
    expect(manifest.consistency).toMatchObject({
      authoritative: false,
      safeDuringService: true,
      blockedForRestoreMergeOrCursorAdvance: true,
    });
    expect(manifest.connections[0]).toMatchObject({ identicalSemanticPasses: true, mergeEligible: false });
    expect((await stat(join(outputDir, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(outputDir, "connections", CONNECTION_ID))).mode & 0o777).toBe(0o700);
  });
});
