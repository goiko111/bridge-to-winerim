// ─────────────────────────────────────────────────────────────────────
// Winerim format catalog (data-driven, no hardcoded three-format world)
// ─────────────────────────────────────────────────────────────────────
// Single source of truth for every sale format Winerim can expose.
// - `key`      canonical format key used across mappings, tracking and stock
// - `variants` exact strings seen in the Winerim API (including known typos)
// - `label`    short suffix for the POS button
// - `liters`   nominal capacity (null when Winerim does not define one)
// - `idBase`   deterministic Agora identity namespace (idBase + winerimWineId)
//
// BOTTLE/GLASS/MAGNUM keep their historical namespaces (2M/3M/4M) so no
// existing identity, button or mapping changes.

export type WinerimFormatKey =
  | "BOTTLE"
  | "GLASS"
  | "MAGNUM"
  | "HALF_BOTTLE"
  | "SMALL_BOTTLE"
  | "BOTTLE_RETAIL"
  | "BENJAMIN"
  | "LITER"
  | "LARGE_BOTTLE"
  | "HALF_GLASS"
  | "DOUBLE_MAGNUM"
  | "JEROBOAM"
  | "REHOBOAM"
  | "MATHUSALEM"
  | "SALMANAZAR"
  | "BALTHAZAR"
  | "NEBUCHADNEZZAR";

export type WinerimFormatDefinition = {
  key: WinerimFormatKey;
  /** Canonical Winerim variant string written back to the API. */
  variant: string;
  /** Every accepted spelling, lowercase. */
  variants: string[];
  label: string;
  liters: number | null;
  idBase: number;
  /** true for the three formats the middleware supported before this catalog. */
  legacy: boolean;
};

export const WINERIM_FORMAT_CATALOG: readonly WinerimFormatDefinition[] = [
  { key: "BOTTLE", variant: "botella", variants: ["botella", "bottle"], label: "Botella", liters: 0.75, idBase: 2_000_000, legacy: true },
  { key: "GLASS", variant: "copa", variants: ["copa", "glass"], label: "Copa", liters: 0.15, idBase: 3_000_000, legacy: true },
  { key: "MAGNUM", variant: "magnum", variants: ["magnum"], label: "Magnum", liters: 1.5, idBase: 4_000_000, legacy: true },
  { key: "HALF_BOTTLE", variant: "media-botella", variants: ["media-botella", "media botella", "half-bottle"], label: "Media botella", liters: 0.375, idBase: 5_000_000, legacy: false },
  { key: "SMALL_BOTTLE", variant: "botella-pequena", variants: ["botella-pequena", "botella-pequeña", "botella pequena"], label: "Botella pequeña", liters: 0.5, idBase: 6_000_000, legacy: false },
  { key: "BOTTLE_RETAIL", variant: "botella-tienda", variants: ["botella-tienda", "botella tienda"], label: "Botella tienda", liters: 0.75, idBase: 7_000_000, legacy: false },
  { key: "BENJAMIN", variant: "benjamin", variants: ["benjamin", "benjamín", "piccolo"], label: "Benjamín", liters: 0.2, idBase: 8_000_000, legacy: false },
  { key: "LITER", variant: "litro", variants: ["litro", "liter", "litre"], label: "Litro", liters: 1, idBase: 9_000_000, legacy: false },
  { key: "LARGE_BOTTLE", variant: "botella-grande", variants: ["botella-grande", "botella grande"], label: "Botella grande", liters: null, idBase: 10_000_000, legacy: false },
  { key: "HALF_GLASS", variant: "media-copa", variants: ["media-copa", "media copa"], label: "Media copa", liters: 0.075, idBase: 11_000_000, legacy: false },
  { key: "DOUBLE_MAGNUM", variant: "doble-magnum", variants: ["doble-magnum", "doble magnum", "double-magnum"], label: "Doble magnum", liters: 3, idBase: 12_000_000, legacy: false },
  { key: "JEROBOAM", variant: "jeroboam", variants: ["jeroboam", "jeroboham"], label: "Jeroboam", liters: 3, idBase: 13_000_000, legacy: false },
  { key: "REHOBOAM", variant: "rehoboam", variants: ["rehoboam", "rehoboham", "rehoboan"], label: "Rehoboam", liters: 4.5, idBase: 14_000_000, legacy: false },
  { key: "MATHUSALEM", variant: "matusalem", variants: ["matusalem", "matusalén", "mathusalem", "methuselah"], label: "Matusalem", liters: 6, idBase: 15_000_000, legacy: false },
  { key: "SALMANAZAR", variant: "salmanazar", variants: ["salmanazar", "salmanzar", "salmanassar"], label: "Salmanazar", liters: 9, idBase: 16_000_000, legacy: false },
  { key: "BALTHAZAR", variant: "baltasar", variants: ["baltasar", "balthazar", "baltazar"], label: "Baltasar", liters: 12, idBase: 17_000_000, legacy: false },
  { key: "NEBUCHADNEZZAR", variant: "nabucodonosor", variants: ["nabucodonosor", "nebuchadnezzar"], label: "Nabucodonosor", liters: 15, idBase: 18_000_000, legacy: false },
];

