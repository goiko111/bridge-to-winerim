import { describe, expect, it } from "vitest";
import {
  classifyAgoraRefunds,
  excludeReopenSupersededEvents,
  executeWinerimReversal,
  planLineAction,
  prepareReversal,
  WINERIM_REVERSAL_ENABLED,
} from "../../supabase/functions/_shared/agoraTicketLifecycle";

const R = "8466c229-773d-4ad9-a747-9bb862d7ae6b";
const T = "57b5d03d-9098-41ee-a5dd-a4b6febe2407";
const atauta = (qty: number) => ({ ProductId: 900, SaleFormatId: 900, Index: 3, CreationDate: "2026-09-25T21:26:46", UnitPrice: 38, Quantity: qty });
const bread = (qty: number) => ({ ProductId: 225, SaleFormatId: 225, Index: 0, CreationDate: "2026-09-25T20:22:54", UnitPrice: 3.5, Quantity: qty });
const inv = (id: string, number: number, lines: unknown[], gid: string) => ({
  id, doc_type: "BasicInvoice", provider_doc_id: String(number),
  raw_json: { Serie: "T", Number: number, InvoiceItems: [{ GlobalId: gid, Lines: lines }] },
});
const refund = (id: string, relNumber: number, lines: unknown[], source = "Reopen") => ({
  id, doc_type: "BasicRefund", provider_doc_id: `refund:td:${id}`,
  raw_json: { _agora_refund: true, Serie: "TD", RefundSource: source, RelatedInvoice: { Serie: "T", Number: relNumber }, InvoiceItems: [{ Lines: lines }] },
});
const line = (qty: number, over: Partial<{ agoraTicketId: string | null; sourceLineId: string | null }> = {}) => ({
  restaurantId: R, agoraTicketId: T, sourceLineId: "3", format: "BOTTLE", observedQty: qty, ...over,
});

