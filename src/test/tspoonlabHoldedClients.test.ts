import { describe, expect, it, vi } from "vitest";
import {
  createTspoonlabClient,
  normalizeTspoonlabBaseUrl,
  parseTspoonlabLoginToken,
} from "../../supabase/functions/_shared/tspoonlab/client";
import { createHoldedClient, normalizeHoldedBaseUrl } from "../../supabase/functions/_shared/holded/client";

describe("tSpoonLab client", () => {
  it("normalizes the documented API base URL and requires HTTPS", () => {
    expect(normalizeTspoonlabBaseUrl("https://app.tspoonlab.com")).toBe(
      "https://app.tspoonlab.com/recipes/api",
    );
    expect(normalizeTspoonlabBaseUrl("https://app.tspoonlab.com/recipes/api/")).toBe(
      "https://app.tspoonlab.com/recipes/api",
    );
    expect(() => normalizeTspoonlabBaseUrl("http://app.tspoonlab.com")).toThrow("HTTPS");
  });

  it("accepts plain, prefixed and JSON login tokens", () => {
    expect(parseTspoonlabLoginToken("abc123")).toBe("abc123");
    expect(parseTspoonlabLoginToken("rememberme: abc123")).toBe("abc123");
    expect(parseTspoonlabLoginToken('{"rememberme":"abc123"}')).toBe("abc123");
  });

  it("sends the documented rememberme, order and recipe headers", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("token-1", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "menu-1" }]), { status: 200 }));
    const client = createTspoonlabClient({
      baseUrl: "https://app.tspoonlab.com/recipes/api",
      username: "integration@example.com",
      password: "secret",
      orderCenterId: "order-1",
      recipeCenterId: "recipe-1",
      fetchImpl,
    });

    await client.listMenus({ rows: 25 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, request] = fetchImpl.mock.calls[1];
    const headers = new Headers(request.headers);
    expect(headers.get("rememberme")).toBe("token-1");
    expect(headers.get("order")).toBe("order-1");
    expect(headers.get("recipe")).toBe("recipe-1");
  });
});

describe("Holded client", () => {
  it("normalizes the API base URL and requires HTTPS", () => {
    expect(normalizeHoldedBaseUrl()).toBe("https://api.holded.com/api/v2");
    expect(normalizeHoldedBaseUrl("https://api.holded.com/api/v2/")).toBe("https://api.holded.com/api/v2");
    expect(() => normalizeHoldedBaseUrl("http://api.holded.com/api/v2")).toThrow("HTTPS");
  });

  it("uses Bearer authentication and cursor pagination", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], nextCursor: null }), { status: 200 }),
    );
    const client = createHoldedClient({ apiToken: "holded-token", fetchImpl });

    await client.listInvoices({ cursor: "next-1", limit: 50 });

    const [url, request] = fetchImpl.mock.calls[0];
    const headers = new Headers(request.headers);
    expect(url).toContain("/invoices?cursor=next-1&limit=50");
    expect(headers.get("Authorization")).toBe("Bearer holded-token");
  });
});
