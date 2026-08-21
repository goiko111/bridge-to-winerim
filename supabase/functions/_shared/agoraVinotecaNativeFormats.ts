// ─────────────────────────────────────────────────────────────────────
// VINOTECA_REGION_REFERENCE_NATIVE_FORMATS (Don Bernardo only)
// ─────────────────────────────────────────────────────────────────────
// Presentation contract, strictly gated by connection_id allowlist:
//   VINOTECA ABIERTA > <exact region> > <wine reference>
//   BOTTLE  -> Agora ProductId    = 2000000 + winerimWineId
//   GLASS   -> Agora SaleFormatId = 3000000 + winerimWineId
//   MAGNUM  -> Agora SaleFormatId = 4000000 + winerimWineId
//   PreparationTypeId = 6, PreparationOrderId = 2
// Fail-closed: a wine without an exact region, without a valid bottle price,
// or without a resolvable format is skipped with an explicit reason. No
// fallback family, no invented price, no partial reference.

export const VINOTECA_REGION_REFERENCE_NATIVE_FORMATS = "VINOTECA_REGION_REFERENCE_NATIVE_FORMATS";

export const VINOTECA_NATIVE_FORMATS_CONNECTION_IDS: readonly string[] = [
  "a700d425-9194-4758-95ff-7fee86419e14", // Don Bernardo Ponzano
  "79280cb8-0fe7-4a57-93a4-04172205ac70", // Don Bernardo Santander
];

export const VINOTECA_ROOT_FAMILY_NAME = "VINOTECA ABIERTA";
export const VINOTECA_PREPARATION_TYPE_ID = "6";
export const VINOTECA_PREPARATION_ORDER_ID = "2";

export const VINOTECA_FORMAT_ID_BASE: Record<string, number> = {
  BOTTLE: 2000000,
  GLASS: 3000000,
  MAGNUM: 4000000,
};

export type VinotecaFormat = "BOTTLE" | "GLASS" | "MAGNUM";

export function isVinotecaNativeFormatsConnection(
  connectionId: unknown,
  providerConfig: Record<string, unknown> | null | undefined,
): boolean {
  const id = String(connectionId ?? "").trim().toLowerCase();
  if (!VINOTECA_NATIVE_FORMATS_CONNECTION_IDS.includes(id)) return false;
  const mode = String(providerConfig?.family_structure_mode ?? "").trim().toUpperCase();
  return mode === VINOTECA_REGION_REFERENCE_NATIVE_FORMATS;
}

export function normalizeVinotecaWineId(wineId: unknown): number | null {
  const value = Number(wineId);
  if (!Number.isInteger(value) || value <= 0 || value >= 1_000_000) return null;
  return value;
}

/** Deterministic Agora identity for a format. Fail-closed on invalid input. */
export function vinotecaFormatId(format: unknown, wineId: unknown): string | null {
  const normalizedFormat = String(format ?? "").trim().toUpperCase();
  const base = VINOTECA_FORMAT_ID_BASE[normalizedFormat];
  const id = normalizeVinotecaWineId(wineId);
  if (!base || id === null) return null;
  return String(base + id);
}

/**
 * Inverse of vinotecaFormatId: recognises ONLY ids inside our deterministic
 * namespaces (BOTTLE 2M+id, GLASS 3M+id, MAGNUM 4M+id). Any legacy/low Agora id
 * returns null so it can never be used as a preferred flat lookup key.
 */
export function parseVinotecaNativeId(
  value: unknown,
): { format: VinotecaFormat; wineId: string; agoraId: string } | null {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const numeric = Number(raw);
  if (!Number.isInteger(numeric)) return null;
  for (const [format, base] of Object.entries(VINOTECA_FORMAT_ID_BASE)) {
    const wineId = numeric - base;
    if (wineId > 0 && wineId < 1_000_000) {
      return { format: format as VinotecaFormat, wineId: String(wineId), agoraId: String(numeric) };
    }
  }
  return null;
}

