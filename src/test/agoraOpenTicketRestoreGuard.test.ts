import { describe, expect, it } from "vitest";
import { currentBusinessDay, openTicketRestoreAllowed } from "../../supabase/functions/_shared/agoraOpenTicketRestoreGuard";

const tz = "Europe/Madrid";
// Caso real Q Tomas 61080: abierto 29-sep 22:48 (+1), devolución 00:25 (−1), factura 26288 02:05 (+1).
const ev = { business_day: "2026-09-29", provider_doc_id: "open_ticket:ebe4da4a-7b0e-4ec6-a105-b0c7d5d55f7f" };
const none = new Set<string>();

describe("devolución de abiertos solo con día de negocio cerrado", () => {
  it("00:25 Madrid sigue siendo el día de negocio 29", () => {
    expect(currentBusinessDay("2026-09-29T22:25:00Z", tz)).toBe("2026-09-29");
  });
  it("61080 a las 00:25: no se devuelve (día abierto)", () => {
    expect(openTicketRestoreAllowed({ event: ev, nowIso: "2026-09-29T22:25:00Z", timeZone: tz, invoicedGlobalIds: none })).toBe(false);
  });
  it("61080 tras las 06:00 con factura vinculada por GlobalId: no se devuelve", () => {
    const linked = new Set(["ebe4da4a-7b0e-4ec6-a105-b0c7d5d55f7f"]);
    expect(openTicketRestoreAllowed({ event: ev, nowIso: "2026-09-30T04:30:00Z", timeZone: tz, invoicedGlobalIds: linked })).toBe(false);
  });
  it("tras las 06:00 sin factura: se permite (solo si el ajuste del local lo activa)", () => {
    expect(openTicketRestoreAllowed({ event: ev, nowIso: "2026-09-30T04:30:00Z", timeZone: tz, invoicedGlobalIds: none })).toBe(true);
  });
  it("GlobalId en raw_json tiene prioridad", () => {
    const e = { ...ev, raw_json: { GlobalId: "G1" } };
    expect(openTicketRestoreAllowed({ event: e, nowIso: "2026-09-30T04:30:00Z", timeZone: tz, invoicedGlobalIds: new Set(["G1"]) })).toBe(false);
  });
});
