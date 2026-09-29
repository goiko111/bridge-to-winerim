import { canonicalFormat, reconcileLines } from "./engine.ts";
import type { AgoraLine, ReconciliationResult, SaleDeletion, SourceCompleteness, WinerimLine } from "./types.ts";

// Manual AUDIT_ONLY reconciliation fed by an in-memory historicalRange read.
// Only used by run-daily-reconciliation when salesSourceMode === "historical_range".
export const HISTORICAL_SALES_SOURCE_MODE = "historical_range";

const fail = (code: string, message: string) => Object.assign(new Error(message), { status: 400, code });
const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const str = (v: unknown) => v == null || v === "" ? null : String(v);
const num = (v: unknown) => v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function validateHistoricalReconcileRequest(body: { salesSourceMode?: unknown; dryRun?: unknown; businessDay?: unknown }): void {
  if (body.salesSourceMode !== HISTORICAL_SALES_SOURCE_MODE) throw fail("INVALID_SALES_SOURCE_MODE", "salesSourceMode solo admite 'historical_range'");
  if (body.dryRun !== true) throw fail("HISTORICAL_DRY_RUN_REQUIRED", "historical_range exige dryRun:true");
  if (typeof body.businessDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.businessDay) || Number.isNaN(Date.parse(`${body.businessDay}T00:00:00Z`))) throw fail("INVALID_BUSINESS_DAY", "historical_range exige businessDay explícito");
}

/** Maps historicalRange sale records to engine lines, keeping only lines whose local effectiveAt is inside the business window. */
export function rangeRecordsToWinerimLines(records: unknown[], restaurantId: number, businessDay: string, localFrom: string, localTo: string): WinerimLine[] {
  const out: WinerimLine[] = [];
  for (const raw of records) {
    const record = obj(raw); if (!record) continue;
    const wineId = str(obj(record.wine)?.wineId); const status = str(record.status) ?? "confirmed";
    for (const rawLine of Array.isArray(record.lines) ? record.lines : []) {
      const line = obj(rawLine); if (!line) continue;
      const effectiveAt = str(line.effectiveAt); if (!effectiveAt || effectiveAt < localFrom || effectiveAt >= localTo) continue;
      const source = obj(line.source) ?? {}; const stock = obj(line.stockEffect) ?? {};
      const movements = Array.isArray(stock.movements) ? stock.movements.map(obj).filter((m): m is Record<string, unknown> => Boolean(m)) : [];
      const total = num(line.totalAmount);
      out.push({
        restaurantId, saleId: Number(record.saleId), lineId: String(line.lineId), saleDetailId: num(line.saleDetailId),
        saleStatus: status as WinerimLine["saleStatus"], sourceSystem: str(source.sourceSystem), externalOrderId: str(source.externalOrderId), orderId: str(source.orderId),
        sourceLineId: str(source.sourceLineId), invoiceId: str(source.invoiceId), receiptId: str(source.receiptId) ?? str(stock.receiptId),
        wineId: String(wineId), format: str(line.format), quantity: Number(line.qty), amountMinor: total == null ? null : Math.round(total * 100), effectiveAt, businessDay,
        stockEffect: {
          known: stock.known === true, status: str(stock.status) ?? "UNKNOWN", stockApplied: typeof stock.stockApplied === "boolean" ? stock.stockApplied : null,
          receiptId: str(stock.receiptId), movementIds: movements.map((m) => Number(m.stockMovementId)).filter(Number.isFinite),
          movementDifference: movements.length && movements.every((m) => num(m.difference) != null) ? movements.reduce((s, m) => s + Number(m.difference), 0) : null,
          unbackedQty: num(stock.unbackedQty),
        },
      });
    }
  }
  return out;
}

