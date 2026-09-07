// Per-connection gate for publishing the non-legacy Winerim formats
// (media botella, botella pequeña, jeroboam, matusalem, salmanazar…).
//
// The format catalog and the winerim_wine_formats persistence run for EVERY
// connection: they are read-only observations of what Winerim exposes.
// Publishing those formats as POS buttons and deducting their stock is opt-in
// per connection via provider_config, so the rollout stays canary-first.
//
//   provider_config.extended_formats_enabled = true   → publish + deduct
//   provider_config.extended_formats_disabled_keys    → per-format exclusions
//
// Fail-closed: anything unset or not exactly `true` keeps the historical
// bottle/glass/magnum-only behaviour.

import { isLegacyWinerimFormat, winerimFormatKey } from "./winerimFormats.ts";

export function isExtendedFormatsConnection(
  _connectionId: unknown,
  providerConfig: Record<string, unknown> | null | undefined,
): boolean {
  return providerConfig?.extended_formats_enabled === true;
}

/** Format keys explicitly excluded for this connection. */
export function extendedFormatsExcludedKeys(
  providerConfig: Record<string, unknown> | null | undefined,
): string[] {
  const raw = providerConfig?.extended_formats_disabled_keys;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => winerimFormatKey(value))
    .filter((key): key is string => typeof key === "string" && key.length > 0);
}

/**
 * True when this format may be published/deducted for this connection.
 * Legacy formats are always allowed; extended ones require the opt-in.
 */
export function isFormatEnabledForConnection(
  format: unknown,
  providerConfig: Record<string, unknown> | null | undefined,
): boolean {
  const key = winerimFormatKey(format);
  if (!key) return false;
  if (isLegacyWinerimFormat(key)) return true;
  if (!isExtendedFormatsConnection(null, providerConfig)) return false;
  return !extendedFormatsExcludedKeys(providerConfig).includes(key);
}
