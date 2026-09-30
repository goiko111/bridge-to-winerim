import { describe, expect, it } from "vitest";
import { aggregateByWineFormat, closedTicketGlobalIds, resolveAgoraFormat, supersededOpenLines } from "../../supabase/functions/_shared/reconciliation-v2/dayAggregate";

const ev = (doc: string, type: string, raw: unknown) => ({ provider_doc_id: doc, doc_type: type, raw_json: raw });
const line = (e: ReturnType<typeof ev>, pid: string, at: string, qty = 1) => ({ provider_product_id: pid, provider_sold_at: at, quantity: qty, sales_event: e });

describe("una sola versión por ticket", () => {
  const inv = ev("T-1", "BasicInvoice", { InvoiceItems: [{ GlobalId: "g1" }] });
  const open1 = ev("open_ticket:g1", "OpenTicket", { GlobalId: "g1" });
  const open2 = ev("open_ticket:g2", "OpenTicket", { GlobalId: "g2" });
  it("descarta la foto abierta cuando Ágora vincula el ticket a una factura", () => {
    const lines = [line(inv, "10", "2026-09-29T13:00:00"), line(open1, "10", "2026-09-29T13:00:00"), line(open2, "11", "2026-09-29T14:00:00")];
    const out = supersededOpenLines(lines, closedTicketGlobalIds([inv]));
    expect(out.superseded).toHaveLength(1); expect(out.byLink).toBe(1); expect(out.kept).toHaveLength(2);
  });
  it("sin vínculo, usa producto+hora+cantidad y cada cerrada absorbe una sola abierta", () => {
    const inv2 = ev("T-2", "BasicInvoice", {});
    const a = ev("open_ticket:x", "OpenTicket", {}); const b = ev("open_ticket:y", "OpenTicket", {});
    const out = supersededOpenLines([line(inv2, "5", "t1"), line(a, "5", "t1"), line(b, "5", "t1")], closedTicketGlobalIds([inv2]));
    expect(out.byFallback).toBe(1); expect(out.kept).toHaveLength(2);
  });
});

describe("formato de Ágora", () => {
  it("el nombre del vino en el formato se trata como botella inferida", () => {
    expect(resolveAgoraFormat("Carraovejas El Anejon")).toEqual({ format: "botella", inferred: true });
    expect(resolveAgoraFormat("BOT").format).toBe("botella"); expect(resolveAgoraFormat("COPA").format).toBe("copa");
  });
});

describe("suma por día, vino y formato", () => {
  const A = (qty: number, extra: Record<string, unknown> = {}) => ({ businessDay: "2026-09-29", state: "AMBIGUOUS" as const, agora: { wineId: "7", format: "COPA", quantity: qty, isOpen: false, isCancelled: false, ...extra }, winerim: null });
  const W = (qty: number) => ({ businessDay: "2026-09-29", state: "AMBIGUOUS" as const, agora: null, winerim: { wineId: "7", format: "copa", quantity: qty, saleStatus: "confirmed" } });
  it("copas agrupadas en Winerim con otra hora cuadran al 100 % en unidades", () => {
    const out = aggregateByWineFormat([A(1), A(2), A(1), W(4)]);
    expect(out.groups[0]).toMatchObject({ closedQty: 4, winerimQty: 4, state: "MATCHED" }); expect(out.summary.fullMatch).toBe(true);
  });
  it("devolución resta y el abierto no absorbido se informa aparte", () => {
    const out = aggregateByWineFormat([A(2), A(-1, { isCancelled: true }), A(1, { isOpen: true }), W(1)]);
    expect(out.groups[0]).toMatchObject({ closedQty: 1, openQty: 1, expectedQty: 1, diff: 0, state: "MATCHED" });
  });
  it("fuente incompleta nunca se certifica", () => {
    const out = aggregateByWineFormat([{ ...A(1), state: "SOURCE_INCOMPLETE" }, W(1)]);
    expect(out.summary.fullMatch).toBe(false); expect(out.groups[0].state).toBe("SOURCE_INCOMPLETE");
  });
});
