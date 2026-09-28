import { describe, expect, it } from "vitest";
import { createWinerimFleetClient, FleetContractError } from "../../supabase/functions/_shared/reconciliation-v2/winerimFleetClient";

const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("Winerim fleet client", () => {
  it("requires a fleet token and only emits the fixed /api/v2/sales/records route", async () => {
    expect(() => createWinerimFleetClient({ token: "restaurant-token" })).toThrow(FleetContractError);
    const urls: string[] = []; const client = createWinerimFleetClient({ token: "wfk_test", fetchImpl: async (input) => { urls.push(String(input)); return response({ restaurantId: 9, data: [], deletions: [], sync: { nextCursor: "c", hasMore: false } }); } });
    await client.salesSync(9, { changedSince: new Date(Date.now() - 60_000).toISOString() });
    expect(new URL(urls[0]).pathname).toBe("/api/v2/sales/records"); expect(urls[0]).not.toContain("path=");
  });

  it("stops on auth errors and bounds retries", async () => {
    let calls = 0; const denied = createWinerimFleetClient({ token: "wfk_test", fetchImpl: async () => { calls += 1; return response({}, 401); }, sleep: async () => {} });
    await expect(denied.restaurants()).rejects.toMatchObject({ code: "HTTP_401" }); expect(calls).toBe(1);
    calls = 0; const busy = createWinerimFleetClient({ token: "wfk_test", fetchImpl: async () => { calls += 1; return response({}, 503); }, sleep: async () => {} });
    await expect(busy.restaurants()).rejects.toMatchObject({ code: "HTTP_503" }); expect(calls).toBe(3);
  });

  it("rejects restaurant mismatch and validates the provisional stock contract", async () => {
    const mismatch = createWinerimFleetClient({ token: "wfk_test", fetchImpl: async () => response({ restaurantId: 8, data: [], deletions: [], sync: { nextCursor: "x", hasMore: false } }) });
    await expect(mismatch.salesSync(9, { changedSince: new Date(Date.now() - 60_000).toISOString() })).rejects.toMatchObject({ code: "RESTAURANT_MISMATCH" });
    const stock = createWinerimFleetClient({ token: "wfk_test", fetchImpl: async () => response({ success: true, pagination: { page: 1, limit: 100, total_count: 0, total_pages: 1 }, stocks: [] }) });
    await expect(stock.stock(9)).resolves.toMatchObject({ success: true, stocks: [] });
  });
});
