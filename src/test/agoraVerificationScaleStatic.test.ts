import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const agoraProxySource = readFileSync(
  resolve(repoRoot, "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);

describe("Agora catalog verification at fleet scale", () => {
  it("indexes the Products XML once instead of scanning it per mapping", () => {
    expect(agoraProxySource).toContain("const productXmlById = new Map");
    expect(agoraProxySource).toContain('extractXmlElementsWithAttrs(verifyXml, "Product")');
    expect(agoraProxySource).toContain("productXmlById.get(String(product.productId))");
    expect(agoraProxySource).not.toContain("verifyXml.match(productFullRegex)");
  });

  it("persists verification tracking in bounded batches", () => {
    expect(agoraProxySource).toContain("const trackingRows = (mappings || []).map");
    expect(agoraProxySource).toContain("offset += 250");
    expect(agoraProxySource).toContain('from("winerim_push_tracking")');
    expect(agoraProxySource).toContain("trackingPersistence");
  });

  it("paginates mappings and Winerim wines beyond the backend row limit", () => {
    expect(agoraProxySource).toContain("const verificationPageSize = 500");
    expect(agoraProxySource).toContain("const mappings: any[] = []");
    expect(agoraProxySource).toContain("const verificationWines: any[] = []");
    expect(agoraProxySource.match(/\.range\(offset, offset \+ verificationPageSize - 1\)/g) || []).toHaveLength(2);
    expect(agoraProxySource).toContain("Could not load product mappings for verification");
    expect(agoraProxySource).toContain("Could not load Winerim eligibility for tracking verification");
  });

  it("never treats a post-import NOT_FOUND as a successful write", () => {
    expect(agoraProxySource).toContain("post_import_verification_attempts");
    expect(agoraProxySource).toContain("verificationAttempts < 3");
    expect(agoraProxySource).toContain("Post-import verification failed:");
    expect(agoraProxySource).not.toContain("NOT_FOUND_POST_IMPORT");
    expect(agoraProxySource).not.toContain("import accepted, verification pending");
  });
});
