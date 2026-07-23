import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");
const agoraProxySource = readFileSync(
  resolve(repoRoot, "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);
const normalizeStart = agoraProxySource.indexOf(
  'if (action === "normalize-winerim-product-presentation")',
);
const normalizeEnd = agoraProxySource.indexOf(
  "// ── SA PEDRERA CONTROLLED TRIAL",
  normalizeStart,
);
const normalizeSource = agoraProxySource.slice(normalizeStart, normalizeEnd);
const restoreStart = agoraProxySource.indexOf(
  'if (action === "restore-winerim-product-presentation")',
);
const restoreSource = agoraProxySource.slice(restoreStart, normalizeEnd);
const deLaOOrchestratorSource = readFileSync(
  resolve(repoRoot, "scripts/de-la-o-agora-presentation-2026-07-23.mjs"),
  "utf8",
);

describe("Agora owned-product presentation policy", () => {
  it("requires an explicit confirmation before changing presentation", () => {
    expect(normalizeSource).toContain(
      'action === "normalize-winerim-product-presentation"',
    );
    expect(normalizeSource).toContain(
      'payload.confirm !== "NORMALIZE_WINERIM_PRESENTATION"',
    );
    expect(normalizeSource).toContain(
      "Production normalization requires confirm=NORMALIZE_WINERIM_PRESENTATION",
    );
  });

  it("limits writes to verified Winerim-owned products", () => {
    expect(normalizeSource).toContain('.eq("source", "WINERIM")');
    expect(normalizeSource).toContain(
      '.in("sync_status", ["VERIFIED", "PUSHED"])',
    );
    expect(normalizeSource).toContain(
      "Visible labels collide with non-Winerim products in a target family.",
    );
  });

  it("uses the cached Agora catalog reader and resilient writes", () => {
    expect(normalizeSource).toContain(
      "fetchAgoraProductsXmlCached(\n        connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true,",
    );
    expect(normalizeSource).toContain(
      'fetchWithRetry(`${baseUrlClean}/api/import/`, {',
    );
    expect(normalizeSource).toContain("productFailures");
    expect(normalizeSource).toContain("familyFailures");
  });

  it("keeps future queue writes behind a per-connection feature flag", () => {
    expect(agoraProxySource).toContain(
      ").agora_product_presentation_enabled === true",
    );
    expect(agoraProxySource).toContain(
      '? "normalize-winerim-product-presentation"',
    );
  });

  it("supports Spain DO and foreign-country routing with explicit fallbacks", () => {
    expect(agoraProxySource).toContain(
      '"WINE_TYPE_SPAIN_DO_FOREIGN_COUNTRY"',
    );
    expect(agoraProxySource).toContain('"OTRAS DO ESPAÑA"');
    expect(agoraProxySource).toContain('"OTROS PAÍSES"');
    expect(normalizeSource).toContain(
      "for (let attempt = 0; attempt < 100; attempt++)",
    );
  });

  it("produces a reversible rollback payload", () => {
    expect(normalizeSource).toContain("rollbackXml");
    expect(normalizeSource).toContain("rollbackFamilies");
    expect(normalizeSource).toContain("automaticRollback");
    expect(normalizeSource).toContain("body: rollbackXml");
    expect(normalizeSource).toContain(
      'setXmlAttrValue(family.xmlAfter, "ShowInPos", "false")',
    );
  });

  it("keeps manual rollback scoped and resilient", () => {
    expect(restoreSource).toContain("RESTORE_WINERIM_PRESENTATION");
    expect(restoreSource).toContain('.eq("source", "WINERIM")');
    expect(restoreSource).toContain(
      "PRESENTATION_ROLLBACK_CONTAINS_UNOWNED_PRODUCTS",
    );
    expect(restoreSource).toContain(
      "PRESENTATION_ROLLBACK_CONTAINS_UNSCOPED_FAMILIES",
    );
    expect(restoreSource).toContain(
      'fetchWithRetry(`${baseUrlClean}/api/import/`, {',
    );
    expect(restoreSource).toContain(
      "fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true)",
    );
  });

  it("allows only verified presentation differences during the staged rollout", () => {
    expect(deLaOOrchestratorSource).toContain(
      "function assertTransitionCatalog(context)",
    );
    expect(deLaOOrchestratorSource).toContain(
      '!["MATCH", "DIFFERENT"].includes',
    );
    expect(deLaOOrchestratorSource).toContain(
      "if (context.configMatchesTarget) assertTransitionCatalog(context)",
    );
    expect(deLaOOrchestratorSource).toContain(
      "assertExactCatalog(postContext)",
    );
  });
});
