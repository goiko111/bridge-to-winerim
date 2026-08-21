import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { trackingAgoraProductIdForFormat } from "../../supabase/functions/_shared/agoraVinotecaNativeFormats";

const PROXY = readFileSync("supabase/functions/agora-proxy/index.ts", "utf8");

describe("VINOTECA tracking identities", () => {
  it("persists 2363449 / 3363449 / 4363449 in native mode", () => {
    for (const [format, expected] of [["BOTTLE", "2363449"], ["GLASS", "3363449"], ["MAGNUM", "4363449"]]) {
      expect(trackingAgoraProductIdForFormat({
        vinotecaNativeFormats: true,
        format,
        winerimWineId: 363449,
        genericFallback: format === "GLASS" ? "1063449" : "863449",
      })).toBe(expected);
    }
  });

  it("never persists generic 500k/700k/900k ids in native mode", () => {
    const ids = ["BOTTLE", "GLASS", "MAGNUM"].map((format) =>
      trackingAgoraProductIdForFormat({
        vinotecaNativeFormats: true,
        format,
        winerimWineId: 363449,
        genericFallback: "863449",
      })
    );
    expect(ids).not.toContain("863449");
    expect(ids).not.toContain("1063449");
    expect(ids).not.toContain("1263449");
  });

  it("is idempotent across cycles", () => {
    const once = trackingAgoraProductIdForFormat({
      vinotecaNativeFormats: true, format: "GLASS", winerimWineId: 363449, genericFallback: "1063449",
    });
    const twice = trackingAgoraProductIdForFormat({
      vinotecaNativeFormats: true, format: "GLASS", winerimWineId: 363449, genericFallback: "1063449",
    });
    expect(twice).toBe(once);
  });

  it("leaves generic mode on its exact legacy fallback", () => {
    expect(trackingAgoraProductIdForFormat({
      vinotecaNativeFormats: false, format: "GLASS", winerimWineId: 363449, genericFallback: "1063449",
    })).toBe("1063449");
    expect(trackingAgoraProductIdForFormat({
      vinotecaNativeFormats: true, format: "UNKNOWN", winerimWineId: 363449, genericFallback: "563449",
    })).toBe("563449");
  });

  it("agora-proxy always passes an explicit agora_product_id on task tracking upserts", () => {
    const successBlock = PROXY.slice(PROXY.indexOf("PUSH TRACKING: Mark PUSHED"));
    expect(successBlock).toContain("trackingAgoraProductIdForFormat");
    const failBlock = PROXY.slice(PROXY.indexOf("PUSH TRACKING: Mark FAILED per format"));
    expect(failBlock.slice(0, 800)).toContain("trackingAgoraProductIdForFormat");
    expect(PROXY).toContain('vinotecaFormatId("BOTTLE", winerimWineId)');
  });
});
