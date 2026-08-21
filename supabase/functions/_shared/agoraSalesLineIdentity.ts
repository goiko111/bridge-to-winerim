export type AgoraSalesResolution = {
  winerim_wine_id: string;
  format: string;
};

export type AgoraSalesLineIdentityResult = {
  providerProductId: string;
  resolution: AgoraSalesResolution | null;
  source: "native_product" | "native_sale_format" | "sa_vida_guimaro_exact" | "unresolved";
  blockedReason?: string;
};

const SA_VIDA_CONNECTION_ID = "e5b988f1-8471-4336-a1f7-a5c1626deab1";
const SA_VIDA_GUIMARO_GLASS_PRODUCT_ID = "848468";
const SA_VIDA_GUIMARO_WINERIM_ID = "148468";

const SA_VIDA_GUIMARO_EXACT_GLASS_LABELS = new Set([
  "copa guimaro godello",
  "copa godello guimaro",
]);

function normalizeExactLabel(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeProviderProductId(value: unknown): string {
  const id = String(value ?? "").trim();
  return id === "0" ? "" : id;
}

function isGlassResolution(resolution: AgoraSalesResolution | null | undefined): boolean {
  const format = String(resolution?.format || "").trim().toUpperCase();
  return format === "GLASS" || format === "COPA";
}

/**
 * Resolves a forward Agora sales line by ProductId, then SaleFormatId. The
 * Sa Vida exception is exact and fail-closed, and is never used by backfills.
 */
export function resolveForwardAgoraSalesLineIdentity(input: {
  connectionId: string;
  providerProductId: unknown;
  saleFormatId?: unknown;
  productName: unknown;
  normalizedFormat: unknown;
  resolutionMap: ReadonlyMap<string, AgoraSalesResolution>;
}): AgoraSalesLineIdentityResult {
  const nativeProductId = normalizeProviderProductId(input.providerProductId);
  const nativeProductResolution = nativeProductId
    ? input.resolutionMap.get(nativeProductId) || null
    : null;
  if (nativeProductId && nativeProductResolution) {
    return {
      providerProductId: nativeProductId,
      resolution: nativeProductResolution,
      source: "native_product",
    };
  }

  const nativeSaleFormatId = normalizeProviderProductId(input.saleFormatId);
  const nativeSaleFormatResolution = nativeSaleFormatId
    ? input.resolutionMap.get(nativeSaleFormatId) || null
    : null;
  if (nativeSaleFormatId && nativeSaleFormatResolution) {
    return {
      providerProductId: nativeSaleFormatId,
      resolution: nativeSaleFormatResolution,
      source: "native_sale_format",
    };
  }

  // Preserve Agora's native identity when neither ID has an authoritative
  // mapping. An unmapped native line must never fall through to a text alias.
  if (nativeProductId || nativeSaleFormatId) {
    return {
      providerProductId: nativeProductId || nativeSaleFormatId,
      resolution: null,
      source: nativeProductId ? "native_product" : "native_sale_format",
      blockedReason: "authoritative_mapping_missing",
    };
  }

  if (input.connectionId !== SA_VIDA_CONNECTION_ID) {
    return {
      providerProductId: "",
      resolution: null,
      source: "unresolved",
      blockedReason: "connection_not_allowlisted",
    };
  }

  if (String(input.normalizedFormat || "").trim().toUpperCase() !== "COPA") {
    return {
      providerProductId: "",
      resolution: null,
      source: "unresolved",
      blockedReason: "format_not_glass",
    };
  }

  const exactLabel = normalizeExactLabel(input.productName);
  if (!SA_VIDA_GUIMARO_EXACT_GLASS_LABELS.has(exactLabel)) {
    return {
      providerProductId: "",
      resolution: null,
      source: "unresolved",
      blockedReason: "label_not_exact",
    };
  }

  const guardedResolution = input.resolutionMap.get(SA_VIDA_GUIMARO_GLASS_PRODUCT_ID) || null;
  if (
    String(guardedResolution?.winerim_wine_id || "") !== SA_VIDA_GUIMARO_WINERIM_ID
    || !isGlassResolution(guardedResolution)
  ) {
    return {
      providerProductId: "",
      resolution: null,
      source: "unresolved",
      blockedReason: "authoritative_mapping_guard_failed",
    };
  }

  return {
    providerProductId: SA_VIDA_GUIMARO_GLASS_PRODUCT_ID,
    resolution: guardedResolution,
    source: "sa_vida_guimaro_exact",
  };
}

// ─────────────────────────────────────────────────────────────────────
// VINOTECA NATIVE-NAMESPACE RESOLUTION (Don Bernardo only, strict allowlist)
// ─────────────────────────────────────────────────────────────────────
// Don Bernardo publishes GLASS/MAGNUM as native Agora sale formats created by
// us with deterministic ids (BOTTLE 2M+wineId, GLASS 3M+wineId, MAGNUM
// 4M+wineId). Only ids inside that namespace may be preferred; a legacy/low
// SaleFormatId (e.g. water 1855) must NEVER be used as a flat lookup key,
// otherwise unrelated legacy mappings resolve as wine. Every other connection
// keeps its exact legacy identity untouched.
import { parseVinotecaNativeId } from "./agoraVinotecaNativeFormats.ts";

export const AGORA_SALE_FORMAT_FIRST_CONNECTION_IDS: readonly string[] = [
  "a700d425-9194-4758-95ff-7fee86419e14", // Don Bernardo Ponzano
  "79280cb8-0fe7-4a57-93a4-04172205ac70", // Don Bernardo Santander
];

export function isAgoraSaleFormatFirstConnection(connectionId: unknown): boolean {
  return AGORA_SALE_FORMAT_FIRST_CONNECTION_IDS.includes(
    String(connectionId ?? "").trim().toLowerCase(),
  );
}

export type AgoraConnectionSalesLineIdentity = {
  providerProductId: string;
  resolution: AgoraSalesResolution | null;
  source: "sale_format_first" | "product_first" | "legacy";
  blockedReason?: string;
};

function isSameFormat(a: unknown, b: unknown): boolean {
  const norm = (value: unknown) => {
    const upper = String(value ?? "").trim().toUpperCase();
    return upper === "COPA" ? "GLASS" : upper;
  };
  return norm(a) === norm(b);
}

/**
 * Allowlisted connections resolve native SaleFormatId, then native ProductId,
 * then a plain ProductId lookup. Non-native SaleFormatIds are ignored for
 * preference. Native ids resolve deterministically (id - base = wineId) and are
 * fail-closed: the wine must be active for THIS connection with a positive
 * price for that format, and any existing mapping row must agree.
 */
export function resolveAgoraSalesLineIdentityForConnection(input: {
  connectionId: unknown;
  productId: unknown;
  saleFormatId: unknown;
  legacyProviderProductId: string;
  resolutionMap: ReadonlyMap<string, AgoraSalesResolution>;
  /**
   * Active winerim wines of this connection: wineId -> formats with a positive
   * price (BOTTLE/GLASS/MAGNUM). Omit to skip the activity/price check.
   */
  activeWineFormats?: ReadonlyMap<string, ReadonlySet<string>>;
}): AgoraConnectionSalesLineIdentity {
  const legacyId = String(input.legacyProviderProductId ?? "");
  if (!isAgoraSaleFormatFirstConnection(input.connectionId)) {
    return {
      providerProductId: legacyId,
      resolution: input.resolutionMap.get(legacyId) || null,
      source: "legacy",
    };
  }

  const resolveNative = (
    value: unknown,
    source: "sale_format_first" | "product_first",
  ): AgoraConnectionSalesLineIdentity | null => {
    const native = parseVinotecaNativeId(value);
    if (!native) return null;
    const blocked = (blockedReason: string) => ({
      providerProductId: native.agoraId,
      resolution: null,
      source,
      blockedReason,
    });

    const mapped = input.resolutionMap.get(native.agoraId) || null;
    if (
      mapped
      && (String(mapped.winerim_wine_id || "").trim() !== native.wineId
        || !isSameFormat(mapped.format, native.format))
    ) {
      return blocked("native_identity_mismatch");
    }

    if (input.activeWineFormats) {
      const formats = input.activeWineFormats.get(native.wineId);
      if (!formats) return blocked("winerim_wine_inactive");
      if (!formats.has(native.format)) return blocked("winerim_format_price_missing");
    }

    return {
      providerProductId: native.agoraId,
      resolution: { winerim_wine_id: native.wineId, format: native.format },
      source,
    };
  };


  const nativeSaleFormat = resolveNative(input.saleFormatId, "sale_format_first");
  if (nativeSaleFormat?.resolution) return nativeSaleFormat;

  const nativeProduct = resolveNative(input.productId, "product_first");
  if (nativeProduct?.resolution) return nativeProduct;
  if (nativeSaleFormat) return nativeSaleFormat;
  if (nativeProduct) return nativeProduct;

  // No native identity at all: never prefer the legacy SaleFormatId.
  const productId = normalizeProviderProductId(input.productId);
  if (productId) {
    return {
      providerProductId: productId,
      resolution: input.resolutionMap.get(productId) || null,
      source: "product_first",
    };
  }

  return {
    providerProductId: legacyId,
    resolution: input.resolutionMap.get(legacyId) || null,
    source: "product_first",
  };
}
