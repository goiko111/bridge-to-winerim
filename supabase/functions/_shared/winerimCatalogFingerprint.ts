// Deterministic fingerprint of the Winerim catalog fields that are actually
// exportable to Agora. Used by winerim-proxy/fetch-catalog to decide which
// wineIds changed in the SOURCE, so auto-push evaluation is incremental instead
// of re-evaluating the whole batch (which would drag inherited drift into a
// service-hour import wave).
//
// Never include updated_at, raw_payload or any unstable field: they would make
// every pass look "changed".

export const WINERIM_CATALOG_FINGERPRINT_FIELDS = [
  "name",
  "is_active",
  "region",
  "wine_type",
  "vintage",
  "serve_by_glass",
  "bottle_sale_price",
  "glass_sale_price",
  "magnum_sale_price",
] as const;

/**
 * Extra field carrying the digest of the non-legacy formats (media botella,
 * jeroboam, matusalem…). Only folded into the fingerprint for connections with
 * extended formats enabled, so enabling the feature cannot make every wine of
 * every other connection look "changed".
 */
export const WINERIM_EXTENDED_FORMATS_FIELD = "extended_formats_digest";

/** Stable digest of extended-format price/stock state for one wine. */
export function winerimExtendedFormatsDigest(
  rows: { format_key?: unknown; sale_price?: unknown; stock_id?: unknown; is_active?: unknown }[] | null | undefined,
): string {
  return (rows || [])
    .map((row) => [
      String(row.format_key ?? "").toUpperCase(),
      row.sale_price === null || row.sale_price === undefined ? "" : Number(row.sale_price).toFixed(4),
      row.stock_id === null || row.stock_id === undefined ? "" : String(row.stock_id),
      row.is_active === false ? "0" : "1",
    ].join(":"))
    .filter((entry) => !entry.startsWith(":"))
    .sort()
    .join(",");
}

export type WinerimCatalogRow = Record<string, unknown>;


function normalizeScalar(value: unknown): string {
  if (value === undefined || value === null) return "\u0000";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(4) : "\u0000";
  const text = String(value).trim();
  if (text === "") return "\u0000";
  const numeric = Number(text);
  if (Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(text)) return numeric.toFixed(4);
  return text.toLocaleLowerCase("es-ES");
}

/**
 * Returns the deterministic fingerprint, or null when it cannot be computed
 * (fail-closed: the caller must then skip the wine instead of evaluating it).
 */
export function computeWinerimCatalogFingerprint(
  row: WinerimCatalogRow | null | undefined,
  options?: { includeExtendedFormats?: boolean },
): string | null {
  if (!row || typeof row !== "object") return null;
  const name = row.name;
  if (name === undefined || name === null || String(name).trim() === "") return null;
  const fields: string[] = [...WINERIM_CATALOG_FINGERPRINT_FIELDS];
  if (options?.includeExtendedFormats) fields.push(WINERIM_EXTENDED_FORMATS_FIELD);
  return fields
    .map((field) => `${field}=${normalizeScalar(row[field])}`)
    .join("|");
}

/**
 * Merges the persisted row with the payload about to be written, restricted to
 * fingerprint fields. Fields absent from the payload (e.g. `region` during an
 * enrich-only update) keep the stored value, so they never look like a change.
 */
export function buildNextCatalogFingerprintRow(
  previous: WinerimCatalogRow | null | undefined,
  payload: WinerimCatalogRow,
): WinerimCatalogRow {
  const next: WinerimCatalogRow = {};
  for (const field of [...WINERIM_CATALOG_FINGERPRINT_FIELDS, WINERIM_EXTENDED_FORMATS_FIELD]) {
    next[field] = field in payload ? payload[field] : previous?.[field];
  }
  if (!("name" in payload) && previous?.name !== undefined) next.name = previous.name;
  return next;
}

export interface CatalogChangeDecision {
  /** "new" ⇒ CREATE, "changed" ⇒ UPDATE, "unchanged"/"skipped" ⇒ nothing. */
  outcome: "new" | "changed" | "unchanged" | "skipped";
  reason?: string;
  previousFingerprint?: string | null;
  nextFingerprint?: string | null;
}

/**
 * Decides the auto-push intent for one wine from source-observed state only.
 * `pricingReady` gates CREATE exactly like before (an unpriced new wine is not
 * exportable yet). Fail-closed on any uncomputable fingerprint.
 */
export function decideCatalogChange(options: {
  previous: WinerimCatalogRow | null | undefined;
  payload: WinerimCatalogRow;
  pricingReady: boolean;
  /** Fold extended formats into the fingerprint (per-connection opt-in). */
  includeExtendedFormats?: boolean;
}): CatalogChangeDecision {
  const { previous, payload, pricingReady, includeExtendedFormats } = options;
  const fingerprintOptions = { includeExtendedFormats: includeExtendedFormats === true };
  const nextRow = buildNextCatalogFingerprintRow(previous, payload);
  const nextFingerprint = computeWinerimCatalogFingerprint(nextRow, fingerprintOptions);
  if (!nextFingerprint) {
    return { outcome: "skipped", reason: "fingerprint_unavailable", nextFingerprint: null };
  }

  if (!previous) {
    return pricingReady
      ? { outcome: "new", nextFingerprint }
      : { outcome: "skipped", reason: "new_wine_not_priced", nextFingerprint };
  }

  const previousFingerprint = computeWinerimCatalogFingerprint(previous, fingerprintOptions);
  if (!previousFingerprint) {
    return { outcome: "skipped", reason: "previous_fingerprint_unavailable", nextFingerprint };
  }

  return previousFingerprint === nextFingerprint
    ? { outcome: "unchanged", previousFingerprint, nextFingerprint }
    : { outcome: "changed", previousFingerprint, nextFingerprint };
}
