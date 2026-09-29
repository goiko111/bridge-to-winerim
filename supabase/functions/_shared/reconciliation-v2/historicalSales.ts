import { addBusinessDays, businessWindow, type BindingMetadata } from "./time.ts";
import type { WinerimFleetClient } from "./winerimFleetClient.ts";

// Isolated, read-only historical range read for sync-sales-records.
// from/to are the only authority: no checkpoint, cursor or overlap state is read or written.
export const HISTORICAL_MAX_DAYS = 7;
export const HISTORICAL_MAX_PAGES = 100;

export type HistoricalRangeInput = { historicalRange?: unknown; from?: unknown; to?: unknown; dryRun?: unknown; maxPages?: unknown };
export type HistoricalRange = { from: string; to: string; maxPages: number; timezone: string; cutoff: number; businessDays: string[] };

const fail = (code: string, message: string) => Object.assign(new Error(message), { status: 400, code });
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function localDate(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

/** Returns the business day whose cutoff boundary equals `instant`, or null if not aligned. */
function alignedBusinessDay(binding: BindingMetadata, instant: string): string | null {
  const ms = Date.parse(instant);
  const base = localDate(instant, businessWindow(binding, "2000-01-01").timezone);
  for (const day of [addBusinessDays(base, -1), base, addBusinessDays(base, 1)]) {
    if (Date.parse(businessWindow(binding, day).from) === ms) return day;
  }
  return null;
}

export function validateHistoricalRange(body: HistoricalRangeInput, binding: BindingMetadata, now = Date.now()): HistoricalRange {
  if (body.historicalRange !== true) throw fail("HISTORICAL_RANGE_REQUIRED", "historicalRange debe ser true");
  if (body.dryRun !== true) throw fail("HISTORICAL_DRY_RUN_REQUIRED", "El modo histórico exige dryRun:true");
  if (typeof body.from !== "string" || typeof body.to !== "string" || !ISO_OFFSET.test(body.from) || !ISO_OFFSET.test(body.to)) throw fail("INVALID_HISTORICAL_RANGE", "from/to deben ser ISO-8601 con offset");
  const fromMs = Date.parse(body.from); const toMs = Date.parse(body.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw fail("INVALID_HISTORICAL_RANGE", "from/to inválidos");
  if (fromMs >= toMs) throw fail("INVALID_HISTORICAL_RANGE", "from debe ser anterior a to");
  if (toMs > now) throw fail("INVALID_HISTORICAL_RANGE", "to no puede ser futuro");
  if (now - fromMs > 370 * 86_400_000) throw fail("INVALID_HISTORICAL_RANGE", "from fuera del rango permitido");
  const maxPages = body.maxPages === undefined ? HISTORICAL_MAX_PAGES : body.maxPages;
  if (!Number.isInteger(maxPages) || (maxPages as number) < 1 || (maxPages as number) > HISTORICAL_MAX_PAGES) throw fail("INVALID_MAX_PAGES", "maxPages debe ser entero entre 1 y 100");
  const fromDay = alignedBusinessDay(binding, body.from); const toDay = alignedBusinessDay(binding, body.to);
  if (!fromDay || !toDay) throw fail("RANGE_NOT_CUTOFF_ALIGNED", "from/to deben coincidir con el corte de jornada de la conexión");
  const businessDays: string[] = [];
  for (let day = fromDay; day < toDay; day = addBusinessDays(day, 1)) businessDays.push(day);
  if (businessDays.length < 1 || businessDays.length > HISTORICAL_MAX_DAYS) throw fail("HISTORICAL_RANGE_TOO_LONG", "El rango máximo es de 7 días de negocio");
  const window = businessWindow(binding, fromDay);
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), maxPages: maxPages as number, timezone: window.timezone, cutoff: window.cutoff, businessDays };
}

type RecordLike = { saleId?: unknown; lines?: unknown; wine?: { wineId?: unknown } };
type LineLike = { effectiveAt?: unknown; recordedAt?: unknown; format?: unknown; qty?: unknown; totalAmount?: unknown; lineType?: unknown; lineId?: unknown; source?: { sourceLineId?: unknown; invoiceId?: unknown } };
export type HistoricalLineSummary = { saleId: unknown; wineId: unknown; lineId: unknown; lineType: unknown; format: unknown; qty: unknown; totalAmount: unknown; effectiveAt: unknown; invoiceId: unknown };

export async function readHistoricalRange(client: Pick<WinerimFleetClient, "salesByDate" | "callCount">, restaurantId: number, range: HistoricalRange) {
  const records: unknown[] = []; let pagesRead = 0; let complete = false; let reportedTotal: number | null = null;
  for (let page = 1; page <= range.maxPages; page += 1) {
    const result = await client.salesByDate(restaurantId, { from: range.from, to: range.to, page });
    pagesRead += 1; records.push(...result.data); reportedTotal = result.pagination?.total ?? reportedTotal;
    if (!result.pagination!.hasMore) { complete = true; break; }
  }
  const timestamps: string[] = []; let lineCount = 0; let linesWithoutTimestamp = 0; const lineSummary: HistoricalLineSummary[] = [];
  for (const record of records as RecordLike[]) {
    const lines = Array.isArray(record?.lines) ? record.lines as LineLike[] : [];
    lineCount += lines.length;
    for (const line of lines) {
      lineSummary.push({ saleId: record?.saleId ?? null, wineId: record?.wine?.wineId ?? null, lineId: line?.lineId ?? null, lineType: line?.lineType ?? null, format: line?.format ?? null, qty: line?.qty ?? null, totalAmount: line?.totalAmount ?? null, effectiveAt: line?.effectiveAt ?? null, invoiceId: line?.source?.invoiceId ?? null });
      const value = typeof line?.effectiveAt === "string" ? line.effectiveAt : typeof line?.recordedAt === "string" ? line.recordedAt : null;
      if (value) timestamps.push(value); else linesWithoutTimestamp += 1;
    }
  }
  timestamps.sort();
  const totalMatches = reportedTotal == null ? null : reportedTotal === records.length;
  return {
    records,
    evidence: {
      from: range.from, to: range.to, timezone: range.timezone, cutoff: range.cutoff, businessDays: range.businessDays,
      pagesRead, calls: client.callCount, records: records.length, lines: lineCount, linesWithoutTimestamp,
      deletions: "NOT_AVAILABLE_IN_DATE_MODE" as const, reportedTotal,
      firstTimestamp: timestamps[0] ?? null, lastTimestamp: timestamps.at(-1) ?? null,
      finalCursor: "NOT_AVAILABLE_IN_DATE_MODE" as const, paginationEnded: complete,
      coverageComplete: complete && totalMatches !== false,
      lineSummary,
    },
  };
}
