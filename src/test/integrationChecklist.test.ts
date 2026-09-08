import { describe, expect, it } from "vitest";
import {
  getGoLiveBlockingItems,
  getIntegrationChecklist,
  getRequiredItems,
} from "@/lib/integrationChecklist";

describe("integration checklist", () => {
  it("defines Agora mandatory gates for catalog, sales and stock", () => {
    const checklist = getIntegrationChecklist("agora");
    const ids = checklist.items.map((item) => item.id);

    expect(ids).toContain("winerim-catalog-ready");
    expect(ids).toContain("mapped-sale");
    expect(ids).toContain("stock-deduction");
    expect(ids).toContain("idempotency");
    expect(getRequiredItems(checklist).length).toBeGreaterThan(10);
  });

  it("keeps monitoring required but outside go-live blocking count", () => {
    const checklist = getIntegrationChecklist("agora");
    const required = getRequiredItems(checklist);
    const goLiveBlocking = getGoLiveBlockingItems(checklist);

    expect(required.some((item) => item.id === "alerts")).toBe(true);
    expect(goLiveBlocking.some((item) => item.id === "alerts")).toBe(false);
  });

  it("has a lean REVO checklist with credential and mapping requirements", () => {
    const checklist = getIntegrationChecklist("revo");
    const requiredIds = getRequiredItems(checklist).map((item) => item.id);

    expect(requiredIds).toContain("revo-credentials");
    expect(requiredIds).toContain("mapping");
  });
});
