import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("supabase/functions/agora-proxy/index.ts", "utf8");

describe("repesaje seguro y certificación por readback", () => {
  it("safe-repush-one exige confirmación, vino activo en carta y formato publicable", () => {
    const block = src.slice(src.indexOf('action === "safe-repush-one"'), src.indexOf('action === "queue-xml-outbound" || safeRepushValidated'));
    expect(block).toContain("CONFIRMATION_REQUIRED");
    expect(block).toContain("WINE_NOT_IN_MENU");
    expect(block).toContain("WINE_INACTIVE");
    expect(block).toContain("FORMAT_UNAVAILABLE");
    expect(block).toContain("AMBIGUOUS_MAPPING");
    expect(block).toContain("706b952e-767d-41af-9cba-8e225b16a877");
    expect(block).toContain("payload.winerimWineIds = [wineId]");
  });
  it("la ruta de encolado conserva la deduplicación QUEUED/RUNNING", () => {
    const q = src.slice(src.indexOf('action === "queue-xml-outbound" || safeRepushValidated'));
    expect(q.slice(0, 12000)).toContain('.in("status", ["QUEUED", "RUNNING"])');
  });
  it("verify-products en auditOnly no sella seguimiento y certifica solo por readback", () => {
    const v = src.slice(src.indexOf('action === "verify-products"'), src.indexOf("DEBUG BUNDLE"));
    expect(v).toContain("!auditOnly && offset < trackingRows.length");
    expect(v).toContain("AUTO_SYNC_CERTIFICADA_POR_READBACK");
    expect(v).toContain("CONFIGURADA_SIN_CERTIFICAR");
    expect(v).toContain("SOURCE_INCOMPLETE");
  });
});
