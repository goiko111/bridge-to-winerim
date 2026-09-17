import { describe, expect, it } from "vitest";
import {
  normalizeSalesFormatOverrides,
  salesVariantForLine,
} from "../../supabase/functions/_shared/stockSyncUtils";

describe("per-button sales format overrides", () => {
  it("keeps only known Winerim variants", () => {
    expect(normalizeSalesFormatOverrides({ "680931": "botella-pequena", "1": "nope" }))
      .toEqual({ "680931": "botella-pequena" });
    expect(normalizeSalesFormatOverrides(null)).toEqual({});
    expect(normalizeSalesFormatOverrides(["botella"])).toEqual({});
  });

  it("uses the override instead of the POS label", () => {
    const overrides = normalizeSalesFormatOverrides({ "680931": "botella-pequena" });
    expect(salesVariantForLine({ provider_product_id: "680931", format: "BOT" }, overrides))
      .toBe("botella-pequena");
  });

  it("leaves every other button on the POS label", () => {
    const overrides = normalizeSalesFormatOverrides({ "680931": "botella-pequena" });
    expect(salesVariantForLine({ provider_product_id: "999", format: "BOT" }, overrides)).toBe("botella");
    expect(salesVariantForLine({ provider_product_id: "999", format: "COPA" }, overrides)).toBe("copa");
    expect(salesVariantForLine({ provider_product_id: "999", format: "BOT" })).toBe("botella");
  });
});
