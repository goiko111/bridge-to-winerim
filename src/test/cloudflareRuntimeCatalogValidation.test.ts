import { describe, expect, it } from "vitest";
import { validateCatalogRequest } from "../../cloudflare/workers/middleware-runtime/src/handlers/catalog";

describe("Cloudflare runtime catalog request validation", () => {
  it("preserves legacy preview defaults without allowing a write", () => {
    expect(validateCatalogRequest({
      action: "preview-xml",
      connectionId: "connection-a",
      dryRun: false,
    })).toEqual({
      ok: true,
      request: {
        action: "preview-xml",
        canonicalAction: "preview",
        connectionId: "connection-a",
        dryRun: true,
        formats: ["BOTTLE", "MAGNUM"],
        wineSelection: { kind: "all" },
      },
    });
  });

  it("preserves xml-import bottle default and explicit dryRun", () => {
    expect(validateCatalogRequest({
      action: "xml-import",
      connectionId: "connection-a",
      dryRun: true,
      winerimWineIds: ["213744", "210280"],
    })).toEqual({
      ok: true,
      request: {
        action: "xml-import",
        canonicalAction: "apply",
        connectionId: "connection-a",
        dryRun: true,
        formats: ["BOTTLE"],
        wineSelection: { kind: "ids", ids: ["210280", "213744"] },
      },
    });
  });

  it("normalizes COPA and rejects unknown formats", () => {
    const normalized = validateCatalogRequest({
      action: "catalog.preview",
      connectionId: "connection-a",
      formats: ["copa", "bottle", "COPA"],
    });
    expect(normalized.ok && normalized.request.formats).toEqual(["GLASS", "BOTTLE"]);

    expect(validateCatalogRequest({
      action: "catalog.preview",
      connectionId: "connection-a",
      formats: ["JEROBOAM"],
    })).toMatchObject({ ok: false, result: { error: { code: "INVALID_FORMAT" } } });
  });

  it("rejects unsupported actions, unsafe connection IDs and duplicate wine IDs", () => {
    expect(validateCatalogRequest({ action: "delete-all", connectionId: "connection-a" }))
      .toMatchObject({ ok: false, result: { error: { code: "UNSUPPORTED_ACTION" } } });
    expect(validateCatalogRequest({ action: "catalog.preview", connectionId: "../secret" }))
      .toMatchObject({ ok: false, result: { error: { code: "INVALID_CONNECTION_ID" } } });
    expect(validateCatalogRequest({
      action: "catalog.preview",
      connectionId: "connection-a",
      wineIds: ["1", "1"],
    })).toMatchObject({ ok: false, result: { error: { code: "INVALID_WINE_SELECTION" } } });
    expect(validateCatalogRequest({
      action: "catalog.preview",
      connectionId: "connection-a",
      wineIds: ["0"],
    })).toMatchObject({ ok: false, result: { error: { code: "INVALID_WINE_SELECTION" } } });
    expect(validateCatalogRequest({
      action: "catalog.preview",
      connectionId: "connection-a",
      wineIds: [],
    })).toMatchObject({ ok: false, result: { error: { code: "INVALID_WINE_SELECTION" } } });
  });
});
