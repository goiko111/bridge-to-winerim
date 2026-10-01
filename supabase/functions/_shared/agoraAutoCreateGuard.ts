// AUTO_CREATE guard (incidencia 1-oct-2026): the automatic cycle may only
// CREATE products that do not exist in Agora. It never rewrites an existing
// product (family, name, price, order, visibility).

export const AUTO_CREATE_MAX_PER_CYCLE = 30;

export interface CreateFormatGuardInput {
  formats: string[];
  /** Formats with ANY winerim_push_tracking row (any status) for this wine. */
  trackedFormats: Set<string>;
  /** Formats with a product_mappings row carrying an agora_product_id. */
  mappedFormats: Set<string>;
  /** Product Id the XML would use for each format (null = unknown). */
  expectedProductIdByFormat: Map<string, string | null>;
  /** Product ids currently in Agora; null = Agora unreadable (fail closed). */
  existingAgoraProductIds: Set<string> | null;
}

export function guardCreateFormats(input: CreateFormatGuardInput): { keep: string[]; dropped: string[] } {
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const raw of input.formats) {
    const fmt = String(raw).toUpperCase();
    if (input.existingAgoraProductIds === null) { dropped.push(`${fmt}:agora_products_unreadable`); continue; }
    if (input.trackedFormats.has(fmt)) { dropped.push(`${fmt}:push_tracking_exists`); continue; }
    if (input.mappedFormats.has(fmt)) { dropped.push(`${fmt}:agora_product_id_mapped`); continue; }
    const expectedId = input.expectedProductIdByFormat.get(fmt);
    if (!expectedId) { dropped.push(`${fmt}:expected_product_id_unknown`); continue; }
    if (input.existingAgoraProductIds.has(expectedId)) { dropped.push(`${fmt}:agora_product_exists:${expectedId}`); continue; }
    keep.push(fmt);
  }
  return { keep, dropped };
}

/** More than the cap ⇒ queue nothing and warn. */
export function applyAutoCreateCap<T>(candidates: T[], max = AUTO_CREATE_MAX_PER_CYCLE): { queue: T[]; capExceeded: boolean } {
  if (candidates.length > max) return { queue: [], capExceeded: true };
  return { queue: candidates, capExceeded: false };
}
