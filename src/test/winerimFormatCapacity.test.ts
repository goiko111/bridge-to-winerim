import { describe, expect, it } from "vitest";
import {
  parseLitersFromLabel,
  resolveWinerimFormatByCapacity,
  winerimFormatsForLiters,
} from "../../supabase/functions/_shared/winerimFormats";
import {
  EXTENDED_FORMATS_EXCLUDED_CONNECTION_IDS,
  isExtendedFormatsConnection,
  isFormatEnabledForConnection,
} from "../../supabase/functions/_shared/winerimExtendedFormats";
import { variantForAgoraFormat } from "../../supabase/functions/_shared/stockSyncUtils";

const OCEAN_CLUB = "706b952e-767d-41af-9cba-8e225b16a877";

describe("Winerim capacity equivalence", () => {
  it("parses capacities written the way POS buttons write them", () => {
    expect(parseLitersFromLabel("CLOE 3L")).toBe(3);
    expect(parseLitersFromLabel("VEUVE CLICQUOT 1,5 L")).toBe(1.5);
    expect(parseLitersFromLabel("BENJAMIN 20CL")).toBe(0.2);
    expect(parseLitersFromLabel("BOTELLA 750 ML")).toBe(0.75);
    expect(parseLitersFromLabel("RAMON BILBAO VERDEJO")).toBeNull();
  });

  it("knows that 3 L is both doble magnum and jeroboam", () => {
    expect(winerimFormatsForLiters(3).map((format) => format.key).sort())
      .toEqual(["DOUBLE_MAGNUM", "JEROBOAM"]);
  });

  it("resolves an unambiguous capacity on its own", () => {
    const resolved = resolveWinerimFormatByCapacity({ label: "DOM PERIGNON 6L" });
    expect(resolved.format).toBe("MATHUSALEM");
    expect(resolved.reason).toBe("capacity_unique");
  });

  it("narrows an ambiguous capacity with the formats the wine really has", () => {
    const resolved = resolveWinerimFormatByCapacity({
      label: "CLOE 3L",
      availableFormats: ["botella", "jeroboam"],
    });
    expect(resolved.format).toBe("JEROBOAM");
    expect(resolved.reason).toBe("capacity_narrowed_by_wine");
    expect(resolved.candidates.sort()).toEqual(["DOUBLE_MAGNUM", "JEROBOAM"]);
  });

  it("fails closed when the capacity stays ambiguous", () => {
    const resolved = resolveWinerimFormatByCapacity({
      label: "CLOE 3L",
      availableFormats: ["doble-magnum", "jeroboam"],
    });
    expect(resolved.format).toBeNull();
    expect(resolved.reason).toBe("capacity_ambiguous");
  });

  it("prefers the exact variant name over any capacity heuristic", () => {
    const resolved = resolveWinerimFormatByCapacity({ label: "jeroboam" });
    expect(resolved.format).toBe("JEROBOAM");
    expect(resolved.reason).toBe("exact_variant");
  });

  it("uses capacity only for unambiguous POS labels when deducting stock", () => {
    expect(variantForAgoraFormat("MENADE VERDEJO 6L")).toBe("matusalem");
    expect(variantForAgoraFormat("COPA 15CL")).toBe("copa");
    // 3 L is ambiguous without wine context: keep the historical bottle default.
    expect(variantForAgoraFormat("CLOE 3L")).toBe("botella");
  });
});

describe("extended format publishing gate", () => {
  it("publishes extended formats by default", () => {
    expect(isExtendedFormatsConnection("some-connection", {})).toBe(true);
    expect(isFormatEnabledForConnection("jeroboam", {}, "some-connection")).toBe(true);
  });

  it("holds Ocean Club back", () => {
    expect(EXTENDED_FORMATS_EXCLUDED_CONNECTION_IDS).toContain(OCEAN_CLUB);
    expect(isExtendedFormatsConnection(OCEAN_CLUB, {})).toBe(false);
    expect(isFormatEnabledForConnection("jeroboam", {}, OCEAN_CLUB)).toBe(false);
    // Legacy formats keep working everywhere, Ocean Club included.
    expect(isFormatEnabledForConnection("botella", {}, OCEAN_CLUB)).toBe(true);
    expect(isFormatEnabledForConnection("copa", {}, OCEAN_CLUB)).toBe(true);
  });

  it("honours explicit opt-outs", () => {
    expect(isExtendedFormatsConnection("x", { extended_formats_enabled: false })).toBe(false);
    expect(
      isFormatEnabledForConnection("jeroboam", { extended_formats_disabled_keys: ["jeroboam"] }, "x"),
    ).toBe(false);
    expect(
      isFormatEnabledForConnection("matusalem", { extended_formats_disabled_keys: ["jeroboam"] }, "x"),
    ).toBe(true);
  });
});
