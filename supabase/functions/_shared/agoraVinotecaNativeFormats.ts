import {
  WINERIM_FORMAT_CATALOG,
  type WinerimFormatKey,
} from "./winerimFormats.ts";

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
export const VINOTECA_REGION_FAMILY_COLOR = "#722F37";
export const VINOTECA_PREPARATION_TYPE_ID = "6";
export const VINOTECA_PREPARATION_ORDER_ID = "2";

// Deterministic identity namespaces come from the shared Winerim format
// catalog. BOTTLE/GLASS/MAGNUM keep their historical 2M/3M/4M bases; every
// additional format (media botella, jeroboam, matusalem…) gets its own.
export const VINOTECA_FORMAT_ID_BASE: Record<string, number> = Object.fromEntries(
  WINERIM_FORMAT_CATALOG.map((format) => [format.key, format.idBase]),
);

export type VinotecaFormat = WinerimFormatKey;

export const VINOTECA_SUPPORTED_FORMATS: readonly string[] = WINERIM_FORMAT_CATALOG.map((f) => f.key);

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

/**
 * Technical family identity owned by Winerim. ButtonText remains the bare
 * region for the POS, while Name carries provenance and avoids adopting a
 * same-named legacy Agora family.
 */
export function vinotecaRegionFamilyTechnicalName(region: unknown): string {
  const normalized = normalizeVinotecaRegion(region);
  return normalized ? `${VINOTECA_ROOT_FAMILY_NAME} - ${normalized}` : "";
}

