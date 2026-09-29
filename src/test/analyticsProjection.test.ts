import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agoraProviderAmount, agoraProviderIdentity, type AgoraDbLine } from "../../supabase/functions/_shared/reconciliation-v2/agoraReader.ts";

// JS mirror of public.reconciliation_v2_project_raw (migration 2026-09-29 analytics projection).
type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === "object" && !Array.isArray(v);
const strip = (o: J) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const LINE_KEYS = ["providerProductId", "ProductId", "quantity", "Quantity", "totalAmount", "TotalAmount", "unitPrice", "UnitPrice", "productPrice", "ProductPrice", "soldAt", "CreationDate", "productName", "ProductName", "lineId", "LineId", "index", "Index"];
const pLine = (l: J) => strip(Object.fromEntries(LINE_KEYS.map((k) => [k, l[k]])));
const pLines = (a: unknown) => Array.isArray(a) ? a.filter(isObj).map(pLine) : null;
const pItems = (a: unknown) => Array.isArray(a) ? a.filter(isObj).map((e) => strip({ globalId: e.globalId, GlobalId: e.GlobalId, lines: pLines(e.lines), Lines: pLines(e.Lines) })) : null;
export function projectRaw(r: unknown): unknown {
  if (!isObj(r)) return null;
  return strip({ lifecycleId: r.lifecycleId, documentId: r.documentId, globalId: r.globalId, GlobalId: r.GlobalId, number: r.number, Number: r.Number, isRefund: r.isRefund, kind: r.kind, currency: r.currency,
    amounts: isObj(r.amounts) ? { currency: r.amounts.currency ?? null } : null, lines: pLines(r.lines), Lines: pLines(r.Lines), invoiceItems: pItems(r.invoiceItems), InvoiceItems: pItems(r.InvoiceItems) });
}

const soldAt = "2026-09-27T20:15:00Z";
const raws: unknown[] = [
  { documentId: "F1", kind: "invoice", currency: "EUR", noise: "x".repeat(5000), lines: [{ providerProductId: "10", quantity: 1, totalAmount: 5, soldAt, productName: "Vino A", lineId: "L1", extra: { big: [1, 2, 3] } }] },
  { GlobalId: "G9", Number: 77, invoiceItems: [{ GlobalId: "G9-1", Lines: [{ ProductId: "10", Quantity: 1, UnitPrice: 5, CreationDate: soldAt, Index: 0 }, 3, null] }] },
  { lifecycleId: "LC", lines: [{ providerProductId: "10", quantity: 1, totalAmount: 5, soldAt, lineId: null, LineId: "X" }, { providerProductId: "10", quantity: 1, totalAmount: 5, soldAt, lineId: "dup" }] },
  { lines: "not-array", Lines: [{ providerProductId: "10", quantity: 1, productPrice: 5, soldAt, index: 2 }], globalId: "GG", amounts: { currency: "EUR", total: 99 } },
  { isRefund: true, lines: [{ providerProductId: "10", quantity: 1, totalAmount: 5, soldAt: "2026-09-27T22:15:00+02:00", lineId: "R1", productName: "Otro" }] },
  "scalar", null, [],
];
const row = (raw: unknown): AgoraDbLine => ({ id: "1", connection_id: "c", provider_product_id: "10", provider_sold_at: soldAt, format: "BOTTLE", quantity: 1, total_amount: 5, winerim_product_id: "w", mapped: true, name: "Vino A", sales_event: { provider_doc_id: "D", business_day: "2026-09-27", doc_type: "invoice", raw_json: raw } });

describe("analytics raw_json projection", () => {
  it("identity and amount are identical on full and projected raw_json", () => {
    for (const raw of raws) {
      const full = row(structuredClone(raw)); const proj = row(projectRaw(structuredClone(raw)));
      expect(agoraProviderIdentity(proj)).toBe(agoraProviderIdentity(full));
      expect(agoraProviderAmount(proj)).toBe(agoraProviderAmount(full));
    }
  });
  it("projection drops unrelated payload volume", () => {
    expect(JSON.stringify(projectRaw(raws[0])).length).toBeLessThan(JSON.stringify(raws[0]).length / 10);
  });
  it("analytics window uses the projected RPC, operational day keeps full rows", () => {
    const src = readFileSync("supabase/functions/run-daily-reconciliation/index.ts", "utf8");
    expect(src).toContain('sourceRows(db, connectionId, day, plusDays(day, 1), true)');
    expect(src).toContain('db.rpc("reconciliation_v2_analytics_events"');
    const sql = readFileSync(new URL("../../supabase/migrations/", import.meta.url).pathname + require("node:fs").readdirSync("supabase/migrations").filter((f: string) => readFileSync(`supabase/migrations/${f}`, "utf8").includes("reconciliation_v2_analytics_events")).pop(), "utf8");
    for (const k of LINE_KEYS) expect(sql).toContain(`'${k}'`);
    expect(sql).not.toMatch(/grant execute on function public\.reconciliation_v2_analytics_events[^;]*(anon|authenticated)/i);
  });
});
