import { describe, expect, it } from "vitest";
import { naturalDayInTimeZone, shouldHoldLateDefinitive } from "../../supabase/functions/_shared/agoraLateInvoiceGuard";

const base = { day: "2026-09-29", timeZone: "Europe/Madrid", openTicketSuccessSends: 5 } as const;

describe("freno factura tardía tras ticket abierto", () => {
  it("día natural en Madrid", () => {
    expect(naturalDayInTimeZone("2026-09-29T22:30:00Z", "Europe/Madrid")).toBe("2026-09-30");
    expect(naturalDayInTimeZone("2026-09-29T21:59:00Z", "Europe/Madrid")).toBe("2026-09-29");
  });
  it("caso real Q Tomas: factura 26288 a las 02:05 del 30 con abiertos enviados → retener", () => {
    expect(shouldHoldLateDefinitive({ ...base, desiredSource: "definitive", nowIso: "2026-09-30T00:05:00Z" })).toBe(true);
  });
  it("factura antes de medianoche → envía normal", () => {
    expect(shouldHoldLateDefinitive({ ...base, desiredSource: "definitive", nowIso: "2026-09-29T20:00:00Z" })).toBe(false);
  });
  it("tras medianoche sin envíos de abiertos → envía normal", () => {
    expect(shouldHoldLateDefinitive({ ...base, openTicketSuccessSends: 0, desiredSource: "definitive", nowIso: "2026-09-30T00:05:00Z" })).toBe(false);
  });
  it("envío open_ticket nunca se retiene por este freno", () => {
    expect(shouldHoldLateDefinitive({ ...base, desiredSource: "open_ticket", nowIso: "2026-09-30T00:05:00Z" })).toBe(false);
  });
});
