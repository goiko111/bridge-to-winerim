// READ-ONLY forensic audit of Agora reopen/convert/refund cases against Winerim.
// Run with bun (imports the TS lifecycle module). Never writes to Agora, Winerim or DB.
// Groups by restaurant + businessDay + providerProductId + format; the daily
// excess is computed ONCE per group, never repeated per refund event.
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { classifyAgoraRefunds } from "../supabase/functions/_shared/agoraTicketLifecycle.ts";

const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
  const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
const SB = env.VITE_SUPABASE_URL;
const session = JSON.parse(fs.readFileSync(`${os.homedir()}/.cache/lovable-auth/session.json`, "utf8")).session;
const H = { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${session.access_token}` };
const FROM = process.argv[2] || "2026-09-01";
const TO = process.argv[3] || "2026-09-30";
const OUT = process.argv[4] || "/mnt/documents";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { ...H, Range: `${off}-${off + 999}` } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const rows = await r.json(); out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
const addDay = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function fmtKey(name) {
  const s = String(name || "").toUpperCase();
  if (/COPA|CP\b|GLASS/.test(s)) return "copa";
  if (/MAGNUM|MG\b/.test(s)) return "magnum";
  if (/MEDIA|1\/2|375/.test(s)) return "media";
  return "botella";
}
const recCache = new Map();
async function winerimRecords(conn, token, day) {
  const k = `${conn}|${day}`;
  if (recCache.has(k)) return recCache.get(k);
  const out = []; let err = null;
  for (let page = 1; page < 50; page++) {
    await sleep(350);
    let r;
    for (let a = 0; a < 3; a++) {
      r = await fetch(`https://app.winerim.com/api/v2/sales/records?from=${day}&to=${addDay(day, 1)}&limit=100&page=${page}`, { headers: { "WINERIM-API-TOKEN": token, Accept: "application/json" } });
      if (r.status !== 503 && r.status !== 429) break;
      await sleep(3000 * (a + 1));
    }
    if (!r.ok) { err = `HTTP ${r.status}`; break; }
    const j = await r.json(); out.push(...(j.data || []));
    if (!j.pagination?.hasMore) break;
  }
  const v = { rows: out, err }; recCache.set(k, v); return v;
}