const BY_KEY = new Map<string, WinerimFormatDefinition>(
  WINERIM_FORMAT_CATALOG.map((format) => [format.key, format]),
);

const BY_VARIANT = new Map<string, WinerimFormatDefinition>();
for (const format of WINERIM_FORMAT_CATALOG) {
  for (const variant of format.variants) BY_VARIANT.set(variant, format);
}

export const WINERIM_FORMAT_KEYS: readonly WinerimFormatKey[] = WINERIM_FORMAT_CATALOG.map((f) => f.key);
export const WINERIM_LEGACY_FORMAT_KEYS: readonly WinerimFormatKey[] = WINERIM_FORMAT_CATALOG
  .filter((format) => format.legacy)
  .map((format) => format.key);

function slug(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

/** Resolves any Winerim variant string or canonical key to a catalog entry. */
export function resolveWinerimFormat(value: unknown): WinerimFormatDefinition | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (BY_KEY.has(upper)) return BY_KEY.get(upper)!;
  const normalized = slug(raw);
  if (BY_VARIANT.has(normalized)) return BY_VARIANT.get(normalized)!;
  // Accept undecorated spellings without the hyphen convention.
  const collapsed = normalized.replace(/-/g, "");
  for (const format of WINERIM_FORMAT_CATALOG) {
    if (format.variants.some((variant) => slug(variant).replace(/-/g, "") === collapsed)) return format;
  }
  return null;
}

export function winerimFormatKey(value: unknown): WinerimFormatKey | null {
  return resolveWinerimFormat(value)?.key ?? null;
}

export function isLegacyWinerimFormat(value: unknown): boolean {
  return resolveWinerimFormat(value)?.legacy === true;
}

export function winerimFormatLabel(value: unknown): string {
  return resolveWinerimFormat(value)?.label ?? "";
}

export function winerimFormatLiters(value: unknown): number | null {
  return resolveWinerimFormat(value)?.liters ?? null;
}

/** Canonical Winerim variant string for a format key (for API writes). */
export function winerimVariantForFormat(value: unknown): string | null {
  return resolveWinerimFormat(value)?.variant ?? null;
}

export function normalizeWinerimWineIdForFormatId(wineId: unknown): number | null {
  const value = Number(wineId);
  if (!Number.isInteger(value) || value <= 0 || value >= 1_000_000) return null;
  return value;
}

/** Deterministic Agora identity for (format, wine). Fail-closed on bad input. */
export function winerimFormatAgoraId(format: unknown, wineId: unknown): string | null {
  const definition = resolveWinerimFormat(format);
  const id = normalizeWinerimWineIdForFormatId(wineId);
  if (!definition || id === null) return null;
  return String(definition.idBase + id);
}

/** Inverse of winerimFormatAgoraId. Only recognises our own namespaces. */
export function parseWinerimFormatAgoraId(
  value: unknown,
): { format: WinerimFormatKey; wineId: string; agoraId: string } | null {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const numeric = Number(raw);
  if (!Number.isInteger(numeric)) return null;
  for (const format of WINERIM_FORMAT_CATALOG) {
    const wineId = numeric - format.idBase;
    if (wineId > 0 && wineId < 1_000_000) {
      return { format: format.key, wineId: String(wineId), agoraId: String(numeric) };
    }
  }
  return null;
}

/** Extracted price/stock row for one format of one wine. */
export type WinerimWineFormatRow = {
  format_key: WinerimFormatKey;
  source_variant: string;
  sale_price: number | null;
  cost_price: number | null;
  stock_id: number | null;
  is_active: boolean;
};

