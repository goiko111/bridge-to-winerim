import { describe, expect, it } from "vitest";
import {
  AGORA_BUTTON_TEXT_WINE_NAME_ONLY,
  AGORA_BUTTON_TEXT_WINE_NAME_WITH_FORMAT_SUFFIX,
  AGORA_SORT_ALPHABETICAL_WINE_NAME,
  agoraProductButtonText,
  agoraProductColor,
  buildAgoraGlassPresentation,
  buildUniqueAgoraButtonTexts,
  compareAgoraWineNames,
  nextAgoraGlassOrder,
  shouldSortAgoraProductsAlphabetically,
  stripAgoraFormatPrefix,
} from "../../supabase/functions/_shared/agoraProductPresentation";

const higueron = {
  provider_config: {
    agora_product_sort_mode: AGORA_SORT_ALPHABETICAL_WINE_NAME,
    agora_product_button_text_mode: AGORA_BUTTON_TEXT_WINE_NAME_ONLY,
  },
};

describe("Agora product presentation", () => {
  it("only enables alphabetical mode when explicitly configured", () => {
    expect(shouldSortAgoraProductsAlphabetically(higueron)).toBe(true);
    expect(shouldSortAgoraProductsAlphabetically({ provider_config: {} })).toBe(false);
  });

  it("preserves technical names by default", () => {
    expect(agoraProductButtonText({ provider_config: {} }, "B Prado Enea", 20)).toBe("B Prado Enea");
  });

  it("removes only the format prefix from the visible label", () => {
    expect(agoraProductButtonText(higueron, "C Albenc", 20)).toBe("Albenc");
    expect(agoraProductButtonText(higueron, "B Prado Enea Gran Reserva", 20)).toBe("Prado Enea Gran Rese");
    expect(stripAgoraFormatPrefix("MAGNUM 200 Monges")).toBe("200 Monges");
    expect(agoraProductButtonText(higueron, "B Albet I Noya Efecte 2017", 20)).toBe("Albet I Noya Efecte");
  });

  it("moves the technical format marker to a visible suffix", () => {
    const connection = {
      provider_config: {
        agora_product_button_text_mode: AGORA_BUTTON_TEXT_WINE_NAME_WITH_FORMAT_SUFFIX,
      },
    };
    expect(agoraProductButtonText(connection, "B Prado Enea", 20)).toBe("Prado Enea [B]");
    expect(agoraProductButtonText(connection, "C Prado Enea Gran Reserva", 20)).toBe("Prado Enea Gran [C]");
    expect(agoraProductButtonText(connection, "M Viña Real", 20)).toBe("Viña Real [M]");
  });

  it("uses configured colors and the agreed semantic defaults", () => {
    const connection = {
      provider_config: {
        agora_product_color_by_wine_type: {
          tinto: "#800040",
          espumoso: "#ff8080",
        },
      },
    };
    expect(agoraProductColor(connection, "Tinto")).toBe("#800040");
    expect(agoraProductColor(connection, "Champagne")).toBe("#FF8080");
    expect(agoraProductColor(connection, "Blanco")).toBe("#FFFFFF");
    expect(agoraProductColor(connection, "Rosado")).toBe("#DC82EF");
    expect(agoraProductColor(connection, "Generoso")).toBe("#F1C097");
    expect(agoraProductColor(connection, "Postre")).toBe("#F5A623");
    expect(agoraProductColor(connection, "desconocido")).toBe("#8B0000");
  });

  it("orders glasses by wine type and then by prefixless wine name", () => {
    expect(buildAgoraGlassPresentation({}, [
      { key: "sweet", name: "C Don PX", wineType: "postre" },
      { key: "white-b", name: "C Leirana", wineType: "blanco" },
      { key: "red", name: "C Clio", wineType: "tinto" },
      { key: "white-a", name: "C Albenc", wineType: "blanco" },
      { key: "fortified", name: "C Fino", wineType: "generoso" },
    ])).toEqual({
      red: { order: 100, color: "#800040" },
      "white-a": { order: 200, color: "#FFFFFF" },
      "white-b": { order: 300, color: "#FFFFFF" },
      fortified: { order: 400, color: "#F1C097" },
      sweet: { order: 500, color: "#F5A623" },
    });
  });

  it("places a new glass in an available alphabetical gap without moving existing glasses", () => {
    const existing = [
      { name: "C Albenc", wineType: "blanco", order: 200 },
      { name: "C Leirana", wineType: "blanco", order: 400 },
      { name: "C Clio", wineType: "tinto", order: 100 },
    ];
    expect(nextAgoraGlassOrder("blanco", "C Belondrade", existing)).toBe(300);
    expect(existing).toEqual([
      { name: "C Albenc", wineType: "blanco", order: 200 },
      { name: "C Leirana", wineType: "blanco", order: 400 },
      { name: "C Clio", wineType: "tinto", order: 100 },
    ]);
  });

  it("uses wine metadata rather than a stale product color", () => {
    expect(nextAgoraGlassOrder("blanco", "C Belondrade", [
      { name: "C Albenc", wineType: "blanco", order: 200 },
      { name: "C Leirana", wineType: "blanco", order: 400 },
      { name: "C Otro", wineType: "tinto", order: 300 },
    ])).toBe(300);
  });

  it("does not reuse an occupied order when there is no alphabetical gap", () => {
    expect(nextAgoraGlassOrder("blanco", "C Zorzal", [
      { name: "C Albenc", wineType: "blanco", order: 200 },
      { name: "C Tinto", wineType: "tinto", order: 201 },
      { name: "C Rosado", wineType: "rosado", order: 202 },
    ])).toBe(203);
  });

  it("keeps the format suffix when equal names need a stable disambiguator", () => {
    const connection = {
      provider_config: {
        agora_product_button_text_mode: AGORA_BUTTON_TEXT_WINE_NAME_WITH_FORMAT_SUFFIX,
      },
    };
    expect(buildUniqueAgoraButtonTexts(connection, [
      { key: "1", technicalName: "B Prado Enea" },
      { key: "2", technicalName: "B Prado Enea" },
    ])).toEqual({ "1": "Prado Enea 1 [B]", "2": "Prado Enea 2 [B]" });
  });

  it("sorts by the prefixless wine name", () => {
    const names = ["B Zuccardi", "C Albenc", "M Prado Enea"];
    expect(names.sort(compareAgoraWineNames)).toEqual(["C Albenc", "M Prado Enea", "B Zuccardi"]);
  });

  it("keeps existing unique abbreviations when truncated labels collide", () => {
    const firstPass = buildUniqueAgoraButtonTexts(higueron, [
      { key: "1", technicalName: "B Conde de San Cristobal Crz", existingButtonText: "B C de San Crist crz" },
      { key: "2", technicalName: "B Conde de San Cristóbal Reserva Especial", existingButtonText: "B C San Cristobal Rsv" },
    ]);
    expect(firstPass).toEqual({ "1": "C de San Crist crz", "2": "C San Cristobal Rsv" });
    expect(buildUniqueAgoraButtonTexts(higueron, [
      { key: "1", technicalName: "B Conde de San Cristobal Crz", existingButtonText: firstPass["1"] },
      { key: "2", technicalName: "B Conde de San Cristóbal Reserva Especial", existingButtonText: firstPass["2"] },
    ])).toEqual(firstPass);
  });

  it("preserves a distinguishing suffix when existing labels also collide", () => {
    expect(buildUniqueAgoraButtonTexts(higueron, [
      { key: "1", technicalName: "B Juvé & Camps Milesimé", existingButtonText: "B Juvé & Camps Miles" },
      { key: "2", technicalName: "B Juvé & Camps Milesimé Rosé", existingButtonText: "B Juvé & Camps Miles" },
    ])).toEqual({ "1": "Juvé Camps Milesimé", "2": "Juvé Camps Mile Rosé" });
  });
});
