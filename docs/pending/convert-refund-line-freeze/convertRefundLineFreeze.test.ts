import { describe, expect, it } from "vitest";
import { convertRefundFreeze, isFrozen, type Ev } from "../../../supabase/functions/_shared/agoraConvertRefundFreeze.ts";

// Caso real El Higuerón 30-sep: T 20549 (22-sep) → J 593 ConvertToStandard + F 512.
const L = (pid: string, idx: number, q: number, created = "2026-09-22T15:02:43") =>
  ({ ProductId: pid, SaleFormatId: "2", Index: idx, CreationDate: created, UnitPrice: 5.5, Quantity: q });
const convertedLines = (s: 1 | -1) => [L("982010", 7, 2 * s), L("827193", 1, 1 * s), L("2137", 2, 2 * s)];

const J593: Ev = { id: "J593", doc_type: "BasicRefund", raw_json: { _agora_refund: true, RefundSource: "ConvertToStandard", RelatedInvoice: { Serie: "T", Number: 20549 }, InvoiceItems: [{ Lines: convertedLines(-1) }] } };
const F512: Ev = { id: "F512", doc_type: "StandardInvoice", raw_json: { Serie: "F", Number: 512, InvoiceItems: [{ Lines: convertedLines(1) }] } };
const inv = (id: string, q: number, t: string): Ev => ({ id, doc_type: "BasicInvoice", raw_json: { Serie: "T", Number: id, InvoiceItems: [{ Lines: [L("982010", 1, q, t)] }] } });
const today = [inv("21191", 2, "2026-09-30T13:04:01"), inv("21235", 5, "2026-09-30T14:29:26"), inv("21218", 2, "2026-09-30T15:04:40")];

// Réplica mínima del objetivo del día del bridge (suma por producto, resta lo ya enviado).
function dayDelta(events: Ev[], frozen: ReturnType<typeof convertRefundFreeze>, pid: string, alreadySent: number) {
  let desired = 0;
  for (const e of events) {
    if (/refund/i.test(String(e.doc_type))) continue;
    for (const it of (e.raw_json as any).InvoiceItems) for (const l of it.Lines) {
      if (l.ProductId !== pid || isFrozen({ sales_event_id: e.id, provider_product_id: l.ProductId }, frozen)) continue;
      desired += l.Quantity;
    }
  }
  return Math.max(0, desired - alreadySent);
}

describe("devolución ConvertToStandard ambigua: congelar líneas, no el producto", () => {
  const events = [J593, F512, ...today];
  const d = convertRefundFreeze(events, new Set(["J593"]));

  it("caso T 20549 / J 593 / F 512: solo F 512 queda fuera; ningún producto congelado", () => {
    expect([...d.frozenEventIds]).toEqual(["F512"]);
    expect(d.frozenProductIds.size).toBe(0);
  });

  it("las copas de Emilio Moro de hoy salen (9), sin las 2 del ticket del 22-sep", () => {
    expect(dayDelta(events, d, "982010", 0)).toBe(9);
  });

  it("siguiente ciclo tras publicar: no duplica lo ya enviado", () => {
    expect(dayDelta(events, d, "982010", 9)).toBe(0);
    expect(dayDelta([...events, inv("21300", 1, "2026-09-30T20:00:00")], d, "982010", 9)).toBe(1);
  });

  it("sin documento reemitido exacto → falla cerrado como hoy (producto congelado)", () => {
    const d2 = convertRefundFreeze([J593, ...today], new Set(["J593"]));
    expect(d2.frozenEventIds.size).toBe(0);
    expect(d2.frozenProductIds).toEqual(new Set(["982010", "827193", "2137"]));
    expect(dayDelta([J593, ...today], d2, "982010", 0)).toBe(0);
  });

  it("reemitido con cantidades distintas no cuenta como exacto", () => {
    const F512b: Ev = { ...F512, id: "F512b", raw_json: { ...(F512.raw_json as any), InvoiceItems: [{ Lines: [L("982010", 7, 3), L("827193", 1, 1), L("2137", 2, 2)] }] } };
    expect(convertRefundFreeze([J593, F512b], new Set(["J593"])).frozenProductIds.has("982010")).toBe(true);
  });

  it("dos candidatos idénticos → ambiguo, falla cerrado", () => {
    const d3 = convertRefundFreeze([J593, F512, { ...F512, id: "F513" }], new Set(["J593"]));
    expect(d3.frozenEventIds.size).toBe(0);
    expect(d3.frozenProductIds.has("982010")).toBe(true);
  });

  it("devoluciones no ambiguas no se tocan", () => {
    expect(convertRefundFreeze(events, new Set()).frozenEventIds.size).toBe(0);
  });
});
