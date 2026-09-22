import { describe, expect, it } from "vitest";
import {
  AUDIT_STATUS_LABELS,
  REVIEW_FORMAT_LABELS,
  canApproveDecision,
  deriveAuditStatus,
  formatBoolean,
  formatLatency,
  isVariantCompatible,
  toCsv,
} from "@/lib/catalogReview";

const base = {
  formatKey: "BOTTLE",
  pushStatus: "VERIFIED",
  readbackFresh: true,
  foundInAgora: true,
  agoraSaleable: true,
  agoraVisible: true,
  expectedFamilyId: "112",
  agoraFamilyId: "112",
  winerimPrice: 27,
  agoraPrice: 27,
};

describe("formatos de revisión", () => {
  it("cubre los nueve formatos soportados con etiqueta española", () => {
    expect(Object.keys(REVIEW_FORMAT_LABELS).sort()).toEqual(
      [
        "BENJAMIN",
        "BOTTLE",
        "DOUBLE_MAGNUM",
        "GLASS",
        "HALF_BOTTLE",
        "HALF_GLASS",
        "MAGNUM",
        "SIN_DATO",
        "SMALL_BOTTLE",
      ].sort(),
    );
    expect(REVIEW_FORMAT_LABELS.HALF_GLASS).toBe("Media copa");
    expect(REVIEW_FORMAT_LABELS.SIN_DATO).toBe("Sin dato");
  });
});

describe("compatibilidad de variantes", () => {
  it("no permite Copa contra variante Botella ni al contrario", () => {
    expect(isVariantCompatible("GLASS", "BOTTLE")).toBe(false);
    expect(isVariantCompatible("BOTTLE", "GLASS")).toBe(false);
    expect(isVariantCompatible("GLASS", "GLASS")).toBe(true);
  });

  it("bloquea la aprobación cuando el formato es SIN_DATO", () => {
    expect(
      canApproveDecision({ agoraFormatKey: "SIN_DATO", selectedWinerimId: "61109", selectedFormatKey: "BOTTLE" }),
    ).toBe(false);
    expect(
      canApproveDecision({ agoraFormatKey: "BOTTLE", selectedWinerimId: "61109", selectedFormatKey: "SIN_DATO" }),
    ).toBe(false);
  });

  it("bloquea la aprobación sin vino seleccionado", () => {
    expect(canApproveDecision({ agoraFormatKey: "BOTTLE", selectedWinerimId: null, selectedFormatKey: "BOTTLE" })).toBe(
      false,
    );
  });

  it("aprueba solo vino + formato exacto compatible", () => {
    expect(
      canApproveDecision({ agoraFormatKey: "MAGNUM", selectedWinerimId: "61109", selectedFormatKey: "MAGNUM" }),
    ).toBe(true);
  });
});

describe("estado de auditoría", () => {
  it("sin lectura fresca nunca es MATCHED_LIVE", () => {
    expect(deriveAuditStatus({ ...base, readbackFresh: false })).toBe("NO_CURRENT_READBACK");
    expect(deriveAuditStatus({ ...base, readbackFresh: null })).toBe("NO_CURRENT_READBACK");
  });

  it("con lectura fresca y todo igual es MATCHED_LIVE", () => {
    expect(deriveAuditStatus(base)).toBe("MATCHED_LIVE");
  });

  it("detecta diferencia de precio por encima de medio céntimo", () => {
    expect(deriveAuditStatus({ ...base, agoraPrice: 25 })).toBe("PRICE_MISMATCH");
    expect(deriveAuditStatus({ ...base, agoraPrice: 27.004 })).toBe("MATCHED_LIVE");
  });

  it("prioriza envío fallido y pendiente sobre la lectura", () => {
    expect(deriveAuditStatus({ ...base, pushStatus: "FAILED" })).toBe("PUSH_FAILED");
    expect(deriveAuditStatus({ ...base, pushStatus: "QUEUED" })).toBe("PENDING_PUSH");
  });

  it("marca ausencia, no vendible y familia distinta", () => {
    expect(deriveAuditStatus({ ...base, foundInAgora: false })).toBe("MISSING_IN_AGORA");
    expect(deriveAuditStatus({ ...base, agoraSaleable: false })).toBe("NOT_SALEABLE");
    expect(deriveAuditStatus({ ...base, agoraFamilyId: "999" })).toBe("FAMILY_MISMATCH");
  });

  it("formato sin dato es ambiguo", () => {
    expect(deriveAuditStatus({ ...base, formatKey: "SIN_DATO" })).toBe("AMBIGUOUS");
    expect(deriveAuditStatus({ ...base, formatKey: null })).toBe("AMBIGUOUS");
  });

  it("todos los estados tienen etiqueta", () => {
    const states = [
      "MATCHED_LIVE",
      "MISSING_IN_AGORA",
      "PRICE_MISMATCH",
      "FORMAT_MISMATCH",
      "NOT_SALEABLE",
      "HIDDEN",
      "FAMILY_MISMATCH",
      "PENDING_PUSH",
      "PUSH_FAILED",
      "NO_CURRENT_READBACK",
      "LEGACY_ONLY",
      "AMBIGUOUS",
    ];
    for (const s of states) expect(AUDIT_STATUS_LABELS[s]).toBeTruthy();
  });
});

describe("NULL como desconocido", () => {
  it("no convierte NULL en falso ni en cero", () => {
    expect(formatBoolean(null)).toBe("Desconocido");
    expect(formatBoolean(undefined)).toBe("Desconocido");
    expect(formatBoolean(false)).toBe("No");
    expect(formatLatency(null)).toBe("SIN_EVIDENCIA");
  });
});

describe("CSV", () => {
  it("escapa comas y une arrays", () => {
    const csv = toCsv([{ a: "x,y", b: ["PRICE_MISMATCH", "HIDDEN"], c: null }]);
    expect(csv.split("\n")[0]).toBe("a,b,c");
    expect(csv.split("\n")[1]).toBe('"x,y",PRICE_MISMATCH|HIDDEN,');
  });
});
