import { describe, expect, it, vi } from "vitest";

import {
  createWinerimCatalogClient,
  HttpAdapterError,
  type HttpAdapterLogEvent,
  type HttpTimerPort,
  WinerimCatalogError,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/http";

function timer(): HttpTimerPort {
  let now = 1_000;
  return {
    now: () => now++,
    schedule: vi.fn(() => Symbol("timer")),
    cancel: vi.fn(),
  };
}

function timeoutTimer(): HttpTimerPort {
  return {
    now: () => 1_000,
    schedule: vi.fn((callback) => {
      queueMicrotask(callback);
      return Symbol("timer");
    }),
    cancel: vi.fn(),
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 855797,
    name: "Canary wine",
    vintage: 2024,
    type: "Tinto",
    prices: [{ variant: "botella", price: "13.50" }],
    bottle_purchase_price: 5,
    ...overrides,
  };
}

describe("Winerim single-wine catalog adapter", () => {
  it("posts exactly one numeric ID and returns a minimal fingerprinted variant snapshot", async () => {
    const logs: HttpAdapterLogEvent[] = [];
    const request = vi.fn().mockResolvedValue(response({
      success: true,
      token: "echoed-secret",
      wines: [wine()],
    }));
    const client = createWinerimCatalogClient({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential-secret" },
      request: { request },
      timer: timer(),
      logger: { write: (event) => { logs.push(event); } },
    });

    const result = await client.fetchOne({ winerimWineId: "855797", format: "BOTTLE" });

    expect(result).toEqual({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      wine: {
        winerimId: "855797",
        name: "Canary wine",
        vintage: "2024",
        wineType: "tinto",
        active: true,
        variant: { format: "BOTTLE", salePrice: 13.5, costPrice: 5, enabled: true },
      },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe("https://winerim.example.test/api/v2/wines/bulk");
    expect(request.mock.calls[0][1]).toMatchObject({
      method: "POST",
      redirect: "manual",
      body: JSON.stringify({ ids: [855797] }),
      headers: expect.objectContaining({ "WINERIM-API-TOKEN": "credential-secret" }),
    });
    expect(JSON.stringify(logs)).not.toContain("credential-secret");
    expect(JSON.stringify(logs)).not.toContain("echoed-secret");
  });

  it("fingerprints only the normalized target snapshot, not unknown or sensitive response fields", async () => {
    const first = createWinerimCatalogClient({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request: vi.fn().mockResolvedValue(response({ success: true, wines: [wine({ token: "one", ignored: 1 })] })) },
      timer: timer(),
    });
    const second = createWinerimCatalogClient({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request: vi.fn().mockResolvedValue(response({ wines: [wine({ ignored: 2, token: "two" })], success: true })) },
      timer: timer(),
    });

    const left = await first.fetchOne({ winerimWineId: "855797", format: "BOTTLE" });
    const right = await second.fetchOne({ winerimWineId: "855797", format: "BOTTLE" });
    expect(left.fingerprint).toBe(right.fingerprint);
    expect(JSON.stringify(left)).not.toContain("one");
    expect(JSON.stringify(right)).not.toContain("two");
  });

  it("rejects malformed targets before credential or HTTP access", async () => {
    const request = vi.fn();
    const credential = { read: vi.fn() };
    const client = createWinerimCatalogClient({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential,
      request: { request },
      timer: timer(),
    });

    await expect(client.fetchOne({ winerimWineId: "1,2", format: "BOTTLE" }))
      .rejects.toMatchObject<WinerimCatalogError>({ code: "WINERIM_CATALOG_INVALID_TARGET" });
    expect(credential.read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed for missing, extra, mismatched or duplicate target variants", async () => {
    const cases: Array<{ body: unknown; code: string }> = [
      { body: { success: true, wines: [] }, code: "WINERIM_CATALOG_WINE_NOT_FOUND" },
      { body: { success: true, wines: [wine(), wine()] }, code: "WINERIM_CATALOG_AMBIGUOUS_RESPONSE" },
      { body: { success: true, wines: [wine({ id: 855798 })] }, code: "WINERIM_CATALOG_INVALID_RESPONSE" },
      {
        body: { success: true, wines: [wine({ prices: [{ variant: "botella", price: 13 }, { variant: "bottle", price: 13 }] })] },
        code: "WINERIM_CATALOG_AMBIGUOUS_RESPONSE",
      },
      {
        body: { success: true, wines: [wine({ prices: [{ variant: "copa", price: 3 }], bottle_purchase_price: null })] },
        code: "WINERIM_CATALOG_VARIANT_NOT_FOUND",
      },
    ];

    for (const testCase of cases) {
      const client = createWinerimCatalogClient({
        baseUrl: "https://winerim.example.test",
        allowedHosts: ["winerim.example.test"],
        credential: { read: () => "credential" },
        request: { request: vi.fn().mockResolvedValue(response(testCase.body)) },
        timer: timer(),
      });
      await expect(client.fetchOne({ winerimWineId: "855797", format: "BOTTLE" }))
        .rejects.toMatchObject<WinerimCatalogError>({ code: testCase.code });
    }
  });

  it("keeps the hard timeout active through the bulk response", async () => {
    const request = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("Bearer must-not-leak")));
    }));
    const client = createWinerimCatalogClient({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request },
      timer: timeoutTimer(),
      timeoutMs: 10,
    });

    await expect(client.fetchOne({ winerimWineId: "855797", format: "BOTTLE" }))
      .rejects.toMatchObject<HttpAdapterError>({ code: "HTTP_TIMEOUT" });
  });
});
