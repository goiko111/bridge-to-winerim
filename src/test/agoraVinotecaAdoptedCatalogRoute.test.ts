import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("supabase/functions/agora-proxy/index.ts", "utf8");

describe("adopted VINOTECA catalog routes", () => {
  it("uses persisted BASE metadata when BaseSaleFormatId differs from ProductId", () => {
    expect(SOURCE).toContain("status, metadata_json");
    expect(SOURCE).toContain('metadata.formatSource ?? ""');
    expect(SOURCE).toContain("explicitlyBase || saleFormatId === productId");
  });
});
