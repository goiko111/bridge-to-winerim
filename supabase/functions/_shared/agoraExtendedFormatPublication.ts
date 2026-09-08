// ─────────────────────────────────────────────────────────────────────
// Agora publication of non-legacy Winerim formats (canary-gated)
// ─────────────────────────────────────────────────────────────────────
// BOTTLE/GLASS/MAGNUM keep their historical publication path untouched.
// Every other Winerim format (media botella, botella pequeña, jeroboam…)
// is published only when the connection opts in explicitly, and only for
// formats that have a live positive sale price in winerim_wine_formats.
//
// Fail-closed by design: no price row, no publication.

import {
  WINERIM_FORMAT_CATALOG,
  type WinerimFormatKey,
  winerimFormatAgoraId,
  winerimFormatKey,
} from "./winerimFormats.ts";

/** Formats that the legacy pipeline already publishes on its own path. */
export const LEGACY_PUBLISH_FORMATS: readonly string[] = ["BOTTLE", "GLASS", "MAGNUM"];

/** Every format key that this module is responsible for. */
export const EXTENDED_PUBLISH_FORMATS: readonly WinerimFormatKey[] = WINERIM_FORMAT_CATALOG
  .filter((format) => !format.legacy)
  .map((format) => format.key);

/** Short POS button prefixes, kept distinct from B / C / M. */
const EXTENDED_NAME_PREFIX: Record<string, string> = {
  HALF_BOTTLE: "MB",
  SMALL_BOTTLE: "BP",
  BOTTLE_RETAIL: "BT",
  BENJAMIN: "BJ",
  LITER: "LT",
  LARGE_BOTTLE: "BG",
  HALF_GLASS: "MC",
  DOUBLE_MAGNUM: "DM",
  JEROBOAM: "JB",
  REHOBOAM: "RH",
  MATHUSALEM: "MT",
  SALMANAZAR: "SZ",
  BALTHAZAR: "BZ",
  NEBUCHADNEZZAR: "NB",
};

/** Deterministic presentation order after BOTTLE(0)/GLASS(1)/MAGNUM(2). */
const EXTENDED_FORMAT_ORDER: Record<string, number> = Object.fromEntries(
  EXTENDED_PUBLISH_FORMATS.map((key, index) => [key, 3 + index]),
);

export type ExtendedFormatPrice = { sale: number; cost: number; active: boolean };
export type ExtendedFormatPriceMap = Record<string, ExtendedFormatPrice>;

export const EXTENDED_FORMAT_PRICES_FIELD = "_agora_format_prices";

export function isExtendedFormat(formatType: unknown): boolean {
  const key = winerimFormatKey(formatType);
  return !!key && !LEGACY_PUBLISH_FORMATS.includes(key);
}

/** Canary switch: publication of extended formats is opt-in per connection. */
// deno-lint-ignore no-explicit-any
export function isExtendedPublishEnabled(connection: any): boolean {
  const config = (connection?.provider_config || {}) as Record<string, unknown>;
  return config.extended_formats_publish_enabled === true;
}

/** Optional allowlist so a canary can be limited to a few formats. */
// deno-lint-ignore no-explicit-any
export function extendedPublishFormatAllowlist(connection: any): WinerimFormatKey[] | null {
  const config = (connection?.provider_config || {}) as Record<string, unknown>;
  const raw = config.extended_formats_publish_keys;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const keys: WinerimFormatKey[] = [];
  for (const entry of raw) {
    const key = winerimFormatKey(entry);
    if (key && !LEGACY_PUBLISH_FORMATS.includes(key)) keys.push(key);
  }
  return keys.length > 0 ? keys : null;
}

// deno-lint-ignore no-explicit-any
export function isExtendedFormatPublishable(connection: any, formatType: unknown): boolean {
  const key = winerimFormatKey(formatType);
  if (!key || LEGACY_PUBLISH_FORMATS.includes(key)) return false;
  if (!isExtendedPublishEnabled(connection)) return false;
  const allowlist = extendedPublishFormatAllowlist(connection);
  return !allowlist || allowlist.includes(key);
}

/** Builds the price map from winerim_wine_formats rows of a single wine. */
export function extendedFormatPriceMap(
  rows: Array<Record<string, unknown>> | null | undefined,
): ExtendedFormatPriceMap {
  const map: ExtendedFormatPriceMap = {};
  for (const row of rows || []) {
    const key = winerimFormatKey(row.format_key ?? row.source_variant);
    if (!key || LEGACY_PUBLISH_FORMATS.includes(key)) continue;
    const sale = Number(row.sale_price ?? 0);
    if (!Number.isFinite(sale) || sale <= 0) continue;
    const cost = Number(row.cost_price ?? 0);
    map[key] = {
      sale,
      cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
      active: row.is_active !== false,
    };
  }
  return map;
}

/** Attaches the price map to the wine row consumed by the XML builder. */
// deno-lint-ignore no-explicit-any
export function attachExtendedFormatPrices<T extends Record<string, any>>(
  wine: T,
  rows: Array<Record<string, unknown>> | null | undefined,
): T {
  (wine as Record<string, unknown>)[EXTENDED_FORMAT_PRICES_FIELD] = extendedFormatPriceMap(rows);
  return wine;
}

// deno-lint-ignore no-explicit-any
export function extendedFormatPrice(wine: any, formatType: unknown): ExtendedFormatPrice | null {
  const key = winerimFormatKey(formatType);
  if (!key || LEGACY_PUBLISH_FORMATS.includes(key)) return null;
  const map = (wine?.[EXTENDED_FORMAT_PRICES_FIELD] || {}) as ExtendedFormatPriceMap;
  const entry = map[key];
  if (!entry || !(entry.sale > 0) || entry.active === false) return null;
  return entry;
}

/** Deterministic identity: idBase(format) + winerimWineId, never 2M/3M/4M. */
// deno-lint-ignore no-explicit-any
export function extendedFormatProductId(wine: any, formatType: unknown): string | null {
  const key = winerimFormatKey(formatType);
  if (!key || LEGACY_PUBLISH_FORMATS.includes(key)) return null;
  return winerimFormatAgoraId(key, wine?.winerim_id ?? wine?.id);
}

export function extendedFormatNamePrefix(formatType: unknown): string | null {
  const key = winerimFormatKey(formatType);
  if (!key || LEGACY_PUBLISH_FORMATS.includes(key)) return null;
  return EXTENDED_NAME_PREFIX[key] || null;
}

export function extendedFormatProductName(formatType: unknown, wineName: unknown): string | null {
  const prefix = extendedFormatNamePrefix(formatType);
  if (!prefix) return null;
  const normalized = String(wineName ?? "").replace(/\s+/g, " ").trim();
  return `${prefix} ${normalized}`.trim();
}

export function extendedFormatOrder(formatType: unknown): number | null {
  const key = winerimFormatKey(formatType);
  if (!key || LEGACY_PUBLISH_FORMATS.includes(key)) return null;
  return EXTENDED_FORMAT_ORDER[key] ?? null;
}

/** Formats eligible for publication for one wine, in deterministic order. */
// deno-lint-ignore no-explicit-any
export function eligibleExtendedFormats(connection: any, wine: any): WinerimFormatKey[] {
  if (!isExtendedPublishEnabled(connection)) return [];
  if (wine?.is_active === false) return [];
  return EXTENDED_PUBLISH_FORMATS
    .filter((key) => isExtendedFormatPublishable(connection, key))
    .filter((key) => extendedFormatPrice(wine, key) !== null)
    .sort((a, b) => (extendedFormatOrder(a) ?? 0) - (extendedFormatOrder(b) ?? 0));
}
