import { describe, expect, it } from "vitest";
import {
  buildDuplicateSafeAgoraProductNames,
  normalizeAgoraProductNameKey,
} from "../../supabase/functions/_shared/agoraProductNaming";

describe("Agora product naming", () => {
  it("keeps unique product names unchanged", () => {
    const names = buildDuplicateSafeAgoraProductNames([
      { productId: 739259, baseName: "B Alion", winerimId: 239259 },
      { productId: 939259, baseName: "C Alion", winerimId: 239259 },
    ]);

    expect(names["739259"]).toBe("B Alion");
    expect(names["939259"]).toBe("C Alion");
  });

  it("adds deterministic short suffixes to duplicated generated names", () => {
    const names = buildDuplicateSafeAgoraProductNames([
      { productId: 739259, baseName: "B Alion", winerimId: 239259 },
      { productId: 739276, baseName: "B Alion", winerimId: 239276 },
      { productId: 739408, baseName: "B Alion", winerimId: 239408 },
    ]);

    expect(names["739259"]).toBe("B Alion");
    expect(names["739276"]).toBe("B Alion 276");
    expect(names["739408"]).toBe("B Alion 408");
  });

  it("suffixes a generated name when the same name belongs to another existing product", () => {
    const names = buildDuplicateSafeAgoraProductNames(
      [{ productId: 739276, baseName: "B Alion", winerimId: 239276 }],
      [{ Id: 739259, Name: "B Alion" }],
    );

    expect(names["739276"]).toBe("B Alion 276");
  });

  it("allows keeping the same name when updating the same existing product", () => {
    const names = buildDuplicateSafeAgoraProductNames(
      [{ productId: 739259, baseName: "B Alion", winerimId: 239259 }],
      [{ Id: 739259, Name: "B Alion" }],
    );

    expect(names["739259"]).toBe("B Alion");
  });

  it("normalizes spacing and case when checking collisions", () => {
    expect(normalizeAgoraProductNameKey("  B   Alion  ")).toBe(normalizeAgoraProductNameKey("b alion"));
  });
});
