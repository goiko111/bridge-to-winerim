import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  inferHistoricalVariant,
  netHistoricalCandidates,
  normalizeHistoricalAliasDefinitions,
  normalizeHistoricalAliasLabel,
  normalizeHistoricalWineName,
  resolveHistoricalAlias,
} from "../../scripts/backfill-agora-sales-history.mjs";

const backfillSource = readFileSync(
  resolve(process.cwd(), "scripts/backfill-agora-sales-history.mjs"),
  "utf8",
);
const reportImporterSource = readFileSync(
  resolve(process.cwd(), "scripts/import-winerim-sales-report.mjs"),
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
    expect(inferHistoricalVariant("C. TARIMA SPARKLING", "C. TARIMA SPARKLING")).toBe("GLASS");
    expect(inferHistoricalVariant("MALPASTOR", "MAGNUM MALPASTOR")).toBe("MAGNUM");
    expect(inferHistoricalVariant("FINCA RESALSO", "BOTELLA FINCA RESALSO")).toBe("BOTTLE");
  });

  it("supports reviewed aliases with an explicit variant", () => {
    const definitions = normalizeHistoricalAliasDefinitions({
      "B. TARIMA SPARKLING": { winerimId: "272908", variant: "BOTTLE" },
      "C. TARIMA SPARKLING": { winerimId: "272908", variant: "GLASS" },
    });
    const wine = { winerim_id: "272908", name: "Tarima Sparkling" };
    const aliasMap = new Map<string, Array<Record<string, unknown>>>();
    for (const alias of definitions) {
      if (!aliasMap.has(alias.normalizedLabel)) aliasMap.set(alias.normalizedLabel, []);
      aliasMap.get(alias.normalizedLabel)?.push({ ...alias, wine });
    }

    expect(
      resolveHistoricalAlias(aliasMap, "C. TARIMA SPARKLING", "GLASS")?.variant,
    ).toBe("GLASS");
    expect(
      resolveHistoricalAlias(aliasMap, "B. TARIMA SPARKLING", "BOTTLE")?.variant,
    ).toBe("BOTTLE");
  });

  it("uses the only reviewed alias when the legacy label cannot infer its variant", () => {
    const [definition] = normalizeHistoricalAliasDefinitions({
      "TARIMA SPARKLING (Frizzante)": { winerimId: "272908", variant: "GLASS" },
    });
    const aliasMap = new Map([
      [
        definition.normalizedLabel,
        [{ ...definition, wine: { winerim_id: "272908", name: "Tarima Sparkling" } }],
      ],
    ]);

    expect(
      resolveHistoricalAlias(aliasMap, "TARIMA SPARKLING (Frizzante)", "BOTTLE")?.variant,
    ).toBe("GLASS");
  });

  it("nets the Agora ticket, refund and definitive invoice lifecycle", () => {
    const sale = {
      lifecycleKey: "2026-05-06|14:38|816",
      stockId: 318065,
      soldAt: "2026-05-06T14:38:14",
      audit: {
        documentId: "T-308",
        providerTotalAmount: 14.1,
      },
    };
    const result = netHistoricalCandidates([
      { ...sale, qty: 3, orderId: "ticket" },
      {
        ...sale,
        qty: -3,
        orderId: "refund",
        audit: { ...sale.audit, documentId: "F-9", providerTotalAmount: -14.1 },
      },
      {
        ...sale,
        qty: 3,
        orderId: "invoice",
        audit: { ...sale.audit, documentId: "F-5", providerTotalAmount: 14.1 },
      },
    ]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ qty: 3, orderId: "ticket" });
    expect(result.candidates[0].audit).toMatchObject({
      grossPositiveQty: 6,
      grossNegativeQty: 3,
      providerTotalAmount: 14.1,
      sourceDocumentIds: ["T-308", "F-9", "F-5"],
    });
    expect(result.netted).toHaveLength(1);
    expect(result.negative).toHaveLength(0);
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

  it("verifies that report imports do not mutate stock and are idempotent", () => {
    expect(reportImporterSource).toContain('report?.guarantees?.endpoint !== "/api/v2/sales/import"');
    expect(reportImporterSource).toContain("firstPassStockChanges");
    expect(reportImporterSource).toContain("secondPass.imported === 0");
    expect(reportImporterSource).not.toContain("method: \"PUT\"");
  });
});
