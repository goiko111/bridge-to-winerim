// Per-line business-day attribution (opt-in per connection: provider_config.line_time_attribution="PROVIDER_LINE").
// Uses ONLY the exact per-line provider_sold_at (local wall time of the connection timezone) against the
// binding's [localFrom, localTo) cutoff window. Never falls back to the aggregated header sold_at/business_day.
// Missing/invalid timestamps fail closed (caller must mark the source incomplete → SOURCE_INCOMPLETE).
export const PROVIDER_LINE = "PROVIDER_LINE";

export function lineTimeAttributionMode(providerConfig: unknown): "PROVIDER_LINE" | "EVENT_DAY" {
  const value = providerConfig && typeof providerConfig === "object" ? (providerConfig as Record<string, unknown>).line_time_attribution : null;
  return value === PROVIDER_LINE ? PROVIDER_LINE : "EVENT_DAY";
}

const LOCAL_TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;

export function normalizeLocalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = LOCAL_TS.exec(value.trim()); if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number) as unknown as number[];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

type Line = { provider_sold_at?: string | null; sales_event: { business_day: string } & Record<string, unknown> };

export function attributeByProviderLine<T extends Line>(lines: T[], window: { businessDay: string; localFrom: string; localTo: string }) {
  const kept: T[] = []; let invalidTimestamp = 0; let outsideWindow = 0;
  for (const line of lines) {
    const at = normalizeLocalTimestamp(line.provider_sold_at);
    if (!at) { invalidTimestamp++; continue; }
    if (at < window.localFrom || at >= window.localTo) { outsideWindow++; continue; }
    kept.push({ ...line, sales_event: { ...line.sales_event, business_day: window.businessDay } });
  }
  return { lines: kept, invalidTimestamp, outsideWindow, complete: invalidTimestamp === 0 };
}
