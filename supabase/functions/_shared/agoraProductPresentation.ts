export const AGORA_SORT_ALPHABETICAL_WINE_NAME = "ALPHABETICAL_WINE_NAME";
export const AGORA_BUTTON_TEXT_WINE_NAME_ONLY = "WINE_NAME_ONLY";
export const AGORA_BUTTON_TEXT_WINE_NAME_WITH_FORMAT_SUFFIX = "WINE_NAME_WITH_FORMAT_SUFFIX";

const AGORA_HEX_COLOR = /^#[0-9A-F]{6}$/i;

const AGORA_DEFAULT_COLOR_BY_WINE_TYPE: Record<string, string> = {
  tinto: "#800040",
  blanco: "#FFFFFF",
  rosado: "#DC82EF",
  espumoso: "#FF8080",
  fortificado: "#F1C097",
  dulce: "#F5A623",
};

const AGORA_WINE_TYPE_ORDER: Record<string, number> = {
  tinto: 0,
  blanco: 1,
  rosado: 2,
  espumoso: 3,
  fortificado: 4,
  dulce: 5,
};

function providerConfig(connection: unknown): Record<string, unknown> {
  if (!connection || typeof connection !== "object") return {};
  const config = (connection as { provider_config?: unknown }).provider_config;
  return config && typeof config === "object" ? config as Record<string, unknown> : {};
}

export function agoraProductSortMode(connection: unknown): string {
  const config = providerConfig(connection);
  return String(config.agora_product_sort_mode || config.product_sort_mode || "").trim().toUpperCase();
}

export function agoraProductButtonTextMode(connection: unknown): string {
  const config = providerConfig(connection);
  return String(config.agora_product_button_text_mode || "").trim().toUpperCase();
}

export function shouldSortAgoraProductsAlphabetically(connection: unknown): boolean {
  return agoraProductSortMode(connection) === AGORA_SORT_ALPHABETICAL_WINE_NAME;
}

export function stripAgoraFormatPrefix(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:B|C|M)\s+/i, "")
    .replace(/^(?:BOT(?:ELLA)?|COPA|MAG(?:NUM)?)\.?\s+/i, "")
    .trim();
}

export function agoraFormatSuffix(value: unknown): "B" | "C" | "M" | null {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (/^(?:B|BOT(?:ELLA)?)\s+/i.test(normalized)) return "B";
  if (/^(?:C|COPA)\s+/i.test(normalized)) return "C";
  if (/^(?:M|MAG(?:NUM)?)\s+/i.test(normalized)) return "M";
  return null;
}

function labelWithFormatSuffix(technicalName: unknown, maxLength: number): string {
  const suffix = agoraFormatSuffix(technicalName);
  const wineName = stripAgoraFormatPrefix(technicalName);
  if (!suffix) return wineName.slice(0, maxLength).trim();
  const marker = ` [${suffix}]`;
  const nameBudget = Math.max(1, maxLength - marker.length);
  return `${wineName.slice(0, nameBudget).trim()}${marker}`.slice(0, maxLength).trim();
}

export function agoraProductButtonText(connection: unknown, technicalName: unknown, maxLength = 20): string {
  const normalized = String(technicalName ?? "").replace(/\s+/g, " ").trim();
  const mode = agoraProductButtonTextMode(connection);
  if (mode === AGORA_BUTTON_TEXT_WINE_NAME_WITH_FORMAT_SUFFIX) {
    return labelWithFormatSuffix(normalized, maxLength);
  }
  const visibleName = mode === AGORA_BUTTON_TEXT_WINE_NAME_ONLY ? stripAgoraFormatPrefix(normalized) : normalized;
  return (visibleName.length <= maxLength ? visibleName : visibleName.slice(0, maxLength)).trim();
}

export function canonicalAgoraWineType(value: unknown): string {
  const normalized = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  if (["red", "tinto"].includes(normalized)) return "tinto";
  if (["white", "blanco"].includes(normalized)) return "blanco";
  if (["rose", "rosado"].includes(normalized)) return "rosado";
  if (["sparkling", "cava", "champagne", "espumoso"].includes(normalized)) return "espumoso";
  if (["sweet", "dessert", "postre", "dulce"].includes(normalized)) return "dulce";
  if (["generoso", "fortificado", "fortified"].includes(normalized)) return "fortificado";
  return normalized;
}

