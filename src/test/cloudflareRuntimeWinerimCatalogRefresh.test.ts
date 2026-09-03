import { describe, expect, it, vi } from "vitest";

import type { DatabaseAdapter } from "../../cloudflare/workers/middleware-api/src/db";
import {
  createWinerimCatalogRefreshPort,
  WINERIM_CATALOG_MAX_RESPONSE_BYTES,
  WINERIM_CATALOG_REFRESH_TIMEOUT_MS,
} from "../../cloudflare/workers/middleware-runtime-executor/src/winerimCatalogRefresh";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function database(): { adapter: DatabaseAdapter; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows: [{ changed: 1, retired: 0 }], rowCount: 1 }));
  return {
    query,
    adapter: {
      query,
      transaction: async (work) => work({ query }),
    },
  };
}

describe("full Winerim catalog refresh", () => {
  it("allows a full restaurant catalog enough time and response capacity", async () => {
    const scheduled: number[] = [];
    const request = vi.fn(async (url: string) => new URL(url).pathname.endsWith("/wines")
      ? response({
        success: true,
        pagination: { total_pages: 1 },
        wines: [{ id: 12, name: "Wine A" }],
      })
      : response({
        success: true,
        wines: [{ id: 12, name: "Wine A", prices: [{ variant: "botella", price: 24 }] }],
      }));
    const refresh = createWinerimCatalogRefreshPort({
      database: database().adapter,
      baseUrl: "https://app.winerim.test",
      allowedHosts: ["app.winerim.test"],
      request: { request },
      timer: {
        now: () => 1,
        schedule: (_callback, milliseconds) => {
          scheduled.push(milliseconds);
          return scheduled.length;
        },
        cancel: () => undefined,
      },
    });

    await expect(refresh.refresh({
      connectionId: CONNECTION_ID,
      messageId: "message-capacity",
      idempotencyKey: "catalog-refresh-capacity",
      dryRun: true,
      credential: { read: async () => "secret" },
    })).resolves.toEqual({ ok: true, outcome: "complete", changed: 0 });

    expect(scheduled).toEqual([
      WINERIM_CATALOG_REFRESH_TIMEOUT_MS,
      WINERIM_CATALOG_REFRESH_TIMEOUT_MS,
    ]);
    expect(WINERIM_CATALOG_REFRESH_TIMEOUT_MS).toBe(30_000);
    expect(WINERIM_CATALOG_MAX_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
  });

  it("paginates, resolves complete bulk details and persists stock activity in raw payload", async () => {
    const db = database();
    const request = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/wines")) {
        return response({
          success: true,
          pagination: { total_pages: 1 },
          wines: [{ id: 12, name: "Wine A", type: "tinto" }],
        });
      }
      return response({
        success: true,
        wines: [{
          id: 12,
          name: "Wine A",
          type: "tinto",
          active: true,
          prices: [{
            variant: "botella",
            price: "24.5",
            erpStock: { id: 90, stock: 3, stockActive: true },
          }],
        }],
      });
    });
    const refresh = createWinerimCatalogRefreshPort({
      database: db.adapter,
      baseUrl: "https://app.winerim.test",
      allowedHosts: ["app.winerim.test"],
      request: { request },
      timer: {
        now: () => 1,
        schedule: () => 1,
        cancel: () => undefined,
      },
    });

    await expect(refresh.refresh({
      connectionId: CONNECTION_ID,
      messageId: "message-1",
      idempotencyKey: "catalog-refresh-1",
      dryRun: false,
      credential: { read: async () => "secret" },
    })).resolves.toEqual({ ok: true, outcome: "complete", changed: 1 });

    expect(request).toHaveBeenCalledTimes(2);
    const statement = db.query.mock.calls[0][0];
    expect(statement.text).toContain("ON CONFLICT (connection_id, winerim_id) DO UPDATE");
    expect(statement.text).toContain("pricing_missing_reason = 'deleted_in_winerim'");
    const payload = JSON.parse(statement.values[0]);
    expect(payload[0]).toMatchObject({
      winerim_id: "12",
      bottle_sale_price: 24.5,
      pricing_status: "READY",
      serve_by_glass: false,
      raw_payload: {
        prices: [{ erpStock: { id: 90, stock: 3, stockActive: true } }],
      },
    });
  });

  it("fails closed when bulk omits a listed wine and performs no database write", async () => {
    const db = database();
    const request = vi.fn(async (url: string) => new URL(url).pathname.endsWith("/wines")
      ? response({
        success: true,
        pagination: { total_pages: 1 },
        wines: [{ id: 12, name: "Wine A" }, { id: 13, name: "Wine B" }],
      })
      : response({ success: true, wines: [{ id: 12, name: "Wine A", prices: [] }] }));
    const refresh = createWinerimCatalogRefreshPort({
      database: db.adapter,
      baseUrl: "https://app.winerim.test",
      allowedHosts: ["app.winerim.test"],
      request: { request },
      timer: { now: () => 1, schedule: () => 1, cancel: () => undefined },
    });

    await expect(refresh.refresh({
      connectionId: CONNECTION_ID,
      messageId: "message-2",
      idempotencyKey: "catalog-refresh-2",
      dryRun: false,
      credential: { read: async () => "secret" },
    })).resolves.toEqual({
      ok: false,
      httpStatus: 503,
      message: "WINERIM_CATALOG_INCOMPLETE_BULK",
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("preserves a failed bulk status and route without writing the database", async () => {
    const db = database();
    const request = vi.fn(async (url: string) => new URL(url).pathname.endsWith("/wines")
      ? response({
        success: true,
        pagination: { total_pages: 1 },
        wines: [{ id: 12, name: "Wine A" }],
      })
      : errorResponse(429, { error: "rate limited" }));
    const refresh = createWinerimCatalogRefreshPort({
      database: db.adapter,
      baseUrl: "https://app.winerim.test",
      allowedHosts: ["app.winerim.test"],
      request: { request },
      timer: { now: () => 1, schedule: () => 1, cancel: () => undefined },
    });

    await expect(refresh.refresh({
      connectionId: CONNECTION_ID,
      messageId: "message-429",
      idempotencyKey: "catalog-refresh-429",
      dryRun: false,
      credential: { read: async () => "secret" },
    })).resolves.toEqual({
      ok: false,
      httpStatus: 429,
      message: "WINERIM_CATALOG_BULK_FAILED",
      diagnostic: {
        operation: "winerim.catalog-bulk",
        route: "/api/v2/wines/bulk",
        httpStatus: 429,
        errorCode: "WINERIM_CATALOG_BULK_FAILED_OFFSET_0",
      },
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("preserves timeout evidence without credential or response body", async () => {
    const db = database();
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal?.aborted).toBe(true);
      throw new DOMException("Authorization: Bearer sensitive-token", "AbortError");
    });
    const refresh = createWinerimCatalogRefreshPort({
      database: db.adapter,
      baseUrl: "https://app.winerim.test",
      allowedHosts: ["app.winerim.test"],
      request: { request },
      timer: {
        now: () => 10,
        schedule: (callback) => {
          callback();
          return 1;
        },
        cancel: () => undefined,
      },
    });

    const result = await refresh.refresh({
      connectionId: CONNECTION_ID,
      messageId: "message-timeout",
      idempotencyKey: "catalog-refresh-timeout",
      dryRun: false,
      credential: { read: async () => "secret" },
    });

    expect(result).toEqual({
      ok: false,
      httpStatus: 503,
      message: "HTTP_TIMEOUT",
      diagnostic: {
        operation: "winerim.catalog-list",
        route: "/api/v2/wines?page=1&limit=100",
        httpStatus: undefined,
        elapsedMs: 0,
        errorCode: "HTTP_TIMEOUT",
      },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-token");
    expect(db.query).not.toHaveBeenCalled();
  });
});
