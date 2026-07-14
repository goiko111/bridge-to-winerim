import { describe, expect, it, vi } from "vitest";
import {
  createYurestClient,
  normalizeYurestBaseUrl,
  YurestHttpError,
} from "../../supabase/functions/_shared/yurest/client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch) {
  return createYurestClient({
    email: "integration@example.com",
    password: "secret",
    providerToken: "provider-token",
    storeId: 2054,
    fetchImpl,
  });
}

describe("Yurest V2 client", () => {
  it("normalizes the official base URL and requires HTTPS", () => {
    expect(normalizeYurestBaseUrl()).toBe("https://cliente.yurest.com/ws");
    expect(normalizeYurestBaseUrl("https://cliente.yurest.com/")).toBe("https://cliente.yurest.com/ws");
    expect(normalizeYurestBaseUrl("https://cliente.yurest.com/ws/")).toBe("https://cliente.yurest.com/ws");
    expect(() => normalizeYurestBaseUrl("http://cliente.yurest.com/ws")).toThrow("HTTPS");
  });

  it("logs in with the provider token and reuses the Bearer token", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { access_token: "bearer-1" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { items: [], pagination: {} } }))
      .mockResolvedValueOnce(jsonResponse({ data: { items: [], pagination: {} } }));
    const yurest = client(fetchImpl as typeof fetch);

    await yurest.listWarehouseLocations();
    await yurest.listInventories();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [, loginRequest] = fetchImpl.mock.calls[0];
    expect(new Headers(loginRequest.headers).get("X-Provider-Token")).toBe("provider-token");
    expect(JSON.parse(String(loginRequest.body))).toEqual({ email: "integration@example.com", password: "secret" });

    const [locationsUrl, locationsRequest] = fetchImpl.mock.calls[1];
    const headers = new Headers(locationsRequest.headers);
    expect(locationsUrl).toContain("store_id=2054");
    expect(headers.get("Authorization")).toBe("Bearer bearer-1");
    expect(headers.get("X-Provider-Token")).toBe("provider-token");
  });

  it("re-authenticates once when a Bearer token expires", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { access_token: "bearer-old" } }))
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthenticated" }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: { access_token: "bearer-new" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { items: [], pagination: {} } }));
    const yurest = client(fetchImpl as typeof fetch);

    await yurest.listProviders();

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const [, retriedRequest] = fetchImpl.mock.calls[3];
    expect(new Headers(retriedRequest.headers).get("Authorization")).toBe("Bearer bearer-new");
  });

  it("filters product costs to the configured store and removes other stores", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { access_token: "bearer-1" } }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          items: [
            { product_id: 1, product_name: "Wine A", stores: [{ store_id: 2054, cost: 10 }, { store_id: 9999, cost: 12 }] },
            { product_id: 2, product_name: "Wine B", stores: [{ store_id: 9999, cost: 8 }] },
          ],
          pagination: { page: 1, last_page: 1, total: 2 },
        },
      }));
    const yurest = client(fetchImpl as typeof fetch);

    const result = await yurest.listAllProductCostsForStore();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].product_id).toBe(1);
    expect(result.items[0].stores).toEqual([{ store_id: 2054, cost: 10 }]);
  });

  it("rejects inventory detail from a different store", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { access_token: "bearer-1" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 10, store: { id: 9999 } } }));
    const yurest = client(fetchImpl as typeof fetch);

    await expect(yurest.getInventory(10)).rejects.toBeInstanceOf(YurestHttpError);
  });
});