export function agoraProductColor(connection: unknown, wineType: unknown, fallback = "#8B0000"): string {
  const config = providerConfig(connection);
  const configured = config.agora_product_color_by_wine_type;
  const colors = configured && typeof configured === "object"
    ? configured as Record<string, unknown>
    : {};
  const canonicalType = canonicalAgoraWineType(wineType);
  const candidate = String(colors[canonicalType] ?? "").trim().toUpperCase();
  if (AGORA_HEX_COLOR.test(candidate)) return candidate;
  return AGORA_DEFAULT_COLOR_BY_WINE_TYPE[canonicalType] || fallback;
}

export type AgoraGlassPresentationCandidate = {
  key: string;
  name: unknown;
  wineType: unknown;
};

export type AgoraExistingGlassPresentation = {
  name: unknown;
  wineType: unknown;
  order: unknown;
};

export function compareAgoraGlassPresentation(
  left: Pick<AgoraGlassPresentationCandidate, "name" | "wineType">,
  right: Pick<AgoraGlassPresentationCandidate, "name" | "wineType">,
): number {
  const leftType = canonicalAgoraWineType(left.wineType);
  const rightType = canonicalAgoraWineType(right.wineType);
  return (AGORA_WINE_TYPE_ORDER[leftType] ?? 999) - (AGORA_WINE_TYPE_ORDER[rightType] ?? 999) ||
    compareAgoraWineNames(left.name, right.name);
}

export function buildAgoraGlassPresentation(
  connection: unknown,
  candidates: AgoraGlassPresentationCandidate[],
  orderStep = 100,
): Record<string, { order: number; color: string }> {
  const result: Record<string, { order: number; color: string }> = {};
  [...candidates].sort(compareAgoraGlassPresentation).forEach((candidate, index) => {
    result[candidate.key] = {
      order: (index + 1) * orderStep,
      color: agoraProductColor(connection, candidate.wineType),
    };
  });
  return result;
}

export function nextAgoraGlassOrder(
  wineType: unknown,
  wineName: unknown,
  existing: AgoraExistingGlassPresentation[],
): number {
  const targetType = canonicalAgoraWineType(wineType);
  const sameType = existing
    .filter((product) => canonicalAgoraWineType(product.wineType) === targetType)
    .map((product) => ({ ...product, numericOrder: Number(product.order) }))
    .filter((product) => Number.isSafeInteger(product.numericOrder) && product.numericOrder > 0)
    .sort((left, right) => left.numericOrder - right.numericOrder || compareAgoraWineNames(left.name, right.name));
  const insertionIndex = sameType.findIndex((product) => compareAgoraWineNames(wineName, product.name) < 0);
  const previous = insertionIndex === 0 ? null : sameType[insertionIndex < 0 ? sameType.length - 1 : insertionIndex - 1];
  const next = insertionIndex < 0 ? null : sameType[insertionIndex];
  if (previous && next && next.numericOrder - previous.numericOrder > 1) {
    return Math.floor((previous.numericOrder + next.numericOrder) / 2);
  }
  if (!previous && next && next.numericOrder > 1) return Math.floor(next.numericOrder / 2);
  if (previous) {
    const occupiedOrders = new Set(
      existing
        .map((product) => Number(product.order))
        .filter((order) => Number.isSafeInteger(order) && order > 0),
    );
    let candidate = previous.numericOrder + 1;
    while (occupiedOrders.has(candidate)) candidate++;
    return candidate;
  }

  const typeRank = AGORA_WINE_TYPE_ORDER[canonicalAgoraWineType(wineType)] ?? 9;
  return (typeRank + 1) * 100_000;
}

export type AgoraButtonTextCandidate = {
  key: string;
  technicalName: unknown;
  existingButtonText?: unknown;
};

