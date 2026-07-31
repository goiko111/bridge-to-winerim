import { findEntryForVariant } from "./stockSyncUtils.ts";

type PriceEntry = {
  variant?: string;
  price?: number | string | null;
  erpStock?: {
    id?: number | string | null;
    stock?: number | string | null;
  } | null;
};

export interface NormalizedWinerimCatalogFields {
  wineType: string | null;
  bottleSalePrice: number | null;
  bottlePurchasePrice: number | null;
  glassSalePrice: number | null;
  glassCostPrice: number | null;
  magnumSalePrice: number | null;
  magnumPurchasePrice: number | null;
  serveByGlass: boolean;
  isActive: boolean;
  stockQuantity: number | string | null;
  bottleStockId: number | null;
  glassStockId: number | null;
  magnumStockId: number | null;
}

function toPositiveNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return number > 0 ? number : null;
}

function toFiniteId(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeWinerimCatalogFields(
  listWine: Record<string, unknown>,
  detail: Record<string, unknown> | null = null,
): NormalizedWinerimCatalogFields {
  const wine = { ...listWine, ...(detail || {}) } as Record<string, unknown>;
  const rawType = wine.type || wine.wine_type || wine.category || wine.style || wine.color || wine.colour;
  const wineType = rawType && typeof rawType === "string" && rawType.length > 0
    ? rawType.toLowerCase()
    : null;

  const prices = Array.isArray(wine.prices) ? wine.prices as PriceEntry[] : [];
  const bottleEntry = findEntryForVariant(prices, "botella") as PriceEntry | undefined;
  const glassEntry = findEntryForVariant(prices, "copa") as PriceEntry | undefined;
  const magnumEntry = findEntryForVariant(prices, "magnum") as PriceEntry | undefined;

  return {
    wineType,
    bottleSalePrice: toPositiveNumber(bottleEntry?.price) ??
      toPositiveNumber(wine.bottle_sale_price ?? wine.sale_price ?? wine.pvp ?? wine.price),
    bottlePurchasePrice: toPositiveNumber(
      wine.bottle_purchase_price ?? wine.purchase_price ?? wine.cost_price ?? wine.cost,
    ),
    glassSalePrice: toPositiveNumber(glassEntry?.price) ??
      toPositiveNumber(wine.glass_sale_price ?? wine.glass_price),
    glassCostPrice: toPositiveNumber(wine.glass_cost_price ?? wine.glass_cost),
    magnumSalePrice: toPositiveNumber(magnumEntry?.price) ?? toPositiveNumber(wine.magnum_sale_price),
    magnumPurchasePrice: toPositiveNumber(wine.magnum_purchase_price ?? wine.magnum_cost),
    serveByGlass: Boolean(
      glassEntry || wine.serve_by_glass === true || wine.by_glass === true || wine.copa === true,
    ),
    isActive: wine.active !== false && wine.is_active !== false && wine.status !== "inactive",
    stockQuantity: bottleEntry?.erpStock?.stock ?? null,
    bottleStockId: toFiniteId(bottleEntry?.erpStock?.id),
    glassStockId: toFiniteId(glassEntry?.erpStock?.id),
    magnumStockId: toFiniteId(magnumEntry?.erpStock?.id),
  };
}

export function canUseWinerimListPayloadAsDetailFallback(
  payload: Record<string, unknown> | null | undefined,
  failureReason: string | null | undefined,
): boolean {
  if (!payload || failureReason !== "detail_fetch_failed") return false;
  const normalized = normalizeWinerimCatalogFields(payload);
  return normalized.bottleSalePrice !== null ||
    normalized.glassSalePrice !== null ||
    normalized.magnumSalePrice !== null;
}