const conns = new Map((await get("pos_connections?select=id,location_name,winerim_api_token,enabled&provider=eq.agora")).map((c) => [c.id, c]));
const refunds = await get(`sales_events?select=id,connection_id,business_day&business_day=gte.${FROM}&business_day=lte.${TO}&raw_json->>_agora_refund=eq.true`);
const dayKeys = [...new Set(refunds.map((r) => `${r.connection_id}|${r.business_day}`))].sort();
const groups = [];
let n = 0;
for (const dk of dayKeys) {
  const [cid, day] = dk.split("|");
  const conn = conns.get(cid); if (!conn) continue;
  process.stderr.write(`\r${++n}/${dayKeys.length} ${conn.location_name} ${day}      `);
  const events = await get(`sales_events?select=id,doc_type,provider_doc_id,raw_json&connection_id=eq.${cid}&business_day=eq.${day}`);
  const byId = new Map(events.map((e) => [e.id, e]));
  const ids = events.map((e) => e.id);
  const lines = [];
  for (let i = 0; i < ids.length; i += 80) lines.push(...await get(`sales_line_items?select=sales_event_id,provider_product_id,winerim_product_id,name,quantity,format,total_amount,provider_sold_at&sales_event_id=in.(${ids.slice(i, i + 80).join(",")})`));
  const cls = classifyAgoraRefunds(events);
  const superseded = new Set(cls.filter((c) => c.kind === "REOPEN_SUPERSEDES").map((c) => c.supersededEventId));
  const refundInfo = new Map(cls.map((c) => [c.refundEventId, c]));
  const isRefund = (e) => e?.raw_json?._agora_refund === true;
  const definitive = (e) => e && e.doc_type !== "OpenTicket" && !isRefund(e) && e.raw_json?._stock_sync_eligible !== false;

  // Wine groups touched by refunds.
  const gmap = new Map();
  for (const l of lines) {
    const ev = byId.get(l.sales_event_id);
    if (!isRefund(ev)) continue;
    const pid = String(l.provider_product_id || "");
    const wine = l.winerim_product_id || lines.find((x) => x.provider_product_id === l.provider_product_id && x.winerim_product_id)?.winerim_product_id;
    if (!wine) continue; // not a Winerim-linked wine
    const fk = fmtKey(l.format);
    const key = `${pid}|${fk}`;
    const g = gmap.get(key) || { pid, fk, wine: String(wine), name: l.name, formatName: l.format, refunds: [], cancelled: { SUPERSEDES: 0, FULL: 0, PARTIAL: 0, AMBIGUOUS: 0 } };
    const c = refundInfo.get(ev.id);
    const kind = c?.kind === "REOPEN_SUPERSEDES" ? "SUPERSEDES" : c?.kind === "REVERSAL_PENDING" ? (c.reason === "full_cancellation" ? "FULL" : "PARTIAL") : "AMBIGUOUS";
    g.cancelled[kind] += -Number(l.quantity || 0);
    g.refunds.push({ ev, c, kind, qty: -Number(l.quantity || 0), amount: -Number(l.total_amount || 0), soldAt: l.provider_sold_at });
    gmap.set(key, g);
  }
  if (!gmap.size) continue;
  const rec = await winerimRecords(cid, conn.winerim_api_token, day);
  const prefix = `agora:${cid.slice(0, 8)}:${day}:`;
  for (const g of gmap.values()) {
    const sameGroup = (l) => String(l.provider_product_id || "") === g.pid && fmtKey(l.format) === g.fk;
    const sum = (pred) => lines.filter((l) => sameGroup(l) && pred(byId.get(l.sales_event_id))).reduce((s, l) => s + Number(l.quantity || 0), 0);
    const agoraInvoicedAll = sum(definitive);
    const agoraReal = sum((e) => definitive(e) && !superseded.has(e.id));
    const agoraNet = agoraReal - g.cancelled.FULL - g.cancelled.PARTIAL;
    const unitPrice = (() => { const l = lines.find((x) => sameGroup(x) && Number(x.quantity) > 0); return l ? Number(l.total_amount) / Number(l.quantity) : null; })();
    // Line-level readback: copas live as serving lines inside "botella en uso" sales.
    const recs = rec.rows.filter((r) => String(r.wine?.wineId) === g.wine && r.status === "confirmed")
      .flatMap((r) => (r.lines || []).filter((l) => String(l.format || "").toLowerCase() === g.fk && String(l.source?.externalOrderId || r.source?.externalOrderId || "").startsWith(prefix))
        .map((l) => ({ saleId: r.saleId, recordedAt: l.recordedAt || r.recordedAt, qty: Number(l.qty || 0), source: { externalOrderId: l.source?.externalOrderId || r.source?.externalOrderId }, lines: [l] })))
      .sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)) || a.saleId - b.saleId);
    const winerimQty = recs.reduce((s, r) => s + Number(r.qty || 0), 0);
    const mv = (r) => (r.lines || []).flatMap((l) => l.stockEffect?.movements || []).filter((m) => m.exists);
    // A movementId is ONE physical movement even if repeated on every cup/detail line.
    const distinctMv = (rs) => { const m = new Map(); for (const r of rs) for (const x of mv(r)) m.set(x.stockMovementId, x); return [...m.values()]; };
    const mvUnits = (ms) => ms.reduce((a, m) => a - Number(m.difference || 0), 0);
    const isCup = g.fk === "copa";
    const stockQty = mvUnits(distinctMv(recs));
    const excessHistory = winerimQty - agoraReal;
    // Cups: stock only moves when a bottle partition opens, so stock is not comparable with cup qty.
    const excessStock = isCup ? 0 : stockQty - agoraReal;
    const stockKnown = recs.every((r) => (r.lines || []).every((l) => l.stockEffect?.known === true));
    // Keep earliest sales up to the real qty; later ones are candidates.
    let acc = 0; const keep = [], cand = []; let split = false;
    for (const r of recs) {
      const q = Number(r.qty || 0);
      if (acc + q <= agoraReal) { keep.push(r); acc += q; }
      else { if (acc < agoraReal) split = true; cand.push(r); acc += q; }
    }
    const candQty = cand.reduce((s, r) => s + Number(r.qty || 0), 0);
    const keepMvIds = new Set(distinctMv(keep).map((m) => m.stockMovementId));
    const ownCandMv = distinctMv(cand).filter((m) => !keepMvIds.has(m.stockMovementId));
    const bottlesOver = mvUnits(ownCandMv); // physical units deducted ONLY by candidate details
    const candStockOk = cand.length > 0 && cand.every((r) => (r.lines || []).every((l) => l.stockEffect?.stockApplied === true && l.stockEffect?.receiptId)) && ownCandMv.length > 0;
    const candHistOk = cand.length > 0 && cand.every((r) => r.source?.externalOrderId && (r.lines || []).every((l) => l.source?.receiptId));
    const hasAmb = g.cancelled.AMBIGUOUS > 0;
    const tipo = g.refunds.map((r) => r.kind === "SUPERSEDES" ? String(r.ev.raw_json.RefundSource) : r.kind === "FULL" ? "AnulacionTotal" : r.kind === "PARTIAL" ? "DevolucionParcial" : `Ambigua(${r.ev.raw_json.RefundSource || "?"})`);
    let status, confidence, explanation, action;
    if (rec.err) { status = "NEEDS_WINERIM_READBACK"; confidence = "none"; explanation = `Winerim sales/records ${rec.err}`; action = "Repetir lectura Winerim"; }
    else if (hasAmb) { status = "AMBIGUOUS"; confidence = "low"; explanation = "Reapertura/conversión o devolución sin factura relacionada única o sin negación exacta línea a línea"; action = "Revisión manual con el restaurante"; }
    else if (g.cancelled.SUPERSEDES > 0 && g.cancelled.FULL + g.cancelled.PARTIAL === 0) {
      if (recs.length === 0 && agoraReal > 0) { status = "NEEDS_WINERIM_READBACK"; confidence = "low"; explanation = "No hay ventas Winerim con orderId de este día/vino/formato"; action = "Localizar ventas (posible venta anterior al arranque de stock o legacy)"; }
      else if (excessHistory === 0 && excessStock === 0) { status = "SUPERSEDED_AT_SOURCE"; confidence = "high"; explanation = "Sustitución probada en Ágora; Winerim registra exactamente la cantidad real: no llegó duplicado"; action = "Ninguna"; }
      else if (excessHistory < 0 || excessStock < 0 || excessHistory > g.cancelled.SUPERSEDES || excessStock > excessHistory) { status = "STOCK_CONFLICT"; confidence = "medium"; explanation = `Exceso historial ${excessHistory}, stock ${excessStock}, sustituido en Ágora ${g.cancelled.SUPERSEDES}: incompatibles`; action = excessHistory < 0 ? "Venta faltante en Winerim: nunca revertir" : "Revisión manual"; }
      else if (!isCup && !split && candQty === excessHistory && candHistOk && candStockOk && bottlesOver === excessHistory) { status = "CONFIRMED_DUPLICATE_STOCK"; confidence = "high"; explanation = "Detalle(s) posteriores a la real con recibo y movimiento de stock propio; cantidad exacta = exceso"; action = "Candidata a reversión cuando exista el endpoint certificado"; }
      else if (!split && candQty === excessHistory && candHistOk && (isCup || bottlesOver === 0)) { status = "CONFIRMED_DUPLICATE_HISTORY"; confidence = "high"; explanation = isCup ? "Copas duplicadas en historial; el stock de botella solo varía al abrir partición" : "Detalle(s) duplicados en historial; sin movimiento de stock propio (movimiento compartido con la venta real)"; action = "Candidata a reversión de historial"; }
      else { status = "PROBABLE_DUPLICATE"; confidence = "medium"; explanation = split ? "Exceso dentro de un detalle que también contiene cantidad real (reversión parcial)" : "Falta recibo o movimiento en los detalles candidatos"; action = "Completar trazabilidad antes de revertir"; }
    } else {
      // Cancellations / partial refunds: Winerim must reflect agoraNet.
      const pend = winerimQty - Math.max(0, agoraNet);
      if (recs.length === 0) { status = "NEEDS_WINERIM_READBACK"; confidence = "low"; explanation = "Anulación sin ventas Winerim localizadas"; action = "Verificar si llegó a Winerim"; }
      else if (pend <= 0) { status = "SUPERSEDED_AT_SOURCE"; confidence = "high"; explanation = "Anulación ya neutra en Winerim"; action = "Ninguna"; }
      else { status = "PROBABLE_DUPLICATE"; confidence = "medium"; explanation = `Anulación pendiente de reflejar: Winerim ${winerimQty}, neto Ágora ${agoraNet}`; action = `Revertir ${pend} cuando exista el endpoint`; }
    }
    let cupClass = null;
    if (isCup && recs.length) {
      if (!stockKnown) cupClass = "CUP_STOCK_UNKNOWN";
      else if (excessHistory < 0) cupClass = "CUP_REAL_STOCK_CONFLICT";
      else if (ownCandMv.length > 0) cupClass = "CUP_OPENING_EFFECT_CONFIRMED";
      else cupClass = "CUP_HISTORY_MATCHED_STOCK_NOT_EXPECTED";
    }
    const blockers = [];
    if (!stockKnown) blockers.push("STOCK_UNKNOWN");
    if (status === "AMBIGUOUS") blockers.push("AMBIGUOUS");
    if (!cand.length || !candHistOk || split) blockers.push("SOURCE_INCOMPLETE");
    blockers.push("ENDPOINT_GRANULARITY_UNKNOWN");
    const firstRef = g.refunds[0];
    const relInv = firstRef.c?.supersededEventId || firstRef.c?.relatedEventId;
    const newInv = events.filter((e) => definitive(e) && !superseded.has(e.id) && lines.some((l) => l.sales_event_id === e.id && sameGroup(l))).map((e) => e.provider_doc_id);
    // Only real Winerim detail identities; never synthesize "sale:<id>" as a line id.
    const lineIds = (rs) => rs.flatMap((r) => (r.lines || []).filter((l) => l.saleDetailId != null).map((l) => l.lineId || `detail:${l.saleDetailId}`)).join(" ");
    const identityScope = cand.length && cand.every((r) => (r.lines || []).length && (r.lines || []).every((l) => l.saleDetailId != null)) ? "DETAIL" : "SALE";
    const reversible = ["CONFIRMED_DUPLICATE_STOCK", "CONFIRMED_DUPLICATE_HISTORY"].includes(status) ? excessHistory : 0;
    groups.push({
      case_fingerprint: createHash("md5").update(`${cid}|${day}|${g.refunds.map((r) => r.ev.provider_doc_id).join(" ")}|${g.pid}|${g.fk}`).digest("hex"),
      identity_scope: cand.length ? identityScope : "",
      restaurante: conn.location_name, connection_id: cid, dia: day,
      hora: g.refunds.map((r) => r.ev.raw_json?.Date).filter(Boolean).join(" "),
      agoraTicketId: [...new Set(g.refunds.flatMap((r) => (r.ev.raw_json?.InvoiceItems || []).map((i) => i.GlobalId)).filter(Boolean))].join(" "),
      sourceLineId: [...new Set(g.refunds.flatMap((r) => (r.ev.raw_json?.InvoiceItems || []).flatMap((i) => (i.Lines || []).filter((l) => String(l.ProductId) === g.pid).map((l) => `${l.Index}@${l.CreationDate}`))))].join(" "),
      factura_original: relInv ? byId.get(relInv)?.provider_doc_id : "",
      devolucion: g.refunds.map((r) => r.ev.provider_doc_id).join(" "),
      factura_sustituta: newInv.join(" "),
      tipo: [...new Set(tipo)].join(" "),
      producto_agora: `${g.pid} ${g.name}`, formato_agora: g.formatName, wineId: g.wine, formato_winerim: g.fk,
      qty_anulada_o_sustituida_agora: g.cancelled.SUPERSEDES + g.cancelled.FULL + g.cancelled.PARTIAL + g.cancelled.AMBIGUOUS,
      qty_facturada_sin_filtro: agoraInvoicedAll, qty_real_agora: agoraReal, qty_neta_agora: agoraNet,
      qty_winerim_historial: winerimQty, qty_winerim_stock: stockQty,
      exceso_diario_historial: excessHistory, exceso_diario_stock: excessStock,
      exceso_atribuible_demostrado: reversible,
      importe_real: unitPrice != null ? +(unitPrice * agoraReal).toFixed(2) : "",
      importe_duplicado: unitPrice != null && reversible ? +(unitPrice * reversible).toFixed(2) : 0,
      saleId_conservar: [...new Set(keep.map((r) => r.saleId))].join(" "), lineId_conservar: lineIds(keep),
      saleId_candidata: [...new Set(cand.map((r) => r.saleId))].join(" "), lineId_candidata: lineIds(cand),
      saleDetailId: cand.flatMap((r) => (r.lines || []).map((l) => l.saleDetailId).filter(Boolean)).join(" "),
      // One structured target per real Winerim detail (or per sale when no detail id). Never a joined string.
      candidate_targets: cand.flatMap((r) => (r.lines || []).map((l) => ({ saleId: String(r.saleId), saleDetailId: l.saleDetailId != null ? String(l.saleDetailId) : null, qty: Number(l.qty || 0) }))),
      orderId: [...new Set(cand.map((r) => r.source?.externalOrderId))].join(" "),
      receiptId: [...new Set(cand.flatMap((r) => (r.lines || []).map((l) => l.source?.receiptId).filter(Boolean)))].join(" "),
      modo_importacion: [...new Set(cand.flatMap((r) => (r.lines || []).map((l) => l.source?.mode)))].join(" "),
      movementId: distinctMv(cand).map((m) => `${m.stockMovementId}(${m.unitsBefore}->${m.unitsAfter})${keepMvIds.has(m.stockMovementId) ? "[compartido]" : ""}`).join(" "),
      unidades_historial_de_mas: reversible,
      botellas_descontadas_de_mas: ["CONFIRMED_DUPLICATE_STOCK"].includes(status) ? bottlesOver : 0,
      clasificacion_copa: cupClass || "", bloqueos: blockers.join(" "),
      efecto_historial: cand.length ? `+${candQty} en historial` : "ninguno",
      efecto_stock: cand.length ? `-${bottlesOver} en stock (movimientos propios)` : "ninguno",
      qty_reversible_exacta: reversible, confianza: confidence, evidencia: explanation, accion: action, estado: status,
    });
  }
}
process.stderr.write("\n");
groups.sort((a, b) => (a.restaurante + a.dia + a.producto_agora).localeCompare(b.restaurante + b.dia + b.producto_agora));
fs.mkdirSync(OUT, { recursive: true });
const cols = Object.keys(groups[0] || {});
const esc = (v) => String(v ?? "").replace(/[;\n]/g, ",");
fs.writeFileSync(`${OUT}/auditoria-forense-duplicados-agora-v3-${FROM}_${TO}.csv`, [cols.join(";"), ...groups.map((g) => cols.map((c) => esc(g[c])).join(";"))].join("\n"));
// Audit rows (all cases incl. SUPERSEDED_AT_SOURCE). Never an executable queue.
const audit = groups.map((g) => ({
  case_fingerprint: g.case_fingerprint, identity_scope: g.identity_scope || null,
  connection_id: g.connection_id, business_day: g.dia, agora_ticket_id: g.agoraTicketId || null, source_line_id: g.sourceLineId || null,
  original_invoice: g.factura_original || null, new_invoice: g.factura_sustituta || null, refund_document: g.devolucion, refund_source: g.tipo,
  agora_product_id: g.producto_agora.split(" ")[0], winerim_wine_id: g.wineId, format_key: g.formato_winerim,
  original_qty: g.qty_real_agora, reverse_qty: g.qty_reversible_exacta, amount: g.importe_duplicado,
  keep_sale_ids: g.saleId_conservar || null, keep_detail_ids: g.lineId_conservar || null,
  candidate_sale_id: g.saleId_candidata || null, candidate_detail_ids: null, candidate_targets: g.candidate_targets, receipt_id: g.receiptId || null, order_id: g.orderId || null,
  import_mode: g.modo_importacion || null, movement_ids: g.movementId || null,
  history_units_excess: g.unidades_historial_de_mas, bottles_overdeducted: g.botellas_descontadas_de_mas,
  evidence_classification: g.estado, cup_classification: g.clasificacion_copa || null, blockers: g.bloqueos ? g.bloqueos.split(" ") : [],
  confidence: g.confianza, reason: g.evidencia,
  evidence: { excess_history: g.exceso_diario_historial, excess_stock: g.exceso_diario_stock, cancelled_at_source: g.qty_anulada_o_sustituida_agora, winerim_history_qty: g.qty_winerim_historial, winerim_stock_qty: g.qty_winerim_stock, agora_real_qty: g.qty_real_agora, action: g.accion },
}));
fs.writeFileSync(`${OUT}/auditoria-anulaciones-agora-v3-${FROM}_${TO}.json`, JSON.stringify(audit, null, 1));
console.log(JSON.stringify({ grupos: groups.length }, null, 1));
