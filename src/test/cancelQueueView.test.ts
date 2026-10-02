import { describe, expect, it } from "vitest";
import { canApprove, describeCancel } from "../../supabase/functions/_shared/cancelQueueView";
import { readFileSync } from "node:fs";

describe("vista de anulaciones pendientes", () => {
  it("extrae vino, formato, unidades, venta y día", () => {
    const v = describeCancel(
      { cancels: [{ orderId: "agora:89fc3241:2026-09-30:267265:bot:8n9ywa", cancelUpTo: 1, reason: "Ticket abierto …b0cf56f6 anulado en Ágora sin factura (B Albahra)" }] },
      [{ saleId: 193659, businessDay: "2026-09-30" }],
    );
    expect(v).toMatchObject({ wine: "B Albahra", format: "Botella", units: 1, saleId: 193659, businessDay: "2026-09-30" });
  });
  it("copa por :cop:", () => expect(describeCancel({ cancels: [{ orderId: "agora:x:2026-09-30:1:cop:a" }] }, null).format).toBe("Copa"));
  it("payload vacío no rompe", () => expect(describeCancel(null, null)).toMatchObject({ wine: null, units: null, saleId: null }));
  it("no puede aprobar quien la preparó", () => expect(canApprove("u1", "u1", "PENDING_APPROVAL")).toBe(false));
  it("otra persona sí, solo si está pendiente", () => {
    expect(canApprove("u1", "u2", "PENDING_APPROVAL")).toBe(true);
    expect(canApprove("u1", "u2", "DONE")).toBe(false);
    expect(canApprove(null, "u2", "PENDING_APPROVAL")).toBe(false);
  });
  it("la función aprueba y ejecuta con readback y bloquea autoaprobación", () => {
    const src = readFileSync("supabase/functions/winerim-sales-cancel/index.ts", "utf8");
    expect(src).toContain("CANCEL_SELF_APPROVAL");
    expect(src).toMatch(/action === "APPROVE"[\s\S]*executeApproved/);
    expect(src).toContain("/sales/status");
    expect(src).not.toMatch(/\/stock[`"']/);
  });
});