export function normalizeVinotecaRegion(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const VINOTECA_INVALID_REGIONS = new Set([
  "",
  "sin region",
  "sin denominacion",
  "sin denominacion de origen",
  "sin do",
  "otras",
  "otros",
  "n a",
  "na",
  "unknown",
  "desconocido",
]);

export function vinotecaRegionKey(value: unknown): string {
  return normalizeVinotecaRegion(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function isValidVinotecaRegion(value: unknown): boolean {
  return !VINOTECA_INVALID_REGIONS.has(vinotecaRegionKey(value));
}

export type VinotecaFormatPlan = {
  format: VinotecaFormat;
  /** ProductId for the base format, SaleFormatId for additional formats. */
  agoraId: string;
  salePrice: number;
  costPrice: number;
  isBase: boolean;
};

export type VinotecaReferencePlan = {
  winerimWineId: string;
  wineName: string;
  region: string;
  regionKey: string;
  productId: string;
  baseFormat: VinotecaFormat;
  formats: VinotecaFormatPlan[];
};

export type VinotecaCatalogRoute = {
  productId: string;
  baseFormat: VinotecaFormat;
  formatIds: Partial<Record<VinotecaFormat, string>>;
};

export type VinotecaSkippedReference = {
  winerimWineId: string;
  wineName: string;
  reason:
    | "invalid_winerim_id"
    | "missing_region"
    | "missing_bottle_price"
    | "missing_product_id"
    | "missing_name"
    | "incomplete_adopted_route";
};

export type VinotecaPriceInput = {
  winerimWineId: unknown;
  wineName: unknown;
  region: unknown;
  bottleSalePrice: unknown;
  bottleCostPrice?: unknown;
  glassSalePrice?: unknown;
  glassCostPrice?: unknown;
  magnumSalePrice?: unknown;
  magnumCostPrice?: unknown;
};

function positiveAmount(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function nonNegativeAmount(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** Builds the fail-closed reference plan for a single wine. */
export function buildVinotecaReferencePlan(
  input: VinotecaPriceInput,
  adoptedRoute?: VinotecaCatalogRoute | null,
): { plan: VinotecaReferencePlan | null; skipped: VinotecaSkippedReference | null } {
  const wineName = String(input.wineName ?? "").replace(/\s+/g, " ").trim();
  const winerimWineId = String(input.winerimWineId ?? "").trim();
  const normalizedId = normalizeVinotecaWineId(input.winerimWineId);

  if (adoptedRoute === null) {
    return { plan: null, skipped: { winerimWineId, wineName, reason: "incomplete_adopted_route" } };
  }

  if (normalizedId === null) {
    return { plan: null, skipped: { winerimWineId, wineName, reason: "invalid_winerim_id" } };
  }
  if (!wineName) {
    return { plan: null, skipped: { winerimWineId, wineName, reason: "missing_name" } };
  }

  const region = normalizeVinotecaRegion(input.region);
  if (!isValidVinotecaRegion(region)) {
    return { plan: null, skipped: { winerimWineId, wineName, reason: "missing_region" } };
  }

  const bottlePrice = positiveAmount(input.bottleSalePrice);
  if (!bottlePrice) {
    return { plan: null, skipped: { winerimWineId, wineName, reason: "missing_bottle_price" } };
  }

  const productId = adoptedRoute?.productId || vinotecaFormatId("BOTTLE", normalizedId);
  if (!productId) {
    return { plan: null, skipped: { winerimWineId, wineName, reason: "missing_product_id" } };
  }

  const desiredFormats: { format: VinotecaFormat; salePrice: number; costPrice: number }[] = [{
    format: "BOTTLE", salePrice: bottlePrice, costPrice: nonNegativeAmount(input.bottleCostPrice),
  }];

  const glassPrice = positiveAmount(input.glassSalePrice);
  if (glassPrice) {
    desiredFormats.push({ format: "GLASS", salePrice: glassPrice, costPrice: nonNegativeAmount(input.glassCostPrice) });
  }

  const magnumPrice = positiveAmount(input.magnumSalePrice);
  if (magnumPrice) {
    desiredFormats.push({ format: "MAGNUM", salePrice: magnumPrice, costPrice: nonNegativeAmount(input.magnumCostPrice) });
  }

  const baseFormat = adoptedRoute?.baseFormat || "BOTTLE";
  const formats: VinotecaFormatPlan[] = [];
  for (const desired of desiredFormats) {
    const agoraId = adoptedRoute
      ? adoptedRoute.formatIds[desired.format]
      : vinotecaFormatId(desired.format, normalizedId);
    if (!agoraId) {
      return { plan: null, skipped: { winerimWineId, wineName, reason: "incomplete_adopted_route" } };
    }
    formats.push({ ...desired, agoraId, isBase: desired.format === baseFormat });
  }
  if (!formats.some((format) => format.isBase)) {
    return { plan: null, skipped: { winerimWineId, wineName, reason: "incomplete_adopted_route" } };
  }
  formats.sort((left, right) => Number(right.isBase) - Number(left.isBase));

  return {
    plan: {
      winerimWineId: String(normalizedId),
      wineName,
      region,
      regionKey: vinotecaRegionKey(region),
      productId,
      baseFormat,
      formats,
    },
    skipped: null,
  };
}

/** Idempotent mapping/tracking rows for a plan (one row per format identity). */
export function buildVinotecaMappingRows(
  connectionId: string,
  plan: VinotecaReferencePlan,
): { connection_id: string; provider_product_id: string; winerim_wine_id: string; format_type: VinotecaFormat }[] {
  return plan.formats.map((format) => ({
    connection_id: connectionId,
    provider_product_id: format.agoraId,
    winerim_wine_id: plan.winerimWineId,
    format_type: format.format,
  }));
}

/**
 * Identity that MUST be persisted in winerim_push_tracking.agora_product_id.
 * In VINOTECA_REGION_REFERENCE_NATIVE_FORMATS it is the builder's deterministic
 * identity (BOTTLE 2M+id, GLASS 3M+id, MAGNUM 4M+id) — never the generic
 * 500k/700k/900k scheme. Any other connection keeps its exact legacy fallback.
 */
export function trackingAgoraProductIdForFormat(args: {
  vinotecaNativeFormats: boolean;
  format: unknown;
  winerimWineId: unknown;
  genericFallback: string | null | undefined;
}): string | null {
  if (args.vinotecaNativeFormats) {
    const nativeId = vinotecaFormatId(args.format, args.winerimWineId);
    if (nativeId) return nativeId;
  }
  const fallback = String(args.genericFallback ?? "").trim();
  return fallback || null;
}
