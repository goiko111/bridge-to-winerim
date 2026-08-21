// ─────────────────────────────────────────────────────────────────────
// UPDATE comparator helpers for products that carry native sale formats
// ─────────────────────────────────────────────────────────────────────
// Root cause this module fixes: a flat scan of <Price> inside a Product
// element also picks up the <Price> nodes nested in
// <AdditionalSaleFormats><SaleFormat><Prices>. Because both maps are keyed
// only by PriceListId, the GLASS price overwrites the BOTTLE price on both
// sides of the diff, so an expected bottle 26.00 vs actual 25.00 collapsed
// to "3.10 === 3.10" and the evaluator answered update_skipped:no_agora_changes.
//
// The base Product prices (BOTTLE) and each SaleFormat (GLASS/MAGNUM) must be
// compared separately, always against the fresh Agora readback XML.

export function normalizeAgoraDiffMoney(value: unknown): string {
  const raw = String(value ?? "").trim().replace(",", ".");
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : raw;
}

const ADDITIONAL_SALE_FORMATS_RE = /<AdditionalSaleFormats\b[^>]*\/>|<AdditionalSaleFormats\b[^>]*>[\s\S]*?<\/AdditionalSaleFormats>/gi;
const SALE_FORMAT_RE = /<SaleFormat\b[^>]*\/>|<SaleFormat\b[^>]*>[\s\S]*?<\/SaleFormat>/gi;
const PRICE_RE = /<Price\b[^>]*\/?>/gi;

/** Product XML with every AdditionalSaleFormats block removed (base BOTTLE view). */
export function productXmlWithoutSaleFormats(productXml: string): string {
  return String(productXml ?? "").replace(ADDITIONAL_SALE_FORMATS_RE, "");
}

function priceMapFromFragment(fragment: string): Record<string, string> {
  const prices: Record<string, string> = {};
  for (const priceEl of String(fragment ?? "").match(PRICE_RE) || []) {
    const priceListId = /\bPriceListId="([^"]*)"/i.exec(priceEl)?.[1] || "";
    const mainPrice = /\bMainPrice="([^"]*)"/i.exec(priceEl)?.[1] ?? "";
    if (priceListId) prices[priceListId] = normalizeAgoraDiffMoney(mainPrice);
  }
  return prices;
}

/** Prices of the base Product only (nested sale formats excluded). */
export function baseProductPriceMap(productXml: string): Record<string, string> {
  return priceMapFromFragment(productXmlWithoutSaleFormats(productXml));
}

/** Price map per SaleFormatId inside AdditionalSaleFormats. */
export function saleFormatPriceMaps(productXml: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const block of String(productXml ?? "").match(ADDITIONAL_SALE_FORMATS_RE) || []) {
    for (const formatEl of block.match(SALE_FORMAT_RE) || []) {
      const id = /\bId="([^"]*)"/i.exec(formatEl)?.[1] || "";
      if (!id) continue;
      result[id] = priceMapFromFragment(formatEl);
    }
  }
  return result;
}

/**
 * Differences between expected and actual sale formats, compared by
 * SaleFormatId (never as an independent Product).
 */
export function saleFormatDifferenceReasons(
  expectedProductXml: string,
  actualProductXml: string,
  scopedPriceListIds: string[],
): string[] {
  const differences: string[] = [];
  const expectedFormats = saleFormatPriceMaps(expectedProductXml);
  const actualFormats = saleFormatPriceMaps(actualProductXml);

  for (const [saleFormatId, expectedPrices] of Object.entries(expectedFormats)) {
    const actualPrices = actualFormats[saleFormatId];
    if (!actualPrices) {
      differences.push(`SALE_FORMAT_${saleFormatId}_MISSING`);
      continue;
    }
    const priceListIds = scopedPriceListIds.length > 0
      ? scopedPriceListIds.filter((id) => Object.prototype.hasOwnProperty.call(expectedPrices, id))
      : Object.keys(expectedPrices);
    for (const priceListId of priceListIds) {
      if (!Object.prototype.hasOwnProperty.call(actualPrices, priceListId)) {
        differences.push(`SALE_FORMAT_${saleFormatId}_PRICE_LIST_${priceListId}_MISSING`);
      } else if (expectedPrices[priceListId] !== actualPrices[priceListId]) {
        differences.push(`SALE_FORMAT_${saleFormatId}_PRICE_LIST_${priceListId}_MISMATCH`);
      }
    }
  }

  return differences;
}
