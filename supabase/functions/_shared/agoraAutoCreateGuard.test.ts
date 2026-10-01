import { describe, expect, it } from "vitest";
import { applyAutoCreateCap, guardCreateFormats } from "./agoraAutoCreateGuard.ts";

const base = () => ({
  formats: ["BOTTLE", "GLASS"],
  trackedFormats: new Set<string>(),
  mappedFormats: new Set<string>(),
  expectedProductIdByFormat: new Map<string, string | null>([["BOTTLE", "1001"], ["GLASS", "2001"]]),
  existingAgoraProductIds: new Set<string>(),
});

describe("AUTO_CREATE guard", () => {
  it("creates only formats that do not exist anywhere", () => {
    expect(guardCreateFormats(base()).keep).toEqual(["BOTTLE", "GLASS"]);
  });
  it("never touches a product that already exists in Agora (Albariza copa case)", () => {
    const r = guardCreateFormats({ ...base(), existingAgoraProductIds: new Set(["2001"]) });
    expect(r.keep).toEqual(["BOTTLE"]);
    expect(r.dropped[0]).toContain("agora_product_exists");
  });
  it("skips formats with push_tracking or mapped agora_product_id", () => {
    const r = guardCreateFormats({ ...base(), trackedFormats: new Set(["BOTTLE"]), mappedFormats: new Set(["GLASS"]) });
    expect(r.keep).toEqual([]);
  });
  it("fails closed when Agora is unreadable or the id is unknown", () => {
    expect(guardCreateFormats({ ...base(), existingAgoraProductIds: null }).keep).toEqual([]);
    expect(guardCreateFormats({ ...base(), expectedProductIdByFormat: new Map() }).keep).toEqual([]);
  });
  it("queues nothing above 30 per cycle", () => {
    expect(applyAutoCreateCap(Array.from({ length: 31 }, (_, i) => i))).toEqual({ queue: [], capExceeded: true });
    expect(applyAutoCreateCap(Array.from({ length: 30 }, (_, i) => i)).queue).toHaveLength(30);
  });
});
