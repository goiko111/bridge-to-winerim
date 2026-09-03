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

  it("keeps GLASS by default and requires an explicit positive-price BOTTLE opt-in", () => {
    expect(proxySource).toContain(
      'if (format === "GLASS") return wine?._agora_allow_inactive_glass === true',
    );
    expect(proxySource).toContain('if (format === "BOTTLE") return wine?._agora_allow_inactive_bottle === true');
    expect(proxySource).toContain("configured.publish_bottle === true");
    expect(proxySource).toContain("allowInactiveBottle");
    expect(proxySource).toContain("const bottleSalePrice = configured.bottle_sale_price;");
    expect(proxySource).not.toContain(
      "const bottleSalePrice = configured.bottle_sale_price ?? extractBottleSalePrice(wine)",
    );
    expect(proxySource).toContain('if (format !== "BOTTLE" || configured.publish_bottle !== true) return false');
    expect(proxySource).toContain('if (format === "BOTTLE") return wine?._agora_allow_inactive_bottle === true');
    expect(proxySource).toContain("return false;");
  });

  it("keeps verification and read-only audit from reclassifying configured cups as retired", () => {
    expect(proxySource).toContain("const configuredInactiveFormat =");
    expect(proxySource).toContain("const hiddenGlassConfig = configuredHiddenGlassVariants(connection)");
    expect(proxySource).toContain("!configuredInactiveFormat && (");
    expect(proxySource).toContain('inactiveFormatAllowedByConnection(wine, "BOTTLE")');
    expect(proxySource).toContain(
      "activeOrConfiguredBottle && Number(extractBottleSalePrice(wine) || 0) > 0",
    );
    expect(proxySource).toContain(
      "wine.is_active !== false && Number(wine.magnum_sale_price || 0) > 0",
    );
  });

  it("keeps controlled reconciliation aligned with the same exception", () => {
    expect(reconciliationSource).toContain("mergeConfiguredHiddenGlassVariants(connection, cachedWineRows)");
    expect(reconciliationSource).toContain('format === "GLASS" && wine._agora_allow_inactive_glass === true');
    expect(reconciliationSource).toContain('format === "BOTTLE" && wine._agora_allow_inactive_bottle === true');
    expect(reconciliationSource).toContain('wine.is_active !== false || wine._agora_allow_inactive_bottle === true');
    expect(reconciliationSource).toContain('wine.is_active !== false && positive(wine.magnum_sale_price)');
  });
});
