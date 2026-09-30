// La devolución de stock de un ticket abierto "caducado" solo puede actuar cuando
// su día de negocio está cerrado (cutoffHour del día siguiente, hora local) y el
// ticket no tiene factura vinculada por GlobalId. Evita el caso Q Tomas 29-sep:
// devolver a las 00:25 un abierto que se facturó a las 02:05.

export function localParts(nowIso: string, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(nowIso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** Día de negocio en curso: antes de la hora de corte sigue siendo el día anterior. */
export function currentBusinessDay(nowIso: string, timeZone: string, cutoffHour = 6): string {
  const { day, hour } = localParts(nowIso, timeZone);
  if (hour >= cutoffHour) return day;
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function isBusinessDayClosed(day: string, nowIso: string, timeZone: string, cutoffHour = 6): boolean {
  return currentBusinessDay(nowIso, timeZone, cutoffHour) > day;
}

export function openTicketGlobalId(event: { provider_doc_id?: string | null; raw_json?: unknown }): string | null {
  const raw = event.raw_json && typeof event.raw_json === "object" ? event.raw_json as Record<string, unknown> : null;
  const g = raw?.GlobalId ?? raw?.globalId;
  if (g != null && String(g).trim()) return String(g).trim();
  const doc = String(event.provider_doc_id || "");
  return doc.startsWith("open_ticket:") ? doc.slice("open_ticket:".length) : null;
}

export function openTicketRestoreAllowed(input: {
  event: { business_day: string; provider_doc_id?: string | null; raw_json?: unknown };
  nowIso: string;
  timeZone: string;
  cutoffHour?: number;
  invoicedGlobalIds: Set<string>;
}): boolean {
  if (!isBusinessDayClosed(input.event.business_day, input.nowIso, input.timeZone, input.cutoffHour ?? 6)) return false;
  const gid = openTicketGlobalId(input.event);
  return !(gid && input.invoicedGlobalIds.has(gid));
}
