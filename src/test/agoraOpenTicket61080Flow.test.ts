import { describe, expect, it } from "vitest";
import { openTicketRestoreAllowed } from "../../supabase/functions/_shared/agoraOpenTicketRestoreGuard";

// Modelo del flujo real Q Tomas 61080 (29-sep): el puente envía target − ya enviado.
// Comprueba el resultado final: 1 venta en historial y stock −1.
describe("61080: abierto 22:48 +1, factura 02:05", () => {
  it("1 sola venta en historial y stock −1", () => {
    const tz = "Europe/Madrid";
    const gid = "g-61080";
    let history = 0, stock = 0, sent = 0;
    // 22:48 abierto: target 1
    history += 1; stock -= 1; sent = 1;
    // 00:25 intento de devolución: día de negocio 29 sigue abierto → no se devuelve
    const allowed = openTicketRestoreAllowed({ event: { business_day: "2026-09-29", provider_doc_id: `open_ticket:${gid}` }, nowIso: "2026-09-29T22:25:00Z", timeZone: tz, invoicedGlobalIds: new Set() });
    if (allowed) { stock += 1; sent = 0; }
    // 02:05 factura del mismo ticket: target 1 → delta = 1 − enviado
    const delta = 1 - sent;
    history += delta; stock -= delta;
    // después de las 06:00 la factura ya está vinculada → tampoco se devuelve
    const later = openTicketRestoreAllowed({ event: { business_day: "2026-09-29", provider_doc_id: `open_ticket:${gid}` }, nowIso: "2026-09-30T05:00:00Z", timeZone: tz, invoicedGlobalIds: new Set([gid]) });
    if (later) stock += 1;
    expect(allowed).toBe(false);
    expect(later).toBe(false);
    expect(history).toBe(1);
    expect(stock).toBe(-1);
  });
});
