import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");
const winerimProxySource = readFileSync(
  resolve(repoRoot, "supabase/functions/winerim-proxy/index.ts"),
  "utf8",
);

describe("Winerim catalog completion", () => {
  it("does not silently ignore last_catalog_sync_at persistence errors", () => {
    expect(winerimProxySource).toContain("catalogSyncTimestampError");
    expect(winerimProxySource).toContain(
      "Catalog enrichment completed but last_catalog_sync_at could not be saved",
    );
  });
});
