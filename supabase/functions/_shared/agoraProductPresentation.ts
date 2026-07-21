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
  return visibleName.length <= maxLength ? visibleName : visibleName.slice(0, maxLength);
}

export function compareAgoraWineNames(a: unknown, b: unknown): number {
  const left = stripAgoraFormatPrefix(a);
  const right = stripAgoraFormatPrefix(b);
  return left.localeCompare(right, "es", { sensitivity: "base", numeric: true }) ||
    String(a ?? "").localeCompare(String(b ?? ""), "es", { sensitivity: "base", numeric: true });
}