/** Stable 1-based position for a region among its visible siblings. */
export function vinotecaRegionFamilyOrder(
  region: unknown,
  siblingRegions: unknown[],
): number {
  const targetKey = vinotecaRegionKey(region);
  const keys = [...new Set(
    [...(siblingRegions || []), region]
      .map(vinotecaRegionKey)
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right, "es"));
  const index = keys.indexOf(targetKey);
  return index >= 0 ? index + 1 : keys.length + 1;
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

export type VinotecaCatalogRouteRow = {
  provider_product_id?: unknown;
  sale_format_id?: unknown;
  format_type?: unknown;
  evidence?: unknown;
};

/**
 * Selects a complete compound route while tolerating stale flat mappings.
 * A compound Product with BOTTLE+GLASS must beat an older standalone GLASS
 * row. Equal-size valid candidates remain ambiguous and fail closed.
 */
export function selectVinotecaCatalogRoute(
  rows: VinotecaCatalogRouteRow[],
): VinotecaCatalogRoute | null {
  const grouped = new Map<string, VinotecaCatalogRouteRow[]>();
  for (const row of rows) {
    const productId = String(row.provider_product_id ?? "").trim();
    if (!productId) continue;
    const group = grouped.get(productId) || [];
    group.push(row);
    grouped.set(productId, group);
  }

  const candidates: Array<VinotecaCatalogRoute & { formatCount: number }> = [];
  for (const [productId, group] of grouped) {
    const formatIds: Partial<Record<VinotecaFormat, string>> = {};
    let baseFormat: VinotecaFormat | null = null;
    let invalid = false;
    for (const row of group) {
      const format = String(row.format_type ?? "").trim().toUpperCase() as VinotecaFormat;
      const saleFormatId = String(row.sale_format_id ?? "").trim();
      if (!VINOTECA_SUPPORTED_FORMATS.includes(format) || !saleFormatId || formatIds[format]) {
        invalid = true;
        continue;
      }
      formatIds[format] = saleFormatId;
      const metadata = row.evidence && typeof row.evidence === "object"
        ? row.evidence as Record<string, unknown>
        : {};
      const explicitlyBase = String(metadata.formatSource ?? "").trim().toUpperCase() === "BASE";
      if (explicitlyBase || saleFormatId === productId) {
        if (baseFormat && baseFormat !== format) invalid = true;
        baseFormat = format;
      }
    }
    if (!invalid && baseFormat) {
      candidates.push({
        productId,
        baseFormat,
        formatIds,
        formatCount: Object.keys(formatIds).length,
      });
    }
  }

  candidates.sort((a, b) => b.formatCount - a.formatCount);
  if (candidates.length === 0 || (
    candidates.length > 1 && candidates[0].formatCount === candidates[1].formatCount
  )) return null;
  const { formatCount: _formatCount, ...route } = candidates[0];
  return route;
}

export type VinotecaSkippedReference = {
  winerimWineId: string;
  wineName: string;
  reason:
    | "invalid_winerim_id"
    | "missing_region"
    | "missing_bottle_price"
    | "missing_product_id"
    | "missing_name"
    | "incomplete_adopted_route"
    | "adopted_format_would_be_lost"
    | "inactive_wine";
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
  /**
   * Additional Winerim formats already gated by the connection's opt-in
   * (media botella, jeroboam, matusalem…). Only positive prices are used.
   */
  extraFormats?: { format: unknown; salePrice: unknown; costPrice?: unknown }[];
  /** Explicit false retires the reference: no XML, never reactivated. */
  isActive?: unknown;
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

  // A retired/inactive reference is never rebuilt, so a hidden Agora product
  // outside the active Winerim catalog can never be turned visible again.
  if (input.isActive === false) {
    return { plan: null, skipped: { winerimWineId, wineName, reason: "inactive_wine" } };
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

  for (const extra of input.extraFormats || []) {
    const key = String(extra?.format ?? "").trim().toUpperCase() as VinotecaFormat;
    if (!VINOTECA_SUPPORTED_FORMATS.includes(key)) continue;
    if (desiredFormats.some((desired) => desired.format === key)) continue;
    const price = positiveAmount(extra?.salePrice);
    if (!price) continue;
    desiredFormats.push({ format: key, salePrice: price, costPrice: nonNegativeAmount(extra?.costPrice) });
  }

  const baseFormat = adoptedRoute?.baseFormat || "BOTTLE";
  const formats: VinotecaFormatPlan[] = [];
  for (const desired of desiredFormats) {
    // Preserve every identity already adopted from Agora. When Winerim adds a
    // genuinely new additional format later, allocate it in our deterministic
    // namespace instead of requiring a mapping that cannot exist yet. The
    // adopted base format remains mandatory: replacing it would change the
    // reference's ProductId and could orphan sales or create a duplicate.
    const adoptedId = adoptedRoute?.formatIds[desired.format];
    const agoraId = adoptedRoute
      ? adoptedId || (desired.format !== baseFormat
        ? vinotecaFormatId(desired.format, normalizedId)
        : null)
      : vinotecaFormatId(desired.format, normalizedId);
    if (!agoraId) {
      return { plan: null, skipped: { winerimWineId, wineName, reason: "incomplete_adopted_route" } };
    }
    formats.push({ ...desired, agoraId, isBase: desired.format === baseFormat });
  }
  if (!formats.some((format) => format.isBase)) {
    return { plan: null, skipped: { winerimWineId, wineName, reason: "incomplete_adopted_route" } };
  }
  // Fail-closed: an adopted route exposes an existing Agora sale format that
  // this Winerim state would silently drop (no positive price). Never rewrite
  // the reference in that case.
  if (adoptedRoute) {
    for (const format of Object.keys(adoptedRoute.formatIds) as VinotecaFormat[]) {
      if (!adoptedRoute.formatIds[format]) continue;
      if (!formats.some((planned) => planned.format === format)) {
        return { plan: null, skipped: { winerimWineId, wineName, reason: "adopted_format_would_be_lost" } };
      }
    }
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

// ─────────────────────────────────────────────────────────────────────
// Region family adoption (fail-closed)
// ─────────────────────────────────────────────────────────────────────
// A homonymous Agora family may only be adopted as the region node when it is
// simultaneously: a direct child of THIS connection's exact VINOTECA ABIERTA
// root, visible in POS, and not deleted. Legacy rootless/hidden/deleted
// homonyms (e.g. Ponzano FamilyId 123 "CAVA") must never be reactivated or
// adopted; the caller creates a deterministic sibling under the root instead.
export type AgoraFamilyLike = {
  Id?: unknown;
  Name?: unknown;
  ParentFamilyId?: unknown;
  ShowInPos?: unknown;
  DeletionDate?: unknown;
  ButtonText?: unknown;
  Color?: unknown;
  Order?: unknown;
};

export function isVinotecaRegionFamilyAdoptable(
  family: AgoraFamilyLike,
  rootFamilyId: unknown,
): boolean {
  const rootId = String(rootFamilyId ?? "").trim();
  if (!rootId) return false;
  const id = String(family?.Id ?? "").trim();
  if (!id || id === rootId) return false;
  if (String(family?.ParentFamilyId ?? "").trim() !== rootId) return false;
  const showInPos = String(family?.ShowInPos ?? "").trim().toLowerCase();
  if (showInPos !== "true" && showInPos !== "1") return false;
  const deletionDate = String(family?.DeletionDate ?? "").trim();
  if (deletionDate) return false;
  return true;
}

export function vinotecaRegionFamilyNameMatches(family: AgoraFamilyLike, regionKey: string): boolean {
  const name = String(family?.Name ?? "");
  if (!name) return false;
  const bare = vinotecaRegionKey(name);
  const suffixed = vinotecaRegionKey(name.split(/\s[-–]\s/).pop() || name);
  return bare === regionKey || suffixed === regionKey;
}

/**
 * Returns the single adoptable region family, null when none qualifies, or
 * throws when more than one valid candidate exists (ambiguous hierarchy).
 */
export function findAdoptableVinotecaRegionFamily(
  families: AgoraFamilyLike[],
  rootFamilyId: unknown,
  regionKey: string,
): AgoraFamilyLike | null {
  const candidates = (families || []).filter((family) =>
    vinotecaRegionFamilyNameMatches(family, regionKey) &&
    isVinotecaRegionFamilyAdoptable(family, rootFamilyId)
  );
  if (candidates.length > 1) {
    throw new Error(
      `${VINOTECA_REGION_REFERENCE_NATIVE_FORMATS}: ambiguous region family for "${regionKey}" (${
        candidates.map((c) => String(c.Id)).join(", ")
      })`,
    );
  }
  return candidates[0] ?? null;
}

/**
 * Returns only a region family explicitly owned by Winerim. A visible direct
 * child named merely "Cava", "Rioja", etc. is legacy and must never be
 * adopted just because its label matches the Winerim region.
 */
export function findWinerimOwnedVinotecaRegionFamily(
  families: AgoraFamilyLike[],
  rootFamilyId: unknown,
  region: unknown,
): AgoraFamilyLike | null {
  const technicalName = vinotecaRegionFamilyTechnicalName(region);
  if (!technicalName) return null;
  const technicalKey = vinotecaRegionKey(technicalName);
  const candidates = (families || []).filter((family) =>
    vinotecaRegionKey(family?.Name) === technicalKey &&
    isVinotecaRegionFamilyAdoptable(family, rootFamilyId)
  );
  if (candidates.length > 1) {
    throw new Error(
      `${VINOTECA_REGION_REFERENCE_NATIVE_FORMATS}: ambiguous Winerim-owned region family for "${technicalName}" (${
        candidates.map((candidate) => String(candidate.Id)).join(", ")
      })`,
    );
  }
  return candidates[0] ?? null;
}