function positiveOrNull(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * Normalizes `raw_payload.prices` into one row per recognised format.
 * Unknown variants are reported separately instead of being folded into
 * BOTTLE, so an unsupported format can never silently deduct bottle stock.
 */
export function extractWinerimWineFormats(prices: unknown): {
  rows: WinerimWineFormatRow[];
  unknownVariants: string[];
} {
  const entries = Array.isArray(prices) ? prices as Record<string, unknown>[] : [];
  const rows = new Map<WinerimFormatKey, WinerimWineFormatRow>();
  const unknownVariants: string[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const sourceVariant = String(entry.variant ?? "").trim();
    const definition = resolveWinerimFormat(sourceVariant);
    if (!definition) {
      if (sourceVariant && !unknownVariants.includes(sourceVariant)) unknownVariants.push(sourceVariant);
      continue;
    }
    const erpStock = entry.erpStock && typeof entry.erpStock === "object"
      ? entry.erpStock as Record<string, unknown>
      : null;
    const stockIdValue = Number(erpStock?.id);
    const row: WinerimWineFormatRow = {
      format_key: definition.key,
      source_variant: sourceVariant,
      sale_price: positiveOrNull(entry.price),
      cost_price: positiveOrNull(entry.costPrice ?? entry.cost_price ?? entry.purchasePrice),
      stock_id: Number.isFinite(stockIdValue) && stockIdValue > 0 ? stockIdValue : null,
      is_active: entry.isActive === false || entry.active === false ? false : true,
    };
    const existing = rows.get(definition.key);
    // Prefer the entry that actually carries a usable price.
    if (!existing || (existing.sale_price == null && row.sale_price != null)) rows.set(definition.key, row);
  }

  return { rows: [...rows.values()], unknownVariants };
}

/** Formats publishable to the POS: known, active and with a positive price. */
export function publishableWinerimFormats(rows: WinerimWineFormatRow[]): WinerimWineFormatRow[] {
  return (rows || []).filter((row) => row.is_active && row.sale_price != null && row.sale_price > 0);
}

// ─────────────────────────────────────────────────────────────────────
// CAPACITY EQUIVALENCE (POS label ⇄ Winerim format)
// ─────────────────────────────────────────────────────────────────────
// POS buttons name the capacity, not the Winerim format: "CLOE 3L",
// "VEUVE 1,5 L", "BENJAMIN 20CL", "MAGNUM 150 cl". A capacity can map to more
// than one Winerim format (3 L = doble magnum OR jeroboam), so resolution is
// explicitly ambiguity-aware: it only commits when a single candidate remains,
// preferring the formats the wine actually has in Winerim (learned from
// winerim_wine_formats). Never guesses — ambiguity fails closed.

/** Liters parsed from a POS label ("3L", "1,5 l", "75 cl", "750ml"). */
export function parseLitersFromLabel(value: unknown): number | null {
  const raw = String(value ?? "")
    .toLowerCase()
    .replace(",", ".");
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(l|lt|lts|litros?|cl|ml)\b/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  const liters = unit === "cl" ? amount / 100 : unit === "ml" ? amount / 1000 : amount;
  return liters > 0 && liters <= 30 ? Math.round(liters * 1000) / 1000 : null;
}

/** Every catalog format with this nominal capacity (tolerance 1%). */
export function winerimFormatsForLiters(liters: unknown): WinerimFormatDefinition[] {
  const target = Number(liters);
  if (!Number.isFinite(target) || target <= 0) return [];
  return WINERIM_FORMAT_CATALOG.filter((format) =>
    format.liters !== null && Math.abs(format.liters - target) <= Math.max(0.005, target * 0.01)
  );
}

export type WinerimCapacityResolution = {
  format: WinerimFormatKey | null;
  liters: number | null;
  candidates: WinerimFormatKey[];
  reason:
    | "exact_variant"
    | "capacity_unique"
    | "capacity_narrowed_by_wine"
    | "capacity_ambiguous"
    | "capacity_unknown";
};

/**
 * Resolves a POS format label / capacity to a single Winerim format.
 *
 * Order: exact variant name → unique capacity match → capacity narrowed to one
 * of the formats the wine actually has in Winerim → ambiguous (fail-closed).
 */
export function resolveWinerimFormatByCapacity(input: {
  /** POS label or Winerim variant, e.g. "CLOE 3L" or "jeroboam". */
  label?: unknown;
  /** Explicit capacity in liters when the POS provides it as a number. */
  liters?: unknown;
  /** Formats this wine really has in Winerim (learned, used to disambiguate). */
  availableFormats?: Iterable<unknown>;
}): WinerimCapacityResolution {
  const exact = resolveWinerimFormat(input.label);
  if (exact) {
    return { format: exact.key, liters: exact.liters, candidates: [exact.key], reason: "exact_variant" };
  }

  const liters = Number.isFinite(Number(input.liters)) && Number(input.liters) > 0
    ? Number(input.liters)
    : parseLitersFromLabel(input.label);
  if (liters === null) {
    return { format: null, liters: null, candidates: [], reason: "capacity_unknown" };
  }

  const candidates = winerimFormatsForLiters(liters);
  if (candidates.length === 0) {
    return { format: null, liters, candidates: [], reason: "capacity_unknown" };
  }
  const candidateKeys = candidates.map((format) => format.key);
  if (candidates.length === 1) {
    return { format: candidateKeys[0], liters, candidates: candidateKeys, reason: "capacity_unique" };
  }

  const available = new Set<WinerimFormatKey>();
  for (const value of input.availableFormats || []) {
    const key = winerimFormatKey(value);
    if (key) available.add(key);
  }
  const narrowed = candidateKeys.filter((key) => available.has(key));
  if (narrowed.length === 1) {
    return { format: narrowed[0], liters, candidates: candidateKeys, reason: "capacity_narrowed_by_wine" };
  }

  return { format: null, liters, candidates: candidateKeys, reason: "capacity_ambiguous" };
}
