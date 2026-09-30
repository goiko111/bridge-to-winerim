// Aprobado por Goiko 2026-09-30 19:49 (caso Emilio Moro, El Higuerón).
// Sustituye ambiguousReopenFrozenProductIds (congela el PRODUCTO todo el día) en
// agora-proxy (l.~2911/2923). Caso real 30-sep El Higuerón: T 20549 (22-sep) pasado a
// factura con nombre → J 593 (ConvertToStandard) + F 512 a la misma hora. La factura
// original es de otro día, así que J 593 queda AMBIGUOUS y congelaba C Emilio Moro y
// B Valdelainos todo el día (19 copas sin enviar).
//
// Regla nueva: una devolución Reopen/ConvertToStandard ambigua congela solo:
//   - sus propias líneas (ya lo está: no es elegible para stock), y
//   - el documento reemitido que la anula línea a línea (misma huella de línea).
// Si no se encuentra un reemitido único y exacto → falla cerrado como hoy (producto
// entero congelado ese día). Funciones puras, sin E/S.

type Json = Record<string, unknown>;
export type Ev = { id: string; doc_type?: string | null; raw_json?: unknown };

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => String(v ?? "").trim();

function linesOf(raw: Json): Json[] {
  const out: Json[] = [];
  for (const it of Array.isArray(raw.InvoiceItems) ? raw.InvoiceItems : []) {
    for (const l of Array.isArray(obj(it).Lines) ? (obj(it).Lines as unknown[]) : []) out.push(obj(l));
  }
  return out;
}
const isRefund = (e: Ev) => obj(e.raw_json)._agora_refund === true || /refund/i.test(str(e.doc_type));
const isReopenOrConvert = (e: Ev) => ["reopen", "converttostandard"].includes(str(obj(e.raw_json).RefundSource).toLowerCase());
const fp = (l: Json) => [str(l.ProductId), str(l.SaleFormatId), str(l.Index), str(l.CreationDate), Number(l.UnitPrice ?? 0).toFixed(2)].join("|");

function qtyByFp(raw: Json, sign: 1 | -1): Map<string, number> | null {
  const m = new Map<string, number>();
  for (const l of linesOf(raw)) {
    if (!str(l.CreationDate)) return null;
    m.set(fp(l), (m.get(fp(l)) || 0) + Number(l.Quantity ?? 0) * sign);
  }
  return m.size ? m : null;
}
function sameMap(a: Map<string, number>, b: Map<string, number>) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (Math.abs((b.get(k) ?? NaN) - v) > 1e-9) return false;
  return true;
}

export type FreezeDecision = {
  /** Eventos que no deben contar en el objetivo del día (documento reemitido). */
  frozenEventIds: Set<string>;
  /** Fallback fail-closed: productos congelados todo el día (sin reemitido demostrable). */
  frozenProductIds: Set<string>;
};

/**
 * `ambiguousRefundIds`: devoluciones que classifyAgoraRefunds marcó AMBIGUOUS.
 * Para cada una de tipo Reopen/ConvertToStandard busca un documento no-devolución del
 * mismo día cuyas líneas sean exactamente el negativo de la devolución.
 */
export function convertRefundFreeze(events: Ev[], ambiguousRefundIds: Set<string>): FreezeDecision {
  const frozenEventIds = new Set<string>();
  const frozenProductIds = new Set<string>();
  const docs = events.filter((e) => !isRefund(e) && str(e.doc_type).toLowerCase() !== "openticket");
  for (const refund of events) {
    if (!ambiguousRefundIds.has(refund.id) || !isReopenOrConvert(refund)) continue;
    const rq = qtyByFp(obj(refund.raw_json), -1);
    const reissued = rq ? docs.filter((d) => { const q = qtyByFp(obj(d.raw_json), 1); return q && sameMap(q, rq); }) : [];
    if (reissued.length === 1 && !frozenEventIds.has(reissued[0].id)) {
      frozenEventIds.add(reissued[0].id);
      continue;
    }
    for (const l of linesOf(obj(refund.raw_json))) if (str(l.ProductId)) frozenProductIds.add(str(l.ProductId));
  }
  return { frozenEventIds, frozenProductIds };
}

export function isFrozen(line: { sales_event_id: string; provider_product_id?: unknown }, d: FreezeDecision): boolean {
  return d.frozenEventIds.has(line.sales_event_id) || d.frozenProductIds.has(str(line.provider_product_id));
}

import { classifyAgoraRefunds, type LifecycleEvent } from "./agoraTicketLifecycle.ts";

/** Decisión completa del día: clasifica devoluciones y congela solo el reemitido exacto. */
export function dayConvertRefundFreeze(events: LifecycleEvent[]): FreezeDecision {
  const ambiguous = new Set(classifyAgoraRefunds(events).filter((c) => c.kind === "AMBIGUOUS").map((c) => c.refundEventId));
  return convertRefundFreeze(events as Ev[], ambiguous);
}