function normalizeVisibleLabel(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function suffixAwareButtonText(technicalName: unknown, maxLength: number): string {
  const plain = stripAgoraFormatPrefix(technicalName)
    .replace(/\s+&\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxLength) return plain;
  const words = plain.split(" ").filter(Boolean);
  const suffix = words.at(-1) || "";
  if (!suffix || suffix.length >= maxLength - 2) return plain.slice(0, maxLength);
  const prefixBudget = maxLength - suffix.length - 1;
  const prefix = plain.slice(0, prefixBudget).trim();
  return `${prefix} ${suffix}`.slice(0, maxLength).trim();
}

function stripMatchingFormatPrefix(value: unknown, technicalName: unknown): string {
  const label = String(value ?? "").replace(/\s+/g, " ").trim();
  const technical = String(technicalName ?? "").replace(/\s+/g, " ").trim();
  if (/^(?:B|BOT(?:ELLA)?)\s+/i.test(technical)) {
    return label.replace(/^(?:B|BOT(?:ELLA)?)\s+/i, "").trim();
  }
  if (/^(?:C|COPA)\s+/i.test(technical)) {
    return label.replace(/^(?:C|COPA)\s+/i, "").trim();
  }
  if (/^(?:M|MAG(?:NUM)?)\s+/i.test(technical)) {
    return label.replace(/^(?:M|MAG(?:NUM)?)\s+/i, "").trim();
  }
  return label;
}

function numberedButtonText(label: string, index: number, maxLength: number): string {
  const suffix = ` ${index}`;
  return `${label.slice(0, Math.max(1, maxLength - suffix.length)).trim()}${suffix}`;
}

function numberedFormatSuffixButtonText(label: string, index: number, maxLength: number): string {
  const match = /\s(\[[BCM]\])$/i.exec(label);
  if (!match) return numberedButtonText(label, index, maxLength);
  const marker = ` ${match[1].toUpperCase()}`;
  const ordinal = ` ${index}`;
  const plain = label.slice(0, match.index).trim();
  const nameBudget = Math.max(1, maxLength - marker.length - ordinal.length);
  return `${plain.slice(0, nameBudget).trim()}${ordinal}${marker}`;
}

export function buildUniqueAgoraButtonTexts(
  connection: unknown,
  candidates: AgoraButtonTextCandidate[],
  maxLength = 20,
): Record<string, string> {
  const result: Record<string, string> = {};
  const candidateByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const preserveFormatSuffix = agoraProductButtonTextMode(connection) ===
    AGORA_BUTTON_TEXT_WINE_NAME_WITH_FORMAT_SUFFIX;

  for (const candidate of candidates) {
    result[candidate.key] = agoraProductButtonText(connection, candidate.technicalName, maxLength);
  }

  const groups = new Map<string, string[]>();
  for (const candidate of candidates) {
    const normalized = normalizeVisibleLabel(result[candidate.key]);
    const keys = groups.get(normalized) || [];
    keys.push(candidate.key);
    groups.set(normalized, keys);
  }

  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    if (preserveFormatSuffix) {
      keys.forEach((key, index) => {
        result[key] = numberedFormatSuffixButtonText(result[key], index + 1, maxLength);
      });
      continue;
    }
    const existingLabels = keys.map((key) => {
      const candidate = candidateByKey.get(key);
      const existing = stripMatchingFormatPrefix(candidate?.existingButtonText, candidate?.technicalName)
        .slice(0, maxLength)
        .trim();
      return existing;
    });
    const existingKeys = existingLabels.map(normalizeVisibleLabel);
    if (existingLabels.every(Boolean) && new Set(existingKeys).size === keys.length) {
      keys.forEach((key, index) => { result[key] = existingLabels[index]; });
      continue;
    }

    const suffixLabels = keys.map((key) =>
      suffixAwareButtonText(candidateByKey.get(key)?.technicalName, maxLength)
    );
    const suffixKeys = suffixLabels.map(normalizeVisibleLabel);
    if (suffixLabels.every(Boolean) && new Set(suffixKeys).size === keys.length) {
      keys.forEach((key, index) => { result[key] = suffixLabels[index]; });
      continue;
    }

    keys.forEach((key, index) => {
      result[key] = numberedButtonText(result[key], index + 1, maxLength);
    });
  }

  const used = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.key;
    const original = result[key];
    let next = original;
    let occurrence = 2;
    while (used.has(normalizeVisibleLabel(next))) {
      next = preserveFormatSuffix
        ? numberedFormatSuffixButtonText(original, occurrence, maxLength)
        : numberedButtonText(original, occurrence, maxLength);
      occurrence++;
    }
    result[key] = next;
    used.add(normalizeVisibleLabel(next));
  }

  return result;
}

export function compareAgoraWineNames(a: unknown, b: unknown): number {
  const left = stripAgoraFormatPrefix(a);
  const right = stripAgoraFormatPrefix(b);
  return left.localeCompare(right, "es", { sensitivity: "base", numeric: true }) ||
    String(a ?? "").localeCompare(String(b ?? ""), "es", { sensitivity: "base", numeric: true });
}
