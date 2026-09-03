import { describe, expect, it } from "vitest";
import {
  exactSalesMappingForLine,
  exactSalesMappingIndex,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/sales/identity";
import type { ExactSalesMapping } from "../../cloudflare/workers/middleware-runtime/src/adapters/sales/types";

function mapping(overrides: Partial<ExactSalesMapping>): ExactSalesMapping {
  return {
    mappingId: "mapping-1",
    mappingStatus: "CONFIRMED",
    providerProductId: "1762",
    providerProductName: "Perrier-Jouet Grand Brut",
    winerimWineId: "wine-perrier",
    variant: "BOTTLE",
    stockActive: false,
    ...overrides,
  };
}

describe("Agora native sales identity", () => {
  it("resolves a native product and sale-format pair exactly", () => {
    const index = exactSalesMappingIndex([
      mapping({ providerSaleFormatId: "1994", providerSaleFormatName: "Botella Perrier-Jouet" }),
    ]);
    expect(exactSalesMappingForLine(index, {
      providerProductId: "1762",
      saleFormatId: "1994",
    })?.winerimWineId).toBe("wine-perrier");
  });

  it("does not use a colliding flat ProductId for a native SaleFormatId", () => {
    const index = exactSalesMappingIndex([
      mapping({
        mappingId: "unrelated-product",
        providerProductId: "1994",
        providerProductName: "DOBEL DIAMANTE 50",
        winerimWineId: "unrelated",
      }),
    ]);
    expect(exactSalesMappingForLine(index, {
      providerProductId: "1762",
      saleFormatId: "1994",
    }, { requireNativePair: true })).toBeNull();
  });

  it("fails closed when the native pair is absent even if the parent is mapped", () => {
    const index = exactSalesMappingIndex([mapping({ providerSaleFormatId: undefined })]);
    expect(exactSalesMappingForLine(index, {
      providerProductId: "1762",
      saleFormatId: "1871",
    }, { requireNativePair: true })).toBeNull();
  });

  it("preserves legacy ProductId-first behavior until a connection opts in", () => {
    const index = exactSalesMappingIndex([
      mapping({ providerProductId: "1762", providerSaleFormatId: undefined }),
    ]);
    expect(exactSalesMappingForLine(index, {
      providerProductId: "1762",
      saleFormatId: "1871",
    })?.winerimWineId).toBe("wine-perrier");
  });

  it("preserves flat product mappings when Agora emits one effective ID", () => {
    const index = exactSalesMappingIndex([
      mapping({ providerProductId: "547593", providerSaleFormatId: undefined }),
    ]);
    expect(exactSalesMappingForLine(index, {
      providerProductId: "547593",
      saleFormatId: "547593",
    })?.winerimWineId).toBe("wine-perrier");
  });
});
