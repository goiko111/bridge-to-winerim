import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const proxySource = readFileSync(
  resolve(repoRoot, "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);
const reconciliationSource = readFileSync(
  resolve(repoRoot, "scripts/reconcile-agora-catalog.mjs"),
  "utf8",
);

describe("Agora hidden public-menu glass policy", () => {
  it("requires an explicit connection flag and a positive configured price", () => {
    expect(proxySource).toContain("providerConfig.publish_hidden_glass_variants !== true");
    expect(proxySource).toContain("glassSalePrice <= 0");
    expect(proxySource).toContain("agora_hidden_glass_variants");
  });

  it("only permits the inactive exception for GLASS", () => {
    expect(proxySource).toContain(
      'const inactiveGlassOverride = formatType === "GLASS" && wine._agora_allow_inactive_glass === true',
    );
    expect(proxySource).toContain('fmt === "GLASS" && isConfiguredHiddenGlassVariant(connection, wineId)');
    expect(proxySource).toContain("inactive_public_menu_glass_published_by_connection_policy");
  });

  it("keeps verification and read-only audit from reclassifying configured cups as retired", () => {
    expect(proxySource).toContain("const configuredHiddenGlass =");
    expect(proxySource).toContain("const hiddenGlassConfig = configuredHiddenGlassVariants(connection)");
    expect(proxySource).toContain("!configuredHiddenGlass && (");
  });

  it("keeps controlled reconciliation aligned with the same exception", () => {
    expect(reconciliationSource).toContain("mergeConfiguredHiddenGlassVariants(connection, cachedWineRows)");
    expect(reconciliationSource).toContain('format === "GLASS" && wine._agora_allow_inactive_glass === true');
    expect(reconciliationSource).toContain('wine.is_active !== false && positive(wine.bottle_sale_price)');
  });
});
