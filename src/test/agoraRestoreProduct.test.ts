import { describe, expect, it } from "vitest";
import { restoreAgoraProductXml } from "../../supabase/functions/_shared/agoraRestoreProduct.ts";

const prod = `<Product Id="1055795" Name="C Amontillado Fossi" FamilyId="3" Order="40" SaleableAsMain="false" UseAsDirectSale="false"><Prices><Price PriceListId="1" MainPrice="5.80" /><Price PriceListId="2" MainPrice="9.00" /></Prices></Product>`;

describe("restoreAgoraProductXml", () => {
  it("restores family, price list 1 and visibility only", () => {
    const r = restoreAgoraProductXml(prod, { FamilyId: "901954", SaleableAsMain: "true", UseAsDirectSale: "false" }, "5.00");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.xml).toContain('FamilyId="901954"');
    expect(r.xml).toContain('SaleableAsMain="true"');
    expect(r.xml).toContain('<Price PriceListId="1" MainPrice="5.00" />');
    expect(r.xml).toContain('<Price PriceListId="2" MainPrice="9.00" />');
    expect(r.xml).toContain('Name="C Amontillado Fossi"');
  });
  it("rejects attributes outside the allowlist and missing price lists", () => {
    expect(restoreAgoraProductXml(prod, { VatId: "1" }, undefined).ok).toBe(false);
    expect(restoreAgoraProductXml(prod, {}, "5", "7").ok).toBe(false);
  });
  it("restores Color and ButtonText without touching anything else", () => {
    const red = `<Product Id="973017" Name="C Habla de Ti" ButtonText="X" Color="#8B0000" FamilyId="901954"><Prices><Price PriceListId="1" MainPrice="4.20" /></Prices></Product>`;
    const r = restoreAgoraProductXml(red, { Color: "#FFFFFF", ButtonText: "C Habla de Ti Sauvig" }, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.xml).toContain('Color="#FFFFFF"');
    expect(r.xml).toContain('ButtonText="C Habla de Ti Sauvig"');
    expect(r.xml).toContain('FamilyId="901954"');
    expect(r.xml).toContain('MainPrice="4.20"');
  });
  it("rejects a non-hex color", () => {
    expect(restoreAgoraProductXml(prod, { Color: "red" }, undefined).ok).toBe(false);
  });
});
