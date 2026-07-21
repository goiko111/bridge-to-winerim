export const AGORA_SORT_ALPHABETICAL_WINE_NAME = "ALPHABETICAL_WINE_NAME";
export const AGORA_BUTTON_TEXT_WINE_NAME_ONLY = "WINE_NAME_ONLY";

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

export function agoraProductButtonText(connection: unknown, technicalName: unknown, maxLength = 20): string {
  const normalized = String(technicalName ?? "").replace(/\s+/g, " ").trim();
  const visibleName = agoraProductButtonTextMode(connection) === AGORA_BUTTON_TEXT_WINE_NAME_ONLY
    ? stripAgoraFormatPrefix(normalized)
    : normalized;
  return (visibleName.length <= maxLength ? visibleName : visibleName.slice(0, maxLength)).trim();
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

export function buildUniqueAgoraButtonTexts(
  connection: unknown,
  candidates: AgoraButtonTextCandidate[],
  maxLength = 20,
): Record<string, string> {
  const result: Record<string, string> = {};
  const candidateByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));

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
      next = numberedButtonText(original, occurrence, maxLength);
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
