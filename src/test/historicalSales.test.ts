import { describe, expect, it, vi } from "vitest";
import { readHistoricalRange, validateHistoricalRange } from "../../supabase/functions/_shared/reconciliation-v2/historicalSales";
import { createWinerimFleetClient } from "../../supabase/functions/_shared/reconciliation-v2/winerimFleetClient";
import { readFileSync } from "node:fs";

const binding = { metadata: { timezone: "Europe/Madrid", businessDayCutoffHour: 6 } };
const now = Date.parse("2026-09-29T02:00:00Z");
const day25 = { historicalRange: true, dryRun: true, from: "2026-09-25T06:00:00+02:00", to: "2026-09-26T06:00:00+02:00", maxPages: 100 };
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const page = (n: number, hasMore: boolean, data: unknown[]) => ({ restaurantId: 346, data, pagination: { page: n, limit: 100, total: 3, totalPages: 2, hasMore } });
const rec = (saleId: number, at: string) => ({ saleId, wine: { wineId: 1 }, lines: [{ lineId: `sale:${saleId}`, format: "botella", qty: 1, totalAmount: 10, effectiveAt: at, lineType: "sale" }] });

describe("sync-sales-records historical range", () => {
  it("rejects dryRun:false / missing dryRun", () => {
    expect(() => validateHistoricalRange({ ...day25, dryRun: false }, binding, now)).toThrow(/dryRun/);
    expect(() => validateHistoricalRange({ ...day25, dryRun: undefined }, binding, now)).toThrow(/dryRun/);
  });
  it("rejects invalid ranges, non-aligned cutoff, > 7 days and bad maxPages", () => {
    expect(() => validateHistoricalRange({ ...day25, from: day25.to, to: day25.from }, binding, now)).toThrow(/anterior/);
    expect(() => validateHistoricalRange({ ...day25, from: "2026-09-25T00:00:00+02:00" }, binding, now)).toThrow(/corte/);
    expect(() => validateHistoricalRange({ ...day25, from: "2026-09-25" }, binding, now)).toThrow(/ISO/);
    expect(() => validateHistoricalRange({ ...day25, from: "2026-09-17T06:00:00+02:00" }, binding, now)).toThrow(/7 días/);
    for (const maxPages of [0, 101, 1.5, "5"]) expect(() => validateHistoricalRange({ ...day25, maxPages }, binding, now)).toThrow(/maxPages/);
  });
  it("accepts the Madrid business day and 7-day ranges using the binding cutoff", () => {
    const r = validateHistoricalRange(day25, binding, now);
    expect(r).toMatchObject({ from: "2026-09-25T04:00:00.000Z", to: "2026-09-26T04:00:00.000Z", businessDays: ["2026-09-25"], maxPages: 100 });
    expect(validateHistoricalRange({ ...day25, from: "2026-09-19T06:00:00+02:00" }, binding, now).businessDays).toHaveLength(7);
    expect(() => validateHistoricalRange({ ...day25, from: "2026-09-25T07:00:00+02:00", to: "2026-09-26T07:00:00+02:00" }, { metadata: { ...binding.metadata, businessDayCutoffHour: 7 } }, now)).not.toThrow();
  });
  it("uses from/to as authority, paginates to the end and never touches cursor/changedSince", async () => {
    const urls: URL[] = [];
    const client = createWinerimFleetClient({ token: "wfk_test", fetchImpl: async (input) => { const u = new URL(String(input)); urls.push(u); return response(u.searchParams.get("page") === "1" ? page(1, true, [rec(1, "2026-09-25T20:00:00"), rec(2, "2026-09-25T13:00:00")]) : page(2, false, [rec(3, "2026-09-26T01:00:00")])); } });
    const { evidence } = await readHistoricalRange(client, 346, validateHistoricalRange(day25, binding, now));
    expect(urls).toHaveLength(2);
    for (const u of urls) { expect(u.searchParams.get("from")).toBe("2026-09-25T04:00:00.000Z"); expect(u.searchParams.get("to")).toBe("2026-09-26T04:00:00.000Z"); expect(u.searchParams.has("cursor")).toBe(false); expect(u.searchParams.has("changedSince")).toBe(false); }
    expect(evidence).toMatchObject({ pagesRead: 2, calls: 2, records: 3, lines: 3, firstTimestamp: "2026-09-25T13:00:00", lastTimestamp: "2026-09-26T01:00:00", paginationEnded: true, coverageComplete: true, deletions: "NOT_AVAILABLE_IN_DATE_MODE", finalCursor: "NOT_AVAILABLE_IN_DATE_MODE" });
  });
  it("reports incomplete coverage when maxPages is exhausted", async () => {
    const salesByDate = vi.fn(async (_r: number, i: { page: number }) => page(i.page, true, [rec(i.page, "2026-09-25T10:00:00")]));
    const { evidence } = await readHistoricalRange({ salesByDate, callCount: 1 } as never, 346, validateHistoricalRange({ ...day25, maxPages: 1 }, binding, now));
    expect(salesByDate).toHaveBeenCalledTimes(1); expect(evidence.coverageComplete).toBe(false); expect(evidence.paginationEnded).toBe(false);
  });
  it("historical branch in the edge function is before checkpoint/claim/commit and returns without them", () => {
    const src = readFileSync("supabase/functions/sync-sales-records/index.ts", "utf8");
    const start = src.indexOf("if (body.historicalRange !== undefined)"); const end = src.indexOf("const dryRun = asDryRun", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const branch = src.slice(start, end);
    expect(branch).toContain("return json(");
    for (const forbidden of ["checkpoint(", "claim(", "rpc(", ".insert(", ".update(", ".upsert(", ".delete(", "salesSync"]) expect(branch).not.toContain(forbidden);
    expect(start).toBeLessThan(src.indexOf("await checkpoint(db"));
  });
});
