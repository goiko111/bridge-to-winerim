// ─────────────────────────────────────────────────────────────────────
// Post-import verification for VINOTECA_REGION_REFERENCE_NATIVE_FORMATS
// ─────────────────────────────────────────────────────────────────────
// Root cause this module fixes: the generic post-import verifier rebuilt
// product identities as 500000+wineId (BOTTLE) / 700000+wineId (GLASS) and
// looked every format up as a top-level <Product>. In VINOTECA native-format
// mode the accepted contract is a single base Product 2_000_000+wineId whose
// GLASS/MAGNUM live inside <AdditionalSaleFormats><SaleFormat Id="3m/4m">.
// A successful import therefore failed verification with
// "Product 863449 (BOTTLE ...) not found; Product 1063449 (GLASS ...) not found".
//
// This verifier reuses the builder's own plan/identities and the exact XML that
// was sent, and compares it against the fresh Agora readback.

import {
  VINOTECA_PREPARATION_ORDER_ID,
  VINOTECA_PREPARATION_TYPE_ID,
  type VinotecaReferencePlan,
} from "./agoraVinotecaNativeFormats.ts";
import {
  baseProductPriceMap,
  normalizeAgoraDiffMoney,
  saleFormatPriceMaps,
} from "./agoraVinotecaProductDiff.ts";

export type VinotecaVerifyIssue = {
  code: string;
  message: string;
  field?: string;
  context?: Record<string, unknown>;
};

export type VinotecaVerifyResult = {
  success: boolean;
  verified_exists: boolean;
  verified_prices: boolean;
  verified_family: boolean;
  verified_preparation: boolean;
  verified_scope: boolean;
  errors: VinotecaVerifyIssue[];
  warnings: VinotecaVerifyIssue[];
  missing_prices: {
    product_erp_id: string;
    agora_product_id: string;
    price_list_id: string;
    price_list_name: string;
    issue: "missing" | "zero" | "invalid";
    name: string;
    format: string;
    affected_sale_centers: string[];
  }[];
  affected_sale_centers: string[];
  summary: { checked: number; ok: number; failed: number };
  verification_contract: string;
};

const PRODUCT_RE = /<Product\b[^>]*\/>|<Product\b[^>]*>[\s\S]*?<\/Product>/gi;

/** Product element (opening attributes + full XML) indexed by Id. */
export function indexProductsById(xml: string): Map<string, { attrs: string; xml: string }> {
  const index = new Map<string, { attrs: string; xml: string }>();
  for (const element of String(xml ?? "").match(PRODUCT_RE) || []) {
    const attrs = /^<Product\b([^>]*?)\/?>/i.exec(element)?.[1] || "";
    const id = /\bId="([^"]*)"/i.exec(attrs)?.[1] || "";
    if (id) index.set(id, { attrs, xml: element });
  }
  return index;
}

function attr(attrs: string, name: string): string {
  return new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs)?.[1] ?? "";
}

function isTruthyAgoraFlag(value: string): boolean {
  return ["true", "1"].includes(String(value || "").trim().toLowerCase());
}

function saleFormatElements(productXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const blocks = String(productXml ?? "").match(
    /<AdditionalSaleFormats\b[^>]*>[\s\S]*?<\/AdditionalSaleFormats>/gi,
  ) || [];
  for (const block of blocks) {
    for (const element of block.match(/<SaleFormat\b[^>]*\/>|<SaleFormat\b[^>]*>[\s\S]*?<\/SaleFormat>/gi) || []) {
      const attrs = /^<SaleFormat\b([^>]*?)\/?>/i.exec(element)?.[1] || "";
      const id = attr(attrs, "Id");
      if (id) map.set(id, element);
    }
  }
  return map;
}

/**
 * Verifies a VINOTECA native-format import against the fresh Agora readback,
 * using the very same expected XML the builder produced.
 */