describe("open ticket lifecycle", () => {
  it("1. open ticket with one bottle applies immediately", () => {
    expect(planLineAction(line(1), 0)).toMatchObject({ kind: "APPLY", deltaQty: 1 });
  });
  it("2. ticket open two hours: re-reads are no-ops", () => {
    for (let i = 0; i < 24; i++) expect(planLineAction(line(1), 1).kind).toBe("NOOP");
  });
  it("3. increment 1→2 sends only the delta with a new deterministic orderId", () => {
    const a = planLineAction(line(1), 0);
    const b = planLineAction(line(2), 1);
    expect(b).toMatchObject({ kind: "APPLY", deltaQty: 1 });
    expect(a.kind === "APPLY" && b.kind === "APPLY" && a.orderId !== b.orderId).toBe(true);
    expect(planLineAction(line(2), 1)).toEqual(b);
  });
  it("4. normal close: invoice alone stays in desired set, no second discount", () => {
    const events = [inv("e1", 42530, [atauta(1)], T)];
    expect(excludeReopenSupersededEvents(events, events)).toHaveLength(1);
    expect(planLineAction(line(1), 1).kind).toBe("NOOP");
  });
  it("5. close → reopen → payment change → close (Don Quijote) counts one bottle", () => {
    const first = inv("e1", 42530, [bread(6), atauta(1)], T);
    const td = refund("e2", 42530, [bread(-6), atauta(-1)]);
    const second = inv("e3", 42531, [bread(6), atauta(1)], "3114f562");
    const all = [first, td, second];
    const eligible = [first, second]; // refunds are never stock-eligible
    const desired = excludeReopenSupersededEvents(eligible, all);
    expect(desired.map((e) => e.id)).toEqual(["e3"]);
    const bottles = desired.flatMap((e) => (e.raw_json.InvoiceItems[0].Lines as { ProductId: number; Quantity: number }[]))
      .filter((l) => l.ProductId === 900).reduce((s, l) => s + l.Quantity, 0);
    expect(bottles).toBe(1);
    expect(classifyAgoraRefunds(all)).toEqual([{ kind: "REOPEN_SUPERSEDES", refundEventId: "e2", supersededEventId: "e1" }]);
  });
  it("6. line removed before close → reversal pending, never negative write", () => {
    expect(planLineAction(line(0), 1)).toMatchObject({ kind: "REVERSAL_PENDING", reverseQty: 1 });
  });
  it("7. full cancellation (non-reopen refund) → REVERSAL_PENDING full", () => {
    const all = [inv("e1", 1, [atauta(1)], T), refund("e2", 1, [atauta(-1)], "Cancel")];
    expect(classifyAgoraRefunds(all)[0]).toMatchObject({ kind: "REVERSAL_PENDING", reason: "full_cancellation" });
    expect(excludeReopenSupersededEvents([all[0]], all)).toHaveLength(1);
  });
  it("8. partial refund → REVERSAL_PENDING partial", () => {
    const all = [inv("e1", 1, [atauta(2)], T), refund("e2", 1, [atauta(-1)], "Refund")];
    expect(classifyAgoraRefunds(all)[0]).toMatchObject({ kind: "REVERSAL_PENDING", reason: "partial_refund" });
  });
  it("9. two identical real sales stay two sales", () => {
    const events = [inv("e1", 10, [atauta(1)], "a"), inv("e2", 11, [atauta(1)], "b")];
    expect(excludeReopenSupersededEvents(events, events)).toHaveLength(2);
    expect(planLineAction(line(1, { agoraTicketId: "a" }), 0).kind).toBe("APPLY");
    expect(planLineAction(line(1, { agoraTicketId: "b" }), 0).kind).toBe("APPLY");
  });
  it("10. re-reading the same ticket is idempotent", () => {
    expect(planLineAction(line(1), 0)).toEqual(planLineAction(line(1), 0));
  });
  it("11. failure after Winerim write but before receipt: same orderId on retry", () => {
    const first = planLineAction(line(1), 0);
    const retry = planLineAction(line(1), 0); // applied not recorded → same deterministic id
    expect(first.kind === "APPLY" && retry.kind === "APPLY" && first.orderId === retry.orderId).toBe(true);
  });
  it("12. line without stable identity is AMBIGUOUS", () => {
    expect(planLineAction(line(1, { sourceLineId: null }), 0)).toEqual({ kind: "AMBIGUOUS", reason: "unstable_line_identity" });
    const all = [inv("e1", 1, [{ ...atauta(1), CreationDate: "" }], T), refund("e2", 1, [{ ...atauta(-1), CreationDate: "" }])];
    expect(classifyAgoraRefunds(all)[0].kind).toBe("AMBIGUOUS");
    expect(excludeReopenSupersededEvents([all[0]], all)).toHaveLength(1);
  });
  it("12b. reopen refund without an unambiguous related invoice is AMBIGUOUS", () => {
    const all = [refund("e2", 999, [atauta(-1)])];
    expect(classifyAgoraRefunds(all)[0]).toMatchObject({ kind: "AMBIGUOUS", reason: "related_invoice_matches_0" });
  });
  it("13. legacy sale without certified receipt cannot be reversed", () => {
    expect(prepareReversal({ qty: 1, historyApplied: true, stockApplied: true, legacy: true })).toEqual({ rejected: "legacy_sale_without_certified_receipt" });
    expect(prepareReversal({ qty: 1, historyApplied: true, stockApplied: true })).toEqual({ rejected: "no_receipt_or_deterministic_identity" });
  });
  it("14. future reversal twice never writes while disabled", async () => {
    const req = prepareReversal({ receiptId: "188690", qty: 1, historyApplied: true, stockApplied: true });
    expect("rejected" in req).toBe(false);
    expect(WINERIM_REVERSAL_ENABLED).toBe(false);
    for (let i = 0; i < 2; i++) {
      expect(await executeWinerimReversal(req as never)).toEqual({ executed: false, reason: "winerim_reversal_endpoint_not_available" });
    }
    expect(prepareReversal({ receiptId: "x", qty: 1, historyApplied: true, stockApplied: false })).toMatchObject({ effects: { history: true, stock: false } });
  });
});
