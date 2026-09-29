import { describe, expect, it } from "vitest";
import * as now from "../../supabase/functions/_shared/reconciliation-v2/agoraReader";
import * as legacy from "./fixtures/agoraReaderLegacy";
import type { AgoraDbLine } from "../../supabase/functions/_shared/reconciliation-v2/agoraReader";

// Deterministic PRNG so fixtures are reproducible.
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

function build(events: number, linesPerEvent: number, seed = 7): AgoraDbLine[] {
  const r = rng(seed); const out: AgoraDbLine[] = [];
  for (let e = 0; e < events; e += 1) {
    const soldBase = Date.UTC(2026, 8, 27, 10, 0, 0) + e * 60_000;
    const rawLinesArr = Array.from({ length: linesPerEvent }, (_, i) => {
      const pid = String(100 + Math.floor(r() * 6)); const qty = 1 + Math.floor(r() * 2); const price = 5 + Math.floor(r() * 3);
      const soldAt = new Date(soldBase + Math.floor(r() * 3) * 1000).toISOString();
      return { lineId: r() < 0.2 ? undefined : `L${e}-${i}`, index: i, providerProductId: pid, quantity: qty, totalAmount: qty * price, unitPrice: price, soldAt, productName: `Vino ${pid}` };
    });
    const invoiceItems = r() < 0.3 ? [{ globalId: `G${e}`, lines: rawLinesArr.slice(0, 2).map((l) => ({ ...l, lineId: undefined })) }] : [];
    const raw = { documentId: `D${e}`, lifecycleId: r() < 0.5 ? `LC${e}` : undefined, globalId: `G${e}`, lines: rawLinesArr, invoiceItems };
    const event = { provider_doc_id: `P${e}`, business_day: "2026-09-27", doc_type: r() < 0.1 ? "BasicRefund" : "BasicInvoice", raw_json: raw };
    for (const l of [...rawLinesArr, ...(r() < 0.2 ? [{ ...rawLinesArr[0], quantity: 9 }] : [])]) {
      out.push({ id: `${e}-${out.length}`, connection_id: "c", provider_product_id: l.providerProductId, provider_sold_at: l.soldAt, format: "BOTTLE", quantity: l.quantity, total_amount: l.totalAmount, winerim_product_id: r() < 0.8 ? "W1" : null, mapped: true, name: l.productName, sales_event: event });
    }
  }
  return out;
}

describe("agoraReader per-event index equivalence", () => {
  it("matches the legacy full scan on deterministic fixtures (identity, amount, resolution)", () => {
    const rows = build(400, 8);
    for (const row of rows) {
      expect(now.agoraProviderIdentity(row)).toBe(legacy.agoraProviderIdentity(row));
      expect(now.agoraProviderAmount(row)).toBe(legacy.agoraProviderAmount(row));
      expect(now.resolveAgoraIdentity(row, 861)).toEqual(legacy.resolveAgoraIdentity(row, 861));
    }
  });
  it("keeps RAW_LINES_MISSING / NOT_FOUND / AMBIGUOUS classification", () => {
    const event = { provider_doc_id: "X", business_day: "2026-09-27", doc_type: "BasicInvoice", raw_json: { lines: [
      { providerProductId: "1", quantity: 1, totalAmount: 5, soldAt: "2026-09-27T10:00:00Z", lineId: "a" },
      { providerProductId: "1", quantity: 1, totalAmount: 5, soldAt: "2026-09-27T10:00:00Z", lineId: "b" } ] } };
    const base = { id: "1", connection_id: "c", provider_product_id: "1", provider_sold_at: "2026-09-27T10:00:00Z", format: "BOTTLE", quantity: 1, total_amount: 5, winerim_product_id: "W", mapped: true };
    expect(now.resolveAgoraIdentity({ ...base, sales_event: event }, 1).missing).toContain("RAW_LINE_AMBIGUOUS");
    expect(now.resolveAgoraIdentity({ ...base, quantity: 3, sales_event: event }, 1).missing).toContain("RAW_LINE_NOT_FOUND");
    expect(now.resolveAgoraIdentity({ ...base, sales_event: { ...event, raw_json: {} } }, 1).missing).toContain("RAW_LINES_MISSING");
  });
  it("handles ~80k synthetic lines within a bounded budget", () => {
    const rows = build(1000, 80, 11); expect(rows.length).toBeGreaterThanOrEqual(80_000);
    const t0 = performance.now(); let resolved = 0;
    for (const row of rows) { if (now.agoraProviderIdentity(row)) resolved += 1; now.agoraProviderAmount(row); now.resolveAgoraIdentity(row, 861); }
    const elapsed = performance.now() - t0;
    expect(resolved).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(4000);
  });
});
