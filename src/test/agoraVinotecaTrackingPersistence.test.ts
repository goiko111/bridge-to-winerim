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
    expect(PROXY).toContain("vinotecaFormatId(fmt, winerimWineId)");
  });

  it("keeps the native plan in scope until the outbound task is finalized", () => {
    const declaration = PROXY.indexOf("let vinotecaPlanForTask: VinotecaReferencePlan | null = null");
    const verificationTry = PROXY.indexOf("try {", declaration);
    const finalExternalId = PROXY.indexOf("vinotecaPlanForTask?.productId", verificationTry);

    expect(declaration).toBeGreaterThan(-1);
    expect(verificationTry).toBeGreaterThan(declaration);
    expect(finalExternalId).toBeGreaterThan(verificationTry);
    expect(PROXY).not.toContain("const vinotecaPlanForTask = vinotecaNativeFormatsTask");
  });

  it("persists the native ProductId and SaleFormatId route before task success", () => {
    const routePlan = PROXY.indexOf("const compoundMappings = vinotecaPlanForTask.formats.map");
    const routePersistence = PROXY.indexOf('.from("agora_sales_variant_mappings")', routePlan);
    const taskSuccess = PROXY.indexOf('status: "SUCCESS", last_error: null', routePersistence);

    expect(routePlan).toBeGreaterThan(-1);
    expect(routePersistence).toBeGreaterThan(-1);
    expect(PROXY.slice(routePlan, taskSuccess)).toContain("provider_product_id: vinotecaPlanForTask!.productId");
    expect(PROXY.slice(routePlan, taskSuccess)).toContain("sale_format_id: format.agoraId");
    expect(PROXY.slice(routePlan, taskSuccess)).toContain('formatSource: format.isBase ? "BASE" : "ADDITIONAL"');
    expect(PROXY.slice(routePersistence, taskSuccess)).toContain("VINOTECA_COMPOUND_ROUTE_PERSISTENCE_FAILED");
    expect(taskSuccess).toBeGreaterThan(routePersistence);
  });
});
