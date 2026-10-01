import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { convertRefundFreeze } from "./agoraConvertRefundFreeze.ts";
const L = (p: string, i: number, q: number) => ({ ProductId: p, SaleFormatId: p, Index: i, CreationDate: "2026-09-22T15:02:43", UnitPrice: 8, Quantity: q });
const doc = (id: string, lines: unknown[], extra: Record<string, unknown> = {}) => ({ id, doc_type: extra.doc ?? "StandardInvoice", raw_json: { InvoiceItems: [{ Lines: lines }], ...extra.raw as object } });
Deno.test("J 593 congela solo F 512, no otra factura con el mismo nº de líneas", () => {
  const j = doc("j593", [L("982010", 7, -2), L("1923", 0, -1)], { doc: "BasicRefund", raw: { _agora_refund: true, RefundSource: "ConvertToStandard" } });
  const f = doc("f512", [L("982010", 7, 2), L("1923", 0, 1)]);
  const other = doc("f21204", [L("2137", 0, 1), L("3008", 1, 1)], { doc: "BasicInvoice" });
  const d = convertRefundFreeze([j, f, other], new Set(["j593"]));
  assertEquals([...d.frozenEventIds], ["f512"]);
  assertEquals(d.frozenProductIds.size, 0);
});
Deno.test("sin reemitido exacto → falla cerrado (producto congelado)", () => {
  const j = doc("j", [L("982010", 7, -2)], { doc: "BasicRefund", raw: { _agora_refund: true, RefundSource: "ConvertToStandard" } });
  const d = convertRefundFreeze([j, doc("x", [L("2137", 0, 1)])], new Set(["j"]));
  assertEquals([...d.frozenProductIds], ["982010"]);
});
