import { describe, expect, it } from "vitest";
import { restoreAgoraProductXml } from "../../supabase/functions/_shared/agoraRestoreProduct";

const xml = `<Product Id="1" Name="C X" PreparationTypeId="" PreparationOrderId="" Color="#800040"><Prices><Price PriceListId="1" MainPrice="5"/></Prices></Product>`;

describe("restore preparation pair", () => {
  it("sets both printer attrs and nothing else", () => {
    const r = restoreAgoraProductXml(xml, { PreparationTypeId: "1", PreparationOrderId: "1" }, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.xml).toBe(xml.replace('PreparationTypeId=""', 'PreparationTypeId="1"').replace('PreparationOrderId=""', 'PreparationOrderId="1"'));
  });
  it("rejects half pairs and empty values", () => {
    expect(restoreAgoraProductXml(xml, { PreparationTypeId: "1" }, undefined).ok).toBe(false);
    expect(restoreAgoraProductXml(xml, { PreparationTypeId: "", PreparationOrderId: "" }, undefined).ok).toBe(false);
  });
});
