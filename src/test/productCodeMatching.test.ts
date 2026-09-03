import { describe, expect, it } from "vitest";
import {
  extractCommercialCodeFromName,
  normalizeCommercialCode,
} from "../../supabase/functions/_shared/productCodeMatching";

describe("product code matching", () => {
  it("extracts Winerim commercial codes from Winerim names", () => {
    expect(extractCommercialCodeFromName("G801-Península Palo Cortado")).toBe("G801");
    expect(extractCommercialCodeFromName("B303-Binitord Blanc")).toBe("B303");
    expect(extractCommercialCodeFromName("B-308- Foraster")).toBe("B308");
    expect(extractCommercialCodeFromName("T 74-Finca La Montesa")).toBe("T74");
    expect(extractCommercialCodeFromName("MAGNUM 21 - Finca La Montesa")).toBe("MAGNUM21");
  });

  it("extracts Winerim commercial codes from generated Agora labels", () => {
    expect(extractCommercialCodeFromName("B T31-Semele")).toBe("T31");
    expect(extractCommercialCodeFromName("C B303-Binitord Blanc")).toBe("B303");
    expect(extractCommercialCodeFromName("M MAGNUM 21 - Finca La Montesa")).toBe("MAGNUM21");
  });

  it("does not treat wine names with numbers as commercial codes", () => {
    expect(extractCommercialCodeFromName("Magnum 4 Kilos")).toBeNull();
    expect(extractCommercialCodeFromName("Magnum-  4 Kilos")).toBeNull();
    expect(extractCommercialCodeFromName("As 2 Ladeiras")).toBeNull();
    expect(extractCommercialCodeFromName("200 Monges Rioja")).toBeNull();
  });

  it("normalizes commercial codes for exact comparisons", () => {
    expect(normalizeCommercialCode(" b-308 ")).toBe("B308");
    expect(normalizeCommercialCode("Mágnum 21")).toBe("MAGNUM21");
  });
});
