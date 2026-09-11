import { describe, expect, it } from "vitest";
import {
  planAgoraFormatPrefixRenames,
  stripAgoraFormatPrefix,
} from "../../supabase/functions/_shared/agoraFormatPrefixNaming";

describe("Agora format prefix unification", () => {
  it("adds the format prefix to Winerim-linked buttons that lack it", () => {
    const plan = planAgoraFormatPrefixRenames(
      [
        { productId: 2037673, name: "Alión" },
        { productId: 3037673, name: "Alión copa" },
        { productId: 4037673, name: "Alión Magnum" },
      ],
      [
        { productId: 2037673, formatType: "BOTTLE" },
        { productId: 3037673, formatType: "GLASS" },
        { productId: 4037673, formatType: "MAGNUM" },
      ],
    );

    expect(plan.renames.map((r) => r.newName)).toEqual([
      "B Alión",
      "C Alión copa",
      "M Alión Magnum",
    ]);
    expect(plan.skipped).toHaveLength(0);
  });

  it("keeps already prefixed buttons untouched", () => {
    const plan = planAgoraFormatPrefixRenames(
      [{ productId: 1296, name: "B Macán" }],
      [{ productId: 1296, formatType: "BOTTLE" }],
    );

    expect(plan.renames).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("already_prefixed");
  });

  it("fixes buttons carrying the wrong format prefix", () => {
    const plan = planAgoraFormatPrefixRenames(
      [{ productId: 3044490, name: "B Mauro" }],
      [{ productId: 3044490, formatType: "GLASS" }],
    );

    expect(plan.renames[0].newName).toBe("C Mauro");
  });

  it("never renames onto a name owned by another product", () => {
    const plan = planAgoraFormatPrefixRenames(
      [
        { productId: 1296, name: "B Macán" },
        { productId: 2037675, name: "Macán" },
      ],
      [{ productId: 2037675, formatType: "BOTTLE" }],
    );

    expect(plan.renames).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("name_collision");
  });

  it("reports products missing from the catalog and unsupported formats", () => {
    const plan = planAgoraFormatPrefixRenames(
      [{ productId: 2037673, name: "Alión" }],
      [
        { productId: 999999, formatType: "BOTTLE" },
        { productId: 2037673, formatType: "HALF_BOTTLE" },
      ],
    );

    expect(plan.renames).toHaveLength(0);
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(["not_in_catalog", "unsupported_format"]);
  });

  it("truncates ButtonText to 20 characters keeping the prefix", () => {
    const plan = planAgoraFormatPrefixRenames(
      [{ productId: 2250853, name: "La Meulière Bourgogne La Closerie Berthereau" }],
      [{ productId: 2250853, formatType: "BOTTLE" }],
    );

    expect(plan.renames[0].buttonText).toBe("B La Meulière Bourgo");
    expect(plan.renames[0].buttonText).toHaveLength(20);
  });

  it("strips only a leading single-letter format prefix", () => {
    expect(stripAgoraFormatPrefix("  B   Alión ")).toBe("Alión");
    expect(stripAgoraFormatPrefix("Bodega Clásica")).toBe("Bodega Clásica");
  });
});
