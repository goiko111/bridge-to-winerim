import { normalizeAgoraProductNameKey, truncateAgoraButtonText } from "./agoraProductNaming.ts";

export const AGORA_FORMAT_PREFIX_BY_FORMAT: Record<string, string> = {
  BOTTLE: "B",
  GLASS: "C",
  MAGNUM: "M",
};

export interface AgoraPrefixCatalogProduct {
  productId: string | number;
  name: string;
  /**
   * Whether the button is sellable/visible in Agora. Hidden buttons (explicit
   * false) never reserve a name, so an active Winerim button can adopt the
   * prefixed name of an old hidden duplicate. Undefined means "assume visible".
   */
  visible?: boolean;
}

export interface AgoraPrefixMappingRow {
  productId: string | number;
  formatType: string | null | undefined;
}

export interface AgoraPrefixRename {
  productId: string;
  formatType: string;
  currentName: string;
  newName: string;
  buttonText: string;
}

export interface AgoraPrefixSkip {
  productId: string;
  formatType: string;
  currentName: string;
  reason:
    | "unsupported_format"
    | "not_in_catalog"
    | "missing_name"
    | "already_prefixed"
    | "name_collision";
}

export interface AgoraPrefixPlan {
  renames: AgoraPrefixRename[];
  skipped: AgoraPrefixSkip[];
}

export function stripAgoraFormatPrefix(name: string): string {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^([BCM])\s+(?=\S)/, "")
    .trim();
}

/**
 * Plans the unification of Winerim-linked Agora buttons so every one of them
 * carries its format prefix (B bottle / C glass / M magnum). Pure and
 * deterministic: identical inputs always produce identical renames.
 */
export function planAgoraFormatPrefixRenames(
  catalogProducts: AgoraPrefixCatalogProduct[],
  mappings: AgoraPrefixMappingRow[],
): AgoraPrefixPlan {
  const catalogById = new Map<string, string>();
  const usedNameKeys = new Map<string, string>();
  for (const product of catalogProducts) {
    const id = String(product.productId ?? "").trim();
    const name = String(product.name ?? "").replace(/\s+/g, " ").trim();
    if (!id) continue;
    catalogById.set(id, name);
    if (name) usedNameKeys.set(normalizeAgoraProductNameKey(name), id);
  }

  const renames: AgoraPrefixRename[] = [];
  const skipped: AgoraPrefixSkip[] = [];
  const seenProductIds = new Set<string>();

  const sorted = [...mappings].sort((a, b) =>
    String(a.productId ?? "").localeCompare(String(b.productId ?? ""), "en", { numeric: true })
  );

  for (const mapping of sorted) {
    const productId = String(mapping.productId ?? "").trim();
    if (!productId || seenProductIds.has(productId)) continue;
    seenProductIds.add(productId);

    const formatType = String(mapping.formatType ?? "").trim().toUpperCase();
    const prefix = AGORA_FORMAT_PREFIX_BY_FORMAT[formatType];
    const currentName = catalogById.get(productId) ?? "";

    if (!prefix) {
      skipped.push({ productId, formatType, currentName, reason: "unsupported_format" });
      continue;
    }
    if (!catalogById.has(productId)) {
      skipped.push({ productId, formatType, currentName, reason: "not_in_catalog" });
      continue;
    }
    if (!currentName) {
      skipped.push({ productId, formatType, currentName, reason: "missing_name" });
      continue;
    }

    const baseName = stripAgoraFormatPrefix(currentName);
    if (!baseName) {
      skipped.push({ productId, formatType, currentName, reason: "missing_name" });
      continue;
    }

    const newName = `${prefix} ${baseName}`;
    if (normalizeAgoraProductNameKey(newName) === normalizeAgoraProductNameKey(currentName)) {
      skipped.push({ productId, formatType, currentName, reason: "already_prefixed" });
      continue;
    }

    const newKey = normalizeAgoraProductNameKey(newName);
    const owner = usedNameKeys.get(newKey);
    if (owner && owner !== productId) {
      skipped.push({ productId, formatType, currentName, reason: "name_collision" });
      continue;
    }

    usedNameKeys.delete(normalizeAgoraProductNameKey(currentName));
    usedNameKeys.set(newKey, productId);
    catalogById.set(productId, newName);

    renames.push({
      productId,
      formatType,
      currentName,
      newName,
      buttonText: truncateAgoraButtonText(newName),
    });
  }

  return { renames, skipped };
}
