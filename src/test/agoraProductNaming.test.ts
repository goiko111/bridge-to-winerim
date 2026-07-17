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

  it("prefers a human vintage before falling back to an id suffix", () => {
    const names = buildDuplicateSafeAgoraProductNames(
      [{ productId: 665408, baseName: "B Prado Enea Gran Reserva", winerimId: 165408, disambiguators: [1998] }],
      [{ Id: 665407, Name: "B Prado Enea Gran Reserva" }],
    );

    expect(names["665408"]).toBe("B Prado Enea Gran Reserva 1998");
  });

  it("preserves the suffix already stored for the same product id", () => {
    const names = buildDuplicateSafeAgoraProductNames(
      [{ productId: 665408, baseName: "B Prado Enea Gran Reserva", winerimId: 165408, disambiguators: [1998] }],
      [
        { Id: 665407, Name: "B Prado Enea Gran Reserva" },
        { Id: 665408, Name: "B Prado Enea Gran Reserva 408" },
      ],
    );

    expect(names["665408"]).toBe("B Prado Enea Gran Reserva 408");
  });

  it("reassigns the base name deterministically when a generated sibling currently owns it", () => {
    const names = buildDuplicateSafeAgoraProductNames(
      [
        { productId: 656631, baseName: "B Ho·be", winerimId: 156631, disambiguators: [2019] },
        { productId: 670910, baseName: "B Ho·be", winerimId: 170910, disambiguators: [2019] },
      ],
      [
        { Id: 656631, Name: "B Ho·be 2019" },
        { Id: 670910, Name: "B Ho·be" },
      ],
    );

    expect(names["656631"]).toBe("B Ho·be");
    expect(names["670910"]).toBe("B Ho·be 2019");
  });

  it("allows keeping the same name when updating the same existing product", () => {
    const names = buildDuplicateSafeAgoraProductNames(
      [{ productId: 739259, baseName: "B Alion", winerimId: 239259 }],
      [{ Id: 739259, Name: "B Alion" }],
    );

    expect(names["739259"]).toBe("B Alion");
  });

  it("removes an obsolete suffix when no other current product owns the base name", () => {
    const names = buildDuplicateSafeAgoraProductNames(
      [{ productId: 763514, baseName: "B Allende Blanco", winerimId: 263514 }],
      [{ Id: 763514, Name: "B Allende Blanco 514" }],
    );

    expect(names["763514"]).toBe("B Allende Blanco");
  });

  it("normalizes spacing and case when checking collisions", () => {
    expect(normalizeAgoraProductNameKey("  B   Alion  ")).toBe(normalizeAgoraProductNameKey("b alion"));
    expect(normalizeAgoraProductNameKey("B Único")).toBe(normalizeAgoraProductNameKey("b unico"));
  });
});
