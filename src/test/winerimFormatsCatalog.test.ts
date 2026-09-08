import {
  extractWinerimWineFormats,
  isLegacyWinerimFormat,
  parseWinerimFormatAgoraId,
  resolveWinerimFormat,
  winerimFormatAgoraId,
  winerimFormatKey,
  winerimFormatLabel,
  winerimFormatLiters,
  winerimVariantForFormat,
} from "../../supabase/functions/_shared/winerimFormats";

describe("Winerim format catalog", () => {
  it("resolves canonical keys and known aliases", () => {
    expect(resolveWinerimFormat("BOTTLE")?.key).toBe("BOTTLE");
    expect(resolveWinerimFormat("botella")?.key).toBe("BOTTLE");
    expect(resolveWinerimFormat("bottle")?.key).toBe("BOTTLE");
    expect(resolveWinerimFormat("GLASS")?.key).toBe("GLASS");
    expect(resolveWinerimFormat("copa")?.key).toBe("GLASS");
    expect(resolveWinerimFormat("glass")?.key).toBe("GLASS");
    expect(resolveWinerimFormat("MAGNUM")?.key).toBe("MAGNUM");
  });

  it("resolves extended formats and tolerates documented typos", () => {
    expect(resolveWinerimFormat("media-botella")?.key).toBe("HALF_BOTTLE");
    expect(resolveWinerimFormat("media botella")?.key).toBe("HALF_BOTTLE");
    expect(resolveWinerimFormat("botella-pequena")?.key).toBe("SMALL_BOTTLE");
    expect(resolveWinerimFormat("botella-pequeña")?.key).toBe("SMALL_BOTTLE");
    expect(resolveWinerimFormat("doble-magnum")?.key).toBe("DOUBLE_MAGNUM");
    expect(resolveWinerimFormat("jeroboham")?.key).toBe("JEROBOAM");
    expect(resolveWinerimFormat("rehoboham")?.key).toBe("REHOBOAM");
    expect(resolveWinerimFormat("salmanzar")?.key).toBe("SALMANAZAR");
    expect(resolveWinerimFormat("matusalén")?.key).toBe("MATHUSALEM");
  });

  it("returns null for unknown or empty variants", () => {
    expect(resolveWinerimFormat("")).toBeNull();
    expect(resolveWinerimFormat(null)).toBeNull();
    expect(resolveWinerimFormat(undefined)).toBeNull();
    expect(resolveWinerimFormat("garrafa")).toBeNull();
    expect(resolveWinerimFormat("copita")).toBeNull();
  });

  it("exposes labels, liters and canonical variants by key", () => {
    expect(winerimFormatLabel("HALF_BOTTLE")).toBe("Media botella");
    expect(winerimFormatLabel("SMALL_BOTTLE")).toBe("Botella pequeña");
    expect(winerimFormatLiters("JEROBOAM")).toBe(3);
    expect(winerimFormatLiters("DOUBLE_MAGNUM")).toBe(3);
    expect(winerimVariantForFormat("REHOBOAM")).toBe("rehoboam");
    expect(winerimFormatKey("botella")).toBe("BOTTLE");
    expect(winerimFormatKey("media-copa")).toBe("HALF_GLASS");
  });

  it("keeps legacy flag only on the original three formats", () => {
    expect(isLegacyWinerimFormat("BOTTLE")).toBe(true);
    expect(isLegacyWinerimFormat("GLASS")).toBe(true);
    expect(isLegacyWinerimFormat("MAGNUM")).toBe(true);
    for (const key of [
      "HALF_BOTTLE",
      "SMALL_BOTTLE",
      "BOTTLE_RETAIL",
      "BENJAMIN",
      "LITER",
      "LARGE_BOTTLE",
      "HALF_GLASS",
      "DOUBLE_MAGNUM",
      "JEROBOAM",
      "REHOBOAM",
      "MATHUSALEM",
      "SALMANAZAR",
      "BALTHAZAR",
      "NEBUCHADNEZZAR",
    ] as const) {
      expect(isLegacyWinerimFormat(key)).toBe(false);
    }
  });

  it("produces deterministic Agora ids in non-overlapping namespaces", () => {
    const wineId = 12345;
    const bottle = winerimFormatAgoraId("botella", wineId);
    const glass = winerimFormatAgoraId("copa", wineId);
    const magnum = winerimFormatAgoraId("magnum", wineId);
    const half = winerimFormatAgoraId("media-botella", wineId);
    const small = winerimFormatAgoraId("botella-pequena", wineId);

    expect(bottle).toBe("2012345");
    expect(glass).toBe("3012345");
    expect(magnum).toBe("4012345");
    expect(half).toBe("5012345");
    expect(small).toBe("6012345");

    const ids = [bottle, glass, magnum, half, small].filter(Boolean) as string[];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("round-trips deterministic ids through parseWinerimFormatAgoraId", () => {
    for (const [variant, wineId] of [
      ["botella", 1],
      ["copa", 999_999],
      ["magnum", 42],
      ["jeroboam", 77],
      ["nabucodonosor", 5],
    ] as const) {
      const agoraId = winerimFormatAgoraId(variant, wineId);
      expect(agoraId).not.toBeNull();
      const parsed = parseWinerimFormatAgoraId(agoraId);
      expect(parsed?.format).toBe(winerimFormatKey(variant));
      expect(parsed?.wineId).toBe(String(wineId));
    }
  });

  it("rejects ids outside the reserved namespaces", () => {
    expect(parseWinerimFormatAgoraId("12345")).toBeNull();
    expect(parseWinerimFormatAgoraId("1999999")).toBeNull();
    expect(parseWinerimFormatAgoraId("not-a-number")).toBeNull();
    expect(parseWinerimFormatAgoraId("")).toBeNull();
    // 19_000_000 + 1 is not a valid base (max is 18_000_000)
    expect(parseWinerimFormatAgoraId("19000001")).toBeNull();
  });

  it("extracts recognised price/stock rows and drops unknown variants", () => {
    const { rows, unknownVariants } = extractWinerimWineFormats([
      { variant: "botella", price: 30, costPrice: 10, erpStock: { id: 1000, stock: 12 }, active: true },
      { variant: "copa", price: 7.5, costPrice: 2.5, erpStock: { id: 1001, stock: 50 }, active: true },
      { variant: "media-botella", price: 18, costPrice: 6, erpStock: { id: 1002, stock: 6 }, active: true },
      { variant: "garrafa", price: 50, costPrice: 20, erpStock: { id: 1003, stock: 1 }, active: true },
      { variant: "", price: 1, active: true },
    ]);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.format_key).sort()).toEqual(["BOTTLE", "GLASS", "HALF_BOTTLE"]);

    const half = rows.find((r) => r.format_key === "HALF_BOTTLE");
    expect(half?.sale_price).toBe(18);
    expect(half?.cost_price).toBe(6);
    expect(half?.stock_id).toBe(1002);
    expect(half?.is_active).toBe(true);

    expect(unknownVariants).toEqual(["garrafa"]);
  });

  it("marks a format inactive when Winerim says so", () => {
    const { rows } = extractWinerimWineFormats([
      { variant: "botella", price: 30, active: true },
      { variant: "copa", price: 7.5, active: false },
      { variant: "media-botella", price: 18, isActive: false },
      { variant: "magnum", price: 60 },
    ]);

    const activeKeys = rows.filter((r) => r.is_active).map((r) => r.format_key).sort();
    expect(activeKeys).toEqual(["BOTTLE", "MAGNUM"]);
    expect(rows.find((r) => r.format_key === "GLASS")?.is_active).toBe(false);
    expect(rows.find((r) => r.format_key === "HALF_BOTTLE")?.is_active).toBe(false);
  });

  it("treats zero or missing price as non-publishable but still records the row", () => {
    const { rows } = extractWinerimWineFormats([
      { variant: "botella", price: 0, erpStock: { id: 1 }, active: true },
      { variant: "copa", price: null, erpStock: { id: 2 }, active: true },
      { variant: "magnum", active: true },
    ]);

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.sale_price === null)).toBe(true);
  });
});
