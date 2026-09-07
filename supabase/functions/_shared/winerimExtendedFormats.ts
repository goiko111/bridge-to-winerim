// Per-connection gate for publishing the non-legacy Winerim formats
// (media botella, botella pequeña, jeroboam, matusalem, salmanazar…).
//
// The format catalog and the winerim_wine_formats persistence run for EVERY
// connection: they are read-only observations of what Winerim exposes.
// Publishing those formats as POS buttons and deducting their stock is opt-in
// per connection via provider_config, so the rollout stays canary-first.
//
// Publishing is now ON by default, with explicit opt-outs:
//
//   provider_config.extended_formats_enabled = false   → opt out completely
//   provider_config.extended_formats_disabled_keys     → per-format exclusions
//   EXTENDED_FORMATS_EXCLUDED_CONNECTION_IDS           → connections held back
//
// Only formats that are active and priced in Winerim ever reach the POS, so a
// connection without extended formats keeps behaving exactly as before.

import { isLegacyWinerimFormat, winerimFormatKey } from "./winerimFormats.ts";

/**
 * Connections explicitly held back from publishing extended formats.
 * Ocean Club: its Agora is not to receive new buttons for now (2026-09-07).
 */
export const EXTENDED_FORMATS_EXCLUDED_CONNECTION_IDS: readonly string[] = [
  "706b952e-767d-41af-9cba-8e225b16a877", // Ocean Club
];

export function isExtendedFormatsConnection(
  connectionId: unknown,
  providerConfig: Record<string, unknown> | null | undefined,
): boolean {
  const id = String(connectionId ?? "").trim().toLowerCase();
  if (id && EXTENDED_FORMATS_EXCLUDED_CONNECTION_IDS.includes(id)) return false;
  return providerConfig?.extended_formats_enabled !== false;
}

/** Format keys explicitly excluded for this connection. */
export function extendedFormatsExcludedKeys(
  providerConfig: Record<string, unknown> | null | undefined,
): string[] {
  const raw = providerConfig?.extended_formats_disabled_keys;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => winerimFormatKey(value))
    .filter((key): key is NonNullable<typeof key> => key !== null && key.length > 0);
}

/**
 * True when this format may be published/deducted for this connection.
 * Legacy formats are always allowed; extended ones require the opt-in.
 */
export function isFormatEnabledForConnection(
  format: unknown,
  providerConfig: Record<string, unknown> | null | undefined,
  connectionId?: unknown,
): boolean {
  const key = winerimFormatKey(format);
  if (!key) return false;
  if (isLegacyWinerimFormat(key)) return true;
  if (!isExtendedFormatsConnection(connectionId, providerConfig)) return false;
  return !extendedFormatsExcludedKeys(providerConfig).includes(key);
}