/** Union of range and persisted lines for the same day; one line per saleId+lineId (range wins). */
export function mergeWinerimEvidence(range: WinerimLine[], persisted: WinerimLine[]) {
  const map = new Map<string, WinerimLine>(); let persistedOnly = 0;
  for (const line of range) map.set(`${line.saleId}|${line.lineId}`, line);
  for (const line of persisted) { const key = `${line.saleId}|${line.lineId}`; if (!map.has(key)) { map.set(key, line); persistedOnly += 1; } }
  return { lines: [...map.values()], persistedOnly };
}

const economicKey = (a: AgoraLine) => [a.businessDay, norm(a.wineId), canonicalFormat(a.format), a.quantity, a.amountMinor ?? "null", a.effectiveAt, norm(a.providerProductId)].join("|");

/** Drops an OPEN representation only when exactly one closed line has the same economic identity and vice versa. */
export function dedupeAgoraRepresentations(agora: AgoraLine[]) {
  const closedBy = new Map<string, AgoraLine[]>(); const openBy = new Map<string, AgoraLine[]>();
  for (const line of agora) { if (line.isCancelled) continue; const target = line.isOpen ? openBy : closedBy; const key = economicKey(line); target.set(key, [...(target.get(key) ?? []), line]); }
  const superseded = new Set<AgoraLine>();
  for (const [key, opens] of openBy) { const closed = closedBy.get(key) ?? []; if (opens.length === 1 && closed.length === 1) superseded.add(opens[0]); }
  return { economic: agora.filter((line) => !superseded.has(line)), supersededOpen: [...superseded].map((line) => ({ documentId: line.documentId, wineId: line.wineId, format: line.format, quantity: line.quantity, amountMinor: line.amountMinor, effectiveAt: line.effectiveAt })) };
}

const signature = (a: AgoraLine, w: WinerimLine) => a.businessDay === (w.businessDay ?? w.effectiveAt.slice(0, 10)) && a.effectiveAt === w.effectiveAt && norm(a.wineId) === norm(w.wineId) && canonicalFormat(a.format) === canonicalFormat(w.format);

/** Historical-mode only: HISTORY_MISSING becomes AMBIGUOUS when ≥2 distinct saleIds share the signature and sum exactly. Nothing is grouped or consumed. */
export function markMultiSaleAmbiguity(results: ReconciliationResult[], winerim: WinerimLine[]): ReconciliationResult[] {
  return results.map((row) => {
    if (row.state !== "HISTORY_MISSING" || !row.agora || row.agora.amountMinor == null) return row;
    const agora = row.agora; const candidates = winerim.filter((w) => signature(agora, w));
    if (new Set(candidates.map((w) => w.saleId)).size < 2 || candidates.some((w) => w.amountMinor == null)) return row;
    const qty = candidates.reduce((s, w) => s + w.quantity, 0); const amount = candidates.reduce((s, w) => s + Number(w.amountMinor), 0);
    if (qty !== agora.quantity || Math.round(amount) !== Math.round(agora.amountMinor)) return row;
    return { ...row, state: "AMBIGUOUS", evidence: { reason: "MULTI_SALE_SIGNATURE_SUM", matchKind: "NOT_GROUPED_DISTINCT_SALES", candidateLineIds: candidates.map((w) => w.lineId), candidateSaleIds: [...new Set(candidates.map((w) => w.saleId))] }, manualAction: "Revisión manual; ventas Winerim distintas no se agrupan ni se consumen" };
  });
}

export function reconcileHistorical(input: { connectionId: string; agora: AgoraLine[]; rangeLines: WinerimLine[]; persistedLines: WinerimLine[]; deletions: SaleDeletion[]; completeness: SourceCompleteness }) {
  const { economic, supersededOpen } = dedupeAgoraRepresentations(input.agora);
  const merged = mergeWinerimEvidence(input.rangeLines, input.persistedLines);
  const results = markMultiSaleAmbiguity(reconcileLines({ connectionId: input.connectionId, agora: economic, winerim: merged.lines, deletions: input.deletions, completeness: input.completeness }), merged.lines);
  return { results, economicAgora: economic, supersededOpen, winerimLines: merged.lines, persistedOnlyLines: merged.persistedOnly };
}
