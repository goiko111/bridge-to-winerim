import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  inferHistoricalVariant,
  normalizeHistoricalWineName,
} from "../../scripts/backfill-agora-sales-history.mjs";

const backfillSource = readFileSync(
  resolve(process.cwd(), "scripts/backfill-agora-sales-history.mjs"),
  "utf8",
);

describe("Agora historical sales backfill matching", () => {
  it("normalizes legacy labels without losing the wine identity", () => {
    expect(normalizeHistoricalWineName("B Tomás Postigo 3º Año 2021")).toBe(
      "tomas postigo 3 ano",
    );
    expect(normalizeHistoricalWineName("COPA Cloe")).toBe("cloe");
    expect(normalizeHistoricalWineName("Juvé & Camps Essential Púrpura")).toBe(
      "juve y camps essential purpura",
    );
  });

  it("infers the Winerim variant from the Agora sale format", () => {
    expect(inferHistoricalVariant("MASSIMO - MENCÍA", "COPA MASSIMO")).toBe("GLASS");
    expect(inferHistoricalVariant("MALPASTOR", "MAGNUM MALPASTOR")).toBe("MAGNUM");
    expect(inferHistoricalVariant("FINCA RESALSO", "BOTELLA FINCA RESALSO")).toBe("BOTTLE");
  });

  it("requires every explicitly requested historical order id to exist", () => {
    expect(backfillSource).toContain('args["only-order-ids"]');
    expect(backfillSource).toContain("Requested historical orderIds not found");
  });

  it("enriches per-line import failures with the deterministic source sale", () => {
    expect(backfillSource).toContain("globalIndex:");
    expect(backfillSource).toContain("orderId: sale?.orderId");
    expect(backfillSource).toContain("audit: sale?.audit");
  });

  it("does not write history with a public key or an inactive Winerim wine", () => {
    expect(backfillSource).toContain(
      "Historical apply requires an explicit Lovable Cloud service-role key",
    );
    expect(backfillSource).toContain("resolution.wine.is_active === false");
    expect(backfillSource).toContain("sales/import cannot access its stockId");
  });
});
