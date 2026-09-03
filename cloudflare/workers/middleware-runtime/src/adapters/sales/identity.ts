import type { ExactSalesLineIdentity, ExactSalesMapping } from "./types";

const SEPARATOR = "\u001f";

function text(value: unknown): string {
  const normalized = value === null || value === undefined ? "" : String(value).trim();
  return normalized === "0" ? "" : normalized;
}

export function exactSalesMappingKey(mapping: ExactSalesMapping): string {
  const saleFormatId = text(mapping.providerSaleFormatId);
  return saleFormatId
    ? `native${SEPARATOR}${text(mapping.providerProductId)}${SEPARATOR}${saleFormatId}`
    : `flat${SEPARATOR}${text(mapping.providerProductId)}`;
}

export function exactSalesLineKey(line: ExactSalesLineIdentity): string {
  const productId = text(line.providerProductId);
  const saleFormatId = text(line.saleFormatId);
  return productId && saleFormatId && productId !== saleFormatId
    ? `native${SEPARATOR}${productId}${SEPARATOR}${saleFormatId}`
    : `flat${SEPARATOR}${productId || saleFormatId}`;
}

export function exactSalesMappingIndex(
  mappings: readonly ExactSalesMapping[],
): ReadonlyMap<string, ExactSalesMapping> {
  const index = new Map<string, ExactSalesMapping>();
  for (const mapping of mappings) {
    const key = exactSalesMappingKey(mapping);
    if (!key.endsWith(SEPARATOR) && !index.has(key)) index.set(key, mapping);
  }
  return index;
}

/**
 * Native Agora groups are resolved only by the ProductId + SaleFormatId pair.
 * A SaleFormatId can equal an unrelated ProductId, so falling back to a flat
 * mapping when both native IDs are present would attribute the sale wrongly.
 */
export function exactSalesMappingForLine(
  index: ReadonlyMap<string, ExactSalesMapping>,
  line: ExactSalesLineIdentity,
  options: { requireNativePair?: boolean } = {},
): ExactSalesMapping | null {
  const productId = text(line.providerProductId);
  const saleFormatId = text(line.saleFormatId);
  if (productId && saleFormatId && productId !== saleFormatId) {
    const native = index.get(`native${SEPARATOR}${productId}${SEPARATOR}${saleFormatId}`);
    if (native) return native;
    if (options.requireNativePair) return null;
    return index.get(`flat${SEPARATOR}${productId}`)
      ?? index.get(`flat${SEPARATOR}${saleFormatId}`)
      ?? null;
  }
  return index.get(`flat${SEPARATOR}${productId || saleFormatId}`) ?? null;
}