export function verifyVinotecaNativeFormatsImport(params: {
  plan: VinotecaReferencePlan;
  sentXml: string;
  actualXml: string;
  scopedPriceLists: { id: string; name: string }[];
  priceListToSaleCenters: Record<string, string[]>;
}): VinotecaVerifyResult {
  const { plan, sentXml, actualXml, scopedPriceLists, priceListToSaleCenters } = params;

  const result: VinotecaVerifyResult = {
    success: true,
    verified_exists: true,
    verified_prices: true,
    verified_family: true,
    verified_preparation: true,
    verified_scope: scopedPriceLists.length > 0,
    errors: [],
    warnings: [],
    missing_prices: [],
    affected_sale_centers: [],
    summary: { checked: 0, ok: 0, failed: 0 },
    verification_contract: "VINOTECA_REGION_REFERENCE_NATIVE_FORMATS",
  };

  const fail = (issue: VinotecaVerifyIssue) => {
    result.success = false;
    result.errors.push(issue);
  };

  const noteAffected = (priceListId: string) => {
    for (const sc of priceListToSaleCenters[priceListId] || []) {
      if (!result.affected_sale_centers.includes(sc)) result.affected_sale_centers.push(sc);
    }
  };

  if (scopedPriceLists.length === 0) {
    fail({
      code: "VERIFY_SCOPE_EMPTY",
      message: "No relevant PriceLists resolved from current SaleCenter scope",
      field: "verification_scope",
    });
  }

  const expected = indexProductsById(sentXml).get(plan.productId);
  const actual = indexProductsById(actualXml).get(plan.productId);

  result.summary.checked = plan.formats.length;

  if (!expected) {
    fail({
      code: "VERIFY_EXPECTED_XML_MISSING",
      message: `Expected Product ${plan.productId} not present in the imported XML`,
      context: { productId: plan.productId },
    });
    result.summary.failed = plan.formats.length;
    return result;
  }

  if (!actual) {
    result.verified_exists = false;
    result.summary.failed = plan.formats.length;
    fail({
      code: "NOT_FOUND",
      message: `Product ${plan.productId} (${plan.baseFormat} ${plan.wineName}) not found in Agora`,
      context: { productId: plan.productId, format: plan.baseFormat },
    });
    for (const pl of scopedPriceLists) {
      result.missing_prices.push({
        product_erp_id: `${plan.winerimWineId}:${plan.baseFormat}`,
        agora_product_id: plan.productId,
        price_list_id: pl.id,
        price_list_name: pl.name,
        issue: "missing",
        name: plan.wineName,
        format: plan.baseFormat,
        affected_sale_centers: priceListToSaleCenters[pl.id] || [],
      });
      noteAffected(pl.id);
    }
    return result;
  }

  let baseOk = true;

  // ── Family ──
  const expectedFamilyId = attr(expected.attrs, "FamilyId");
  const actualFamilyId = attr(actual.attrs, "FamilyId");
  if (expectedFamilyId && actualFamilyId !== expectedFamilyId) {
    baseOk = false;
    result.verified_family = false;
    fail({
      code: "FAMILY_MISMATCH",
      message: `Product ${plan.productId}: expected FamilyId ${expectedFamilyId}, got ${actualFamilyId || "(empty)"}`,
      field: "FamilyId",
      context: { productId: plan.productId, expected: expectedFamilyId, actual: actualFamilyId },
    });
  }

  // ── Visibility ──
  const visible = isTruthyAgoraFlag(attr(actual.attrs, "SaleableAsMain")) ||
    isTruthyAgoraFlag(attr(actual.attrs, "UseAsDirectSale"));
  if (!visible) {
    baseOk = false;
    fail({
      code: "PRODUCT_NOT_VISIBLE",
      message: `Product ${plan.productId} is not saleable in Agora (SaleableAsMain/UseAsDirectSale false)`,
      field: "SaleableAsMain",
      context: { productId: plan.productId },
    });
  }

  // ── Preparation (base Product only) ──
  const actualPrepType = attr(actual.attrs, "PreparationTypeId");
  const actualPrepOrder = attr(actual.attrs, "PreparationOrderId");
  if (actualPrepType !== VINOTECA_PREPARATION_TYPE_ID || actualPrepOrder !== VINOTECA_PREPARATION_ORDER_ID) {
    baseOk = false;
    result.verified_preparation = false;
    fail({
      code: "PREPARATION_MISMATCH",
      message: `Product ${plan.productId}: expected PreparationTypeId ${VINOTECA_PREPARATION_TYPE_ID}/PreparationOrderId ${VINOTECA_PREPARATION_ORDER_ID}, got ${actualPrepType || "(empty)"}/${actualPrepOrder || "(empty)"}`,
      field: "PreparationTypeId",
      context: {
        productId: plan.productId,
        actualPreparationTypeId: actualPrepType,
        actualPreparationOrderId: actualPrepOrder,
      },
    });
  }

  // ── Base Product prices, sale-format prices excluded ──
  const expectedBasePrices = baseProductPriceMap(expected.xml);
  const actualBasePrices = baseProductPriceMap(actual.xml);
  const priceListIds = scopedPriceLists.length > 0
    ? scopedPriceLists.filter((pl) => Object.prototype.hasOwnProperty.call(expectedBasePrices, pl.id))
    : Object.keys(expectedBasePrices).map((id) => ({ id, name: id }));

  for (const pl of priceListIds) {
    const expectedPrice = expectedBasePrices[pl.id];
    const actualPrice = actualBasePrices[pl.id];
    if (actualPrice === undefined) {
      baseOk = false;
      result.verified_prices = false;
      fail({
        code: "PRICE_MISSING",
        message: `Product ${plan.productId}: missing price for PriceList ${pl.id} (${pl.name})`,
        field: "MainPrice",
        context: { productId: plan.productId, priceListId: pl.id, format: plan.baseFormat },
      });
      result.missing_prices.push({
        product_erp_id: `${plan.winerimWineId}:${plan.baseFormat}`,
        agora_product_id: plan.productId,
        price_list_id: pl.id,
        price_list_name: pl.name,
        issue: "missing",
        name: plan.wineName,
        format: plan.baseFormat,
        affected_sale_centers: priceListToSaleCenters[pl.id] || [],
      });
      noteAffected(pl.id);
      continue;
    }
    if (Number(actualPrice) <= 0) {
      baseOk = false;
      result.verified_prices = false;
      fail({
        code: "PRICE_ZERO",
        message: `Product ${plan.productId}: PriceList ${pl.id} (${pl.name}) stored a non-positive price ${actualPrice}`,
        field: "MainPrice",
        context: { productId: plan.productId, priceListId: pl.id, format: plan.baseFormat },
      });
      result.missing_prices.push({
        product_erp_id: `${plan.winerimWineId}:${plan.baseFormat}`,
        agora_product_id: plan.productId,
        price_list_id: pl.id,
        price_list_name: pl.name,
        issue: "zero",
        name: plan.wineName,
        format: plan.baseFormat,
        affected_sale_centers: priceListToSaleCenters[pl.id] || [],
      });
      noteAffected(pl.id);
      continue;
    }
    if (actualPrice !== expectedPrice) {
      baseOk = false;
      result.verified_prices = false;
      fail({
        code: "PRICE_MISMATCH",
        message: `Product ${plan.productId}: PriceList ${pl.id} (${pl.name}) expected ${expectedPrice}, got ${actualPrice}`,
        field: "MainPrice",
        context: {
          productId: plan.productId, priceListId: pl.id, format: plan.baseFormat,
          expected: expectedPrice, actual: actualPrice,
        },
      });
      result.missing_prices.push({
        product_erp_id: `${plan.winerimWineId}:${plan.baseFormat}`,
        agora_product_id: plan.productId,
        price_list_id: pl.id,
        price_list_name: pl.name,
        issue: "invalid",
        name: plan.wineName,
        format: plan.baseFormat,
        affected_sale_centers: priceListToSaleCenters[pl.id] || [],
      });
      noteAffected(pl.id);
    }
  }

  if (baseOk) result.summary.ok++;
  else result.summary.failed++;

  // ── Native sale formats (GLASS / MAGNUM) inside AdditionalSaleFormats ──
  const expectedFormatEls = saleFormatElements(expected.xml);
  const actualFormatEls = saleFormatElements(actual.xml);
  const expectedFormatPrices = saleFormatPriceMaps(expected.xml);
  const actualFormatPrices = saleFormatPriceMaps(actual.xml);

  for (const format of plan.formats.filter((f) => !f.isBase)) {
    let formatOk = true;
    const actualEl = actualFormatEls.get(format.agoraId);

    if (!actualEl) {
      formatOk = false;
      result.verified_exists = false;
      fail({
        code: "SALE_FORMAT_NOT_FOUND",
        message: `SaleFormat ${format.agoraId} (${format.format} ${plan.wineName}) not found in AdditionalSaleFormats of Product ${plan.productId}`,
        context: { productId: plan.productId, saleFormatId: format.agoraId, format: format.format },
      });
      result.summary.failed++;
      continue;
    }

    const expectedAttrs = /^<SaleFormat\b([^>]*?)\/?>/i.exec(expectedFormatEls.get(format.agoraId) || "")?.[1] || "";
    const actualAttrs = /^<SaleFormat\b([^>]*?)\/?>/i.exec(actualEl)?.[1] || "";

    const expectedRatio = normalizeAgoraDiffMoney(attr(expectedAttrs, "Ratio"));
    const actualRatio = normalizeAgoraDiffMoney(attr(actualAttrs, "Ratio"));
    if (expectedRatio && actualRatio !== expectedRatio) {
      formatOk = false;
      fail({
        code: "SALE_FORMAT_RATIO_MISMATCH",
        message: `SaleFormat ${format.agoraId}: expected Ratio ${expectedRatio}, got ${actualRatio || "(empty)"}`,
        field: "Ratio",
        context: { saleFormatId: format.agoraId, expected: expectedRatio, actual: actualRatio },
      });
    }

    const hiddenFlag = attr(actualAttrs, "Hidden");
    const saleableFlag = attr(actualAttrs, "SaleableAsMain");
    if (isTruthyAgoraFlag(hiddenFlag) || (saleableFlag && !isTruthyAgoraFlag(saleableFlag))) {
      formatOk = false;
      fail({
        code: "SALE_FORMAT_NOT_VISIBLE",
        message: `SaleFormat ${format.agoraId} (${format.format}) is not visible in Agora`,
        field: "SaleableAsMain",
        context: { saleFormatId: format.agoraId, hidden: hiddenFlag, saleableAsMain: saleableFlag },
      });
    }

    const expectedPrices = expectedFormatPrices[format.agoraId] || {};
    const actualPrices = actualFormatPrices[format.agoraId] || {};
    const formatPriceLists = scopedPriceLists.length > 0
      ? scopedPriceLists.filter((pl) => Object.prototype.hasOwnProperty.call(expectedPrices, pl.id))
      : Object.keys(expectedPrices).map((id) => ({ id, name: id }));

    for (const pl of formatPriceLists) {
      const actualPrice = actualPrices[pl.id];
      if (actualPrice === undefined) {
        formatOk = false;
        result.verified_prices = false;
        fail({
          code: "SALE_FORMAT_PRICE_MISSING",
          message: `SaleFormat ${format.agoraId}: missing price for PriceList ${pl.id} (${pl.name})`,
          field: "MainPrice",
          context: { saleFormatId: format.agoraId, priceListId: pl.id, format: format.format },
        });
        result.missing_prices.push({
          product_erp_id: `${plan.winerimWineId}:${format.format}`,
          agora_product_id: format.agoraId,
          price_list_id: pl.id,
          price_list_name: pl.name,
          issue: "missing",
          name: plan.wineName,
          format: format.format,
          affected_sale_centers: priceListToSaleCenters[pl.id] || [],
        });
        noteAffected(pl.id);
        continue;
      }
      if (Number(actualPrice) <= 0 || actualPrice !== expectedPrices[pl.id]) {
        formatOk = false;
        result.verified_prices = false;
        fail({
          code: Number(actualPrice) <= 0 ? "SALE_FORMAT_PRICE_ZERO" : "SALE_FORMAT_PRICE_MISMATCH",
          message: `SaleFormat ${format.agoraId}: PriceList ${pl.id} (${pl.name}) expected ${expectedPrices[pl.id]}, got ${actualPrice}`,
          field: "MainPrice",
          context: {
            saleFormatId: format.agoraId, priceListId: pl.id, format: format.format,
            expected: expectedPrices[pl.id], actual: actualPrice,
          },
        });
        result.missing_prices.push({
          product_erp_id: `${plan.winerimWineId}:${format.format}`,
          agora_product_id: format.agoraId,
          price_list_id: pl.id,
          price_list_name: pl.name,
          issue: Number(actualPrice) <= 0 ? "zero" : "invalid",
          name: plan.wineName,
          format: format.format,
          affected_sale_centers: priceListToSaleCenters[pl.id] || [],
        });
        noteAffected(pl.id);
      }
    }

    if (formatOk) result.summary.ok++;
    else result.summary.failed++;
  }

  return result;
}
