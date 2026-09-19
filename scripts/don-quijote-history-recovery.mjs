#!/usr/bin/env bun
/**
 * Don Quijote Marbella (ERP839) — Ágora <-> Winerim reconciliation for September 2026.
 *
 * READ-ONLY by default. It never calls /sales/import, never touches /stock/*, never
 * writes to local tables (psql SELECT only) and never changes configuration.
 *
 * Sources
 *   - Ágora: raw `GET /api/export/?business-day=<day>&filter=Invoices` snapshots cached
 *     under /tmp/dq/agora/<day>.json (fetched with the connection's own credentials),
 *     so days missing from the local capture are covered too.
 *   - Winerim: `GET /api/v2/sales/history?from&to&includeLegacy=true`, every page,
 *     through the existing read-only probe function.
 *
 * Cutoff: [2026-09-01 00:00:00, 2026-09-19 00:00:00) Europe/Madrid, same on both sides.
 *
 * soldAt semantics (never invented):
 *   - default: the line's own CreationDate;
 *   - when CreationDate falls outside the document's fiscal BusinessDay, the document
 *     header Date is used (Ágora itself flags those documents as out-of-day) and the
 *     original CreationDate is kept in the report as evidence.
 *
 * Buckets per Ágora wine line:
 *   REGISTRADA        every unit is covered in Winerim (by our original key or by an
 *                     unambiguous allocation of history quantity)
 *   REGISTRADA_ALIAS  same physical line as another document (open ticket <-> invoice)
 *                     already covered; one sale, not two
 *   PARCIAL           some units covered, some not
 *   FALTA             no history entry for that wine/format/day at all
 *   AMBIGUA           history entries exist for that wine/format/day but cannot be
 *                     assigned to this line without the original key
 *   DEVOLUCION        refund document / negative quantity, out of the sales count
 *
 * Stock is reported separately and never inferred: `si`, `no` or `desconocido`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";

const CONN = "8466c229-773d-4ad9-a747-9bb862d7ae6b";
const LOCATION = "Don Quijote Marbella";
const FROM = "2026-09-01";
const TO = "2026-09-19"; // exclusive
const TZ = "Europe/Madrid";
const UNKNOWN = "desconocido";
const AGORA_DIR = "/tmp/dq/agora";
const SUPABASE_URL = "https://csiertktrefwewsmequr.supabase.co";
const PROBE_URL = `${SUPABASE_URL}/functions/v1/winerim-sales-probe`;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzaWVydGt0cmVmd2V3c21lcXVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4OTM1NTQsImV4cCI6MjA4NjQ2OTU1NH0.9wGFr7tfbfqrj1ZepuluinJxpvjRQlk-9ZE9IAQ94o8";

function sql(query) {
  const out = execFileSync("psql", ["-At", "-c", query], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}
const jsonQuery = (inner) => `select coalesce(json_agg(t), '[]'::json)::text from (${inner}) t`;

function madridLocal(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const m = new Map(parts.map((p) => [p.type, p.value]));
  return `${m.get("year")}-${m.get("month")}-${m.get("day")}T${m.get("hour")}:${m.get("minute")}:${m.get("second")}`;
}

function normVariant(...values) {
  for (const value of values) {
    const raw = String(value ?? "").trim().toUpperCase();
    if (!raw) continue;
    if (/(^|[^A-Z])(COPA|GLASS|GLS|CUP)/.test(raw)) return "copa";
    if (/MAGNUM|1[.,]5\s*L/.test(raw)) return "magnum";
    if (/MEDIA|HALF|375|500\s*ML|0[.,]5\s*L/.test(raw)) return "media botella";
    if (/BOTELLA|BOTTLE|^BOT\b|^B\b/.test(raw)) return "botella";
  }
  return null;
}
const variantFromFormatType = (t) => ({
  BOTTLE: "botella", GLASS: "copa", MAGNUM: "magnum", HALF_BOTTLE: "media botella",
}[String(t || "").toUpperCase()] || null);

// ── Ágora side ────────────────────────────────────────────────────────────────
const mappings = new Map(
  sql(jsonQuery(`
    select provider_product_id, format_type, winerim_wine_id, winerim_wine_name, status
    from product_mappings
    where connection_id = '${CONN}' and winerim_wine_id is not null and status = 'CONFIRMED'
  `)).map((r) => [String(r.provider_product_id), r]),
);

const agoraLines = [];
const docs = [];
for (const file of readdirSync(AGORA_DIR).sort()) {
  if (!file.endsWith(".json")) continue;
  const raw = readFileSync(`${AGORA_DIR}/${file}`, "utf8").trim();
  if (!raw || raw === "[]") continue;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { continue; }
  const list = Array.isArray(parsed) ? parsed : (parsed.Invoices || parsed.Data || []);
  for (const doc of list) {
    const docId = `${doc.Serie || ""}-${doc.Number}`;
    const businessDay = String(doc.BusinessDay || "").slice(0, 10);
    const headerDate = String(doc.Date || "").slice(0, 19);
    const docType = String(doc.DocumentType || "");
    docs.push({ docId, businessDay, headerDate, docType });
    for (const item of doc.InvoiceItems || []) {
      for (const line of item.Lines || []) {
        const productId = String(line.ProductId ?? "");
        const mapping = mappings.get(productId);
        if (!mapping) continue; // not a mapped Winerim wine
        const creation = String(line.CreationDate || "").slice(0, 19);
        const outOfDay = creation.slice(0, 10) !== businessDay;
        const soldAt = outOfDay ? headerDate : creation;
        const variant = variantFromFormatType(mapping.format_type) ||
          normVariant(line.SaleFormatName, line.ProductName) || "botella";
        agoraLines.push({
          docId, docType, businessDay, headerDate,
          globalId: item.GlobalId, index: line.Index,
          productId, productName: String(line.ProductName || ""),
          saleFormatId: String(line.SaleFormatId ?? ""),
          saleFormatName: String(line.SaleFormatName || ""),
          wineId: String(mapping.winerim_wine_id), wineName: mapping.winerim_wine_name,
          variant,
          qty: Number(line.Quantity || 0),
          unitPrice: Number(line.UnitPrice || 0),
          amount: Number(line.TotalAmount || 0),
          creationDate: creation, soldAt, outOfDay,
          day: soldAt.slice(0, 10),
        });
      }
    }
  }
}

// Alias detection: same physical line in two documents (open ticket <-> invoice).
const aliasGroups = new Map();
for (const l of agoraLines) {
  const key = `${l.productId}|${l.saleFormatId}|${l.creationDate}|${l.qty}|${l.amount}`;
  if (!aliasGroups.has(key)) aliasGroups.set(key, []);
  aliasGroups.get(key).push(l);
}
for (const group of aliasGroups.values()) {
  if (group.length < 2) continue;
  const primary = group.find((l) => l.docType === "BasicInvoice") || group[0];
  for (const l of group) {
    l.aliasOf = l === primary ? null : primary.docId;
    l.aliasGroup = group.map((g) => g.docId).join(" / ");
  }
}

// ── Winerim side ──────────────────────────────────────────────────────────────
async function historyPage(page) {
  const res = await fetch(PROBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      connectionId: CONN, path: "/sales/history", method: "GET",
      query: { from: FROM, to: TO, includeLegacy: "true", limit: 100, page },
    }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 400) }; }
}

const historyEntries = [];
let pagination = null;
let historyError = null;
for (let page = 1; page <= 200; page++) {
  const res = await historyPage(page);
  const body = res?.body;
  if (!body || !Array.isArray(body.data)) { historyError = JSON.stringify(res).slice(0, 300); break; }
  pagination = body.pagination || pagination;
  historyEntries.push(...body.data);
  if (!body.pagination?.hasMore) break;
}

// Resolve history entries to wine + variant with the live catalogue snapshot.
const catalogRows = sql(jsonQuery(`
  select winerim_id, name, bottle_stock_id, glass_stock_id, magnum_stock_id, raw_payload
  from winerim_wines where connection_id = '${CONN}'
`));
const byStock = new Map();
const byPrice = new Map();
for (const row of catalogRows) {
  const base = { wineId: String(row.winerim_id), name: row.name };
  const add = (map, id, variant) => { if (id != null && id !== "") map.set(String(id), { ...base, variant }); };
  add(byStock, row.bottle_stock_id, "botella");
  add(byStock, row.glass_stock_id, "copa");
  add(byStock, row.magnum_stock_id, "magnum");
  for (const p of Array.isArray(row.raw_payload?.prices) ? row.raw_payload.prices : []) {
    const variant = normVariant(p.variantName || p.variant || (p.isGlass ? "copa" : "botella")) || "botella";
    add(byStock, p.stockId ?? p.erpStock?.id, variant);
    add(byPrice, p.priceId ?? p.id, variant);
  }
}

const resolved = historyEntries.map((e) => {
  const ref = (e.stockId != null && byStock.get(String(e.stockId))) ||
    (e.priceId != null && byPrice.get(String(e.priceId))) || null;
  const local = madridLocal(e.effectiveAt);
  const applied = Array.isArray(e.appliedEffects) ? e.appliedEffects : [];
  return {
    raw: e,
    wineId: ref?.wineId || null,
    wineName: ref?.name || null,
    variant: normVariant(e.format, e.variant, ref?.variant) || ref?.variant || null,
    local, day: local ? local.slice(0, 10) : null,
    qty: Number(e.qty || 0),
    amount: e.amounts?.totalAmount ?? null,
    origin: e.source === "legacy" ? (e.legacyKind ? `legacy/${e.legacyKind}` : "legacy") : "certificado",
    orderId: e.orderId ? String(e.orderId) : null,
    saleId: e.sale?.saleId ?? null,
    history: e.historyWritten === true || applied.includes("history") ? "si" : UNKNOWN,
    stock: applied.includes("stock") ? "si" : (e.stockId == null ? UNKNOWN : UNKNOWN),
    remaining: Number(e.qty || 0),
  };
});

// Our own recorded keys, exactly as the running lane wrote them.
const ourKeys = new Map();
for (const row of sql(jsonQuery(`
  select
    coalesce(
      winerim_response->>'orderId',
      winerim_response->'salesImport'->>'orderId',
      winerim_response->'response'->'sales'->0->>'orderId'
    ) as order_id,
    product_name, variant, quantity, status, idempotency_key
  from stock_sync_log where connection_id = '${CONN}'
`))) {
  if (row.order_id) ourKeys.set(String(row.order_id), row);
}

// ── Allocation ────────────────────────────────────────────────────────────────
const pool = new Map(); // wineId|variant|day -> entries
for (const r of resolved) {
  const key = `${r.wineId || UNKNOWN}|${r.variant || UNKNOWN}|${r.day}`;
  if (!pool.has(key)) pool.set(key, []);
  pool.get(key).push(r);
}

const rows = [];
const sales = agoraLines.filter((l) => l.qty > 0 && l.docType !== "BasicRefund");
const refunds = agoraLines.filter((l) => l.qty < 0 || l.docType === "BasicRefund");

// Pass 1: exact key match (our orderId recorded for this line's wine/variant/day).
for (const l of sales) {
  const key = `${l.wineId}|${l.variant}|${l.day}`;
  const candidates = (pool.get(key) || []).filter((c) => c.remaining > 0 && c.orderId && ourKeys.has(c.orderId));
  l.covered = 0;
  l.matches = [];
  for (const c of candidates) {
    if (l.covered >= l.qty) break;
    const take = Math.min(c.remaining, l.qty - l.covered);
    c.remaining -= take;
    l.covered += take;
    l.matches.push({ entry: c, take, how: "clave-propia" });
  }
}

// Pass 2: exact timestamp match.
for (const l of sales) {
  if (l.covered >= l.qty) continue;
  const key = `${l.wineId}|${l.variant}|${l.day}`;
  for (const c of (pool.get(key) || []).filter((c) => c.remaining > 0 && c.local === l.soldAt)) {
    if (l.covered >= l.qty) break;
    const take = Math.min(c.remaining, l.qty - l.covered);
    c.remaining -= take;
    l.covered += take;
    l.matches.push({ entry: c, take, how: "misma-hora" });
  }
}

// Pass 3: exact quantity match on the same wine/variant/day.
for (const l of sales) {
  if (l.covered >= l.qty) continue;
  const key = `${l.wineId}|${l.variant}|${l.day}`;
  const exact = (pool.get(key) || []).filter((c) => c.remaining === l.qty - l.covered);
  if (exact.length === 1) {
    const c = exact[0];
    const take = c.remaining;
    c.remaining -= take;
    l.covered += take;
    l.matches.push({ entry: c, take, how: "misma-cantidad" });
  }
}

// Pass 4: leftover quantity on the same wine/variant/day (ambiguous allocation).
for (const l of sales) {
  if (l.covered >= l.qty) continue;
  if (l.aliasOf) continue; // aliases resolve through their primary
  const key = `${l.wineId}|${l.variant}|${l.day}`;
  for (const c of (pool.get(key) || []).filter((c) => c.remaining > 0)) {
    if (l.covered >= l.qty) break;
    const take = Math.min(c.remaining, l.qty - l.covered);
    c.remaining -= take;
    l.covered += take;
    l.ambiguous = true;
    l.matches.push({ entry: c, take, how: "reparto-por-vino-formato-dia" });
  }
}

function bucketFor(l) {
  if (l.aliasOf && l.covered <= 0) {
    const primary = sales.find((p) => p.docId === l.aliasOf &&
      p.productId === l.productId && p.creationDate === l.creationDate);
    if (primary && primary.covered >= primary.qty) return "REGISTRADA_ALIAS";
    return "ALIAS_SIN_REGISTRO";
  }
  if (l.covered >= l.qty) return l.ambiguous ? "AMBIGUA" : "REGISTRADA";
  if (l.covered > 0) return "PARCIAL";
  const key = `${l.wineId}|${l.variant}|${l.day}`;
  return (pool.get(key) || []).length > 0 ? "AMBIGUA" : "FALTA";
}

const csv = [[
  "restaurante", "estado", "ticket", "tipo_doc", "dia_fiscal", "fecha_hora_venta",
  "fecha_creacion_linea", "fecha_fuera_de_dia", "vino_winerim", "nombre_vino", "producto_tpv",
  "producto_id_tpv", "formato", "unidades", "unidades_registradas", "unidades_a_incorporar",
  "importe", "precio_unidad", "winerim_sale_ids", "winerim_order_ids", "winerim_origen",
  "winerim_horas", "historial_escrito", "stock_aplicado", "como_se_emparejo", "alias_de", "nota",
].join(",")];
const cell = (v) => {
  const s = v === null || v === undefined || v === "" ? UNKNOWN : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const summary = {};
const pending = [];
for (const l of [...sales, ...refunds]) {
  const isRefund = l.qty < 0 || l.docType === "BasicRefund";
  const bucket = isRefund ? "DEVOLUCION" : bucketFor(l);
  summary[bucket] = summary[bucket] || { lineas: 0, unidades: 0, importe: 0, aIncorporar: 0 };
  // An alias line is the same physical sale as its primary: it is never re-imported.
  const missing = (isRefund || bucket === "REGISTRADA" || bucket === "REGISTRADA_ALIAS" || bucket === "AMBIGUA")
    ? 0
    : Math.max(0, l.qty - (l.covered || 0));
  summary[bucket].lineas += 1;
  summary[bucket].unidades += Math.abs(l.qty);
  summary[bucket].importe += Number(l.amount || 0);
  summary[bucket].aIncorporar += missing;
  if (bucket === "FALTA" || bucket === "PARCIAL") pending.push({ ...l, missing, bucket });
  csv.push([
    LOCATION, bucket, l.docId, l.docType, l.businessDay, l.soldAt, l.creationDate,
    l.outOfDay ? "si" : "no", l.wineId, l.wineName, l.productName, l.productId, l.variant,
    l.qty, l.covered || 0, missing, l.amount, l.unitPrice,
    (l.matches || []).map((m) => m.entry.saleId).join(" "),
    (l.matches || []).map((m) => m.entry.orderId).join(" "),
    [...new Set((l.matches || []).map((m) => m.entry.origin))].join(" "),
    (l.matches || []).map((m) => m.entry.local).join(" "),
    (l.matches || []).length ? [...new Set(l.matches.map((m) => m.entry.history))].join(" ") : UNKNOWN,
    (l.matches || []).length ? [...new Set(l.matches.map((m) => m.entry.stock))].join(" ") : UNKNOWN,
    (l.matches || []).map((m) => m.how).join(" ") || UNKNOWN,
    l.aliasOf || "", l.outOfDay ? "fecha de venta tomada de la cabecera del documento; creacion de linea conservada como evidencia" : "",
  ].map(cell).join(","));
}

// Winerim entries nobody claimed.
const leftovers = resolved.filter((r) => r.remaining > 0);
for (const r of leftovers) {
  csv.push([
    LOCATION, "SOLO_EN_WINERIM", UNKNOWN, UNKNOWN, UNKNOWN, r.local, UNKNOWN, UNKNOWN,
    r.wineId, r.wineName, UNKNOWN, UNKNOWN, r.variant, UNKNOWN, r.remaining, 0,
    r.amount, UNKNOWN, r.saleId, r.orderId, r.origin, r.local, r.history, r.stock, UNKNOWN, "",
    "apunte en Winerim sin linea del TPV que lo respalde (manual, otro origen o desglose)",
  ].map(cell).join(","));
}

mkdirSync("/mnt/documents", { recursive: true });
const csvPath = `/mnt/documents/don-quijote-recuperacion-historial-${FROM}_${TO}.csv`;
writeFileSync(csvPath, csv.join("\n") + "\n");

const report = {
  conexion: CONN, restaurante: LOCATION, desde: FROM, hasta_exclusivo: TO, zona: TZ,
  agora: {
    dias_leidos: readdirSync(AGORA_DIR).filter((f) => f.endsWith(".json")).length,
    documentos: docs.length,
    lineas_de_vino: agoraLines.length,
    ventas: sales.length, devoluciones: refunds.length,
  },
  winerim: {
    apuntes: historyEntries.length,
    operaciones: pagination?.sources?.operations ?? UNKNOWN,
    legado: pagination?.sources?.legacy ?? UNKNOWN,
    error: historyError,
    sin_reclamar: leftovers.length,
  },
  por_estado: summary,
  pendientes: pending.map((p) => ({
    ticket: p.docId, tipo: p.docType, fecha_hora: p.soldAt, creacion_linea: p.creationDate,
    fuera_de_dia: p.outOfDay, vino: p.wineId, nombre: p.wineName, producto: p.productName,
    formato: p.variant, unidades: p.qty, registradas: p.covered || 0, a_incorporar: p.missing,
    importe: p.amount, estado: p.bucket,
  })),
  csvPath,
};
writeFileSync("/tmp/dq/report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
