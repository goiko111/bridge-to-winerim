import { describe, expect, it } from "vitest";
import { mergeAgoraHiddenGlassPolicy } from "../../supabase/functions/_shared/agoraHiddenGlassPolicy";

const hiddenPolicy = {
  winerim_id: "242224",
  name: "Old snapshot name",
  wine_type: "tinto",
  glass_sale_price: 3.2,
  bottle_sale_price: 19,
  publish_bottle: true,
  captured_at: "2026-07-20T14:02:48.734Z",
};

describe("Agora hidden GLASS live catalog precedence", () => {
  it("uses fresh independent BOTTLE and GLASS prices from one catalog event", () => {
    const merged = mergeAgoraHiddenGlassPolicy({
      name: "Live name",
      bottle_sale_price: 20,
      glass_sale_price: 3.3,
    }, hiddenPolicy);

    expect(merged.name).toBe("Live name");
    expect(merged.bottle_sale_price).toBe(20);
    expect(merged.glass_sale_price).toBe(3.3);
  });

  it("updates only GLASS without copying the bottle price into it", () => {
    const merged = mergeAgoraHiddenGlassPolicy({
      bottle_sale_price: 19,
      glass_sale_price: 4.1,
    }, hiddenPolicy);

    expect(merged.bottle_sale_price).toBe(19);
    expect(merged.glass_sale_price).toBe(4.1);
  });

  it("falls back once to the configured GLASS identity when live data is absent", () => {
    const first = mergeAgoraHiddenGlassPolicy({}, hiddenPolicy);
    const retry = mergeAgoraHiddenGlassPolicy({}, hiddenPolicy);

    expect(first).toEqual(retry);
    expect(first.glass_sale_price).toBe(3.2);
    expect(first._agora_allow_inactive_glass).toBe(true);
  });

  it("does not enable BOTTLE when the policy is glass-only", () => {
    const merged = mergeAgoraHiddenGlassPolicy(
      { bottle_sale_price: 25, glass_sale_price: 5 },
      { ...hiddenPolicy, publish_bottle: false },
    );

    expect(merged._agora_allow_inactive_bottle).toBe(false);
    expect(merged.bottle_sale_price).toBe(25);
  });

  it("marks live prices as authoritative over an obsolete snapshot", () => {
    const merged = mergeAgoraHiddenGlassPolicy({
      bottle_sale_price: 22,
      glass_sale_price: 3.5,
    }, hiddenPolicy);
    const marker = (merged.raw_payload as Record<string, Record<string, string>>)
      .agora_hidden_glass_variant;

    expect(marker.glass_price_source).toBe("WINERIM_LIVE_FORMAT_PRICE");
    expect(marker.bottle_price_source).toBe("WINERIM_LIVE_FORMAT_PRICE");
  });
});
