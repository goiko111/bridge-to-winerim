#!/usr/bin/env bun
/**
 * PHASE 2 — DIAGNOSTIC-ONLY reconciliation Agora <-> Winerim full history.
 *
 * Read-only by construction:
 *   - only GET /api/v2/sales/history?from&to&includeLegacy=true (paginated, limit<=100);
 *   - never calls /sales/import, /sales/lookup writes or /stock/*;
 *   - never mutates local tables (psql SELECT only). Phase 1 (lookup) stays untouched.
 *
 * Common cutoff + timezone with Agora: [FROM 00:00:00, TO 00:00:00) Europe/Madrid.
 * Agora naive local timestamps and Winerim effectiveAt are both reduced to
 * Madrid-local "YYYY-MM-DDTHH:MM:SS" before comparing.
 *
 * Buckets per Agora wine line:
 *   COINCIDENTE_CLAVE     matched by the original orderId we recorded (certified channel)
 *   COINCIDENTE_LEGADO    matched by an orderId that Winerim reports as legacy
 *   CANDIDATA_SIN_CLAVE   no known key; one history entry matches wine+format+day (candidate)
 *   AMBIGUA               no known key; several history entries could match
 *   FALTANTE_COMPROBADA   full history read and nothing for that wine+format+day
 * Winerim-side leftovers:
 *   POSIBLE_DUPLICADA     history qty for wine+format+day exceeds the Agora qty
 *
 * History effects and stock effects are always reported separately.
 *
 * Usage: bun scripts/reconcile-winerim-history-full.mjs [--from 2026-09-01] [--to 2026-09-19]
 *        [--connection <uuid>]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const SUPABASE_URL = "https://csiertktrefwewsmequr.supabase.co";
const PROBE_URL = `${SUPABASE_URL}/functions/v1/winerim-sales-probe`;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzaWVydGt0cmVmd2V3c21lcXVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4OTM1NTQsImV4cCI6MjA4NjQ2OTU1NH0.9wGFr7tfbfqrj1ZepuluinJxpvjRQlk-9ZE9IAQ94o8";
const UNKNOWN = "desconocido";
const TZ = "Europe/Madrid";
const PAGE_LIMIT = 100;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const FROM = arg("from", "2026-09-01");
const TO = arg("to", "2026-09-19"); // exclusive cutoff, Madrid local
const ONLY_CONNECTION = arg("connection");

function sql(query) {
  const out = execFileSync("psql", ["-At", "-c", query], { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
  return out.trim() ? JSON.parse(out) : [];
}
const jsonQuery = (inner) => `select coalesce(json_agg(t), '[]'::json)::text from (${inner}) t`;

/** Winerim effectiveAt (absolute) -> Madrid-local naive ISO, same shape as Agora. */
function madridLocal(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const m = new Map(p.map((x) => [x.type, x.value]));
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
  return "botella";
}

async function historyPage(connectionId, page) {
  const res = await fetch(PROBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      connectionId,
      path: "/sales/history",
      method: "GET",
      query: { from: FROM, to: TO, includeLegacy: "true", limit: PAGE_LIMIT, page },
    }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 400) }; }
}

async function fullHistory(connectionId) {
  const entries = [];
  let page = 1;
  let pagination = null;
  let error = null;
  for (;;) {
    const res = await historyPage(connectionId, page);
    const body = res?.body;
    if (!body || !Array.isArray(body.data)) { error = JSON.stringify(res).slice(0, 300); break; }
    pagination = body.pagination || pagination;
    entries.push(...body.data);
    if (!body.pagination?.hasMore || page >= (body.pagination?.totalPages || page)) break;
    page += 1;
    if (page > 200) break;
  }
  return { entries, pagination, error };
}

/** priceId / stockId -> { winerimId, variant, name } from the local Winerim catalog snapshot. */
function catalogIndex(connectionId) {
  const rows = sql(jsonQuery(`
    select winerim_id, name, raw_payload from winerim_wines
    where connection_id = '${connectionId}'
  `));
  const byPrice = new Map();
  const byStock = new Map();
  for (const row of rows) {
    const prices = Array.isArray(row.raw_payload?.prices) ? row.raw_payload.prices : [];
    for (const p of prices) {
      const entry = {
        winerimId: String(row.winerim_id),
        name: row.name,
        variant: normVariant(p.variantName || p.variant || (p.isGlass ? "copa" : "botella")),
      };
      if (p.priceId != null) byPrice.set(String(p.priceId), entry);
      if (p.stockId != null) byStock.set(String(p.stockId), entry);
    }
  }
  return { byPrice, byStock };
}

function agoraLines(connectionId) {
  return sql(jsonQuery(`
    select
      l.id as line_id,
      l.name as product_name,
      l.winerim_product_id,
      l.format,
      l.quantity,
      l.total_amount,
      to_char(coalesce(l.provider_sold_at, e.business_day::timestamp), 'YYYY-MM-DD"T"HH24:MI:SS') as sold_at,
      e.business_day::text as business_day,
      e.provider_doc_id,
      s.variant,
      s.status as local_status,
      s.idempotency_key,
      coalesce(
        s.winerim_response->>'orderId',
        s.winerim_response->'salesImport'->>'orderId',
        s.winerim_response->'response'->'sales'->0->>'orderId'
      ) as order_id
    from sales_line_items l
    join sales_events e on e.id = l.sales_event_id
    left join stock_sync_log s
      on s.sales_line_item_id = l.id and s.status in ('SUCCESS','PENDING','FAILED')
    where l.connection_id = '${connectionId}'
      and l.is_wine_candidate
      and l.winerim_product_id is not null
      and e.business_day >= '${FROM}' and e.business_day < '${TO}'
    order by e.business_day, l.created_at
  `));
}

const effects = (entry) => {
  const applied = Array.isArray(entry?.appliedEffects) ? entry.appliedEffects : [];
  return {
    history: entry?.historyWritten === true || applied.includes("history") ? "si" : UNKNOWN,
    stock: applied.includes("stock") ? "si" : entry?.stockId ? UNKNOWN : "no",
  };
};

function csvCell(v) {
  const s = v === null || v === undefined || v === "" ? UNKNOWN : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const connections = sql(jsonQuery(`
  select id, location_name from pos_connections
  where provider = 'agora' and enabled = true
    ${ONLY_CONNECTION ? `and id = '${ONLY_CONNECTION}'` : ""}
  order by location_name
`));

const csvRows = [[
  "restaurante", "connection_id", "bucket", "fecha_hora_agora", "fecha_hora_winerim",
  "ticket_agora", "vino_winerim", "producto", "formato", "cantidad_agora", "cantidad_winerim",
  "importe_agora", "importe_winerim", "order_id", "origen_winerim", "sale_id",
  "historial_escrito", "stock_aplicado", "estado_local", "nota",
].join(",")];
const summary = [];

for (const conn of connections) {
  const lines = agoraLines(conn.id);
  const { entries, pagination, error } = await fullHistory(conn.id);
  const { byPrice, byStock } = catalogIndex(conn.id);

  // Index history by orderId and by wine+format+day.
  const byOrderId = new Map();
  const pool = new Map(); // key -> entries not yet matched by orderId
  const resolved = entries.map((e) => {
    const ref = (e.stockId != null && byStock.get(String(e.stockId))) ||
      (e.priceId != null && byPrice.get(String(e.priceId))) || null;
    const local = madridLocal(e.effectiveAt);
    return {
      raw: e,
      winerimId: ref?.winerimId || null,
      wineName: ref?.name || null,
      variant: normVariant(e.format, ref?.variant),
      day: local ? local.slice(0, 10) : null,
      local,
      origin: e.source === "legacy" ? (e.legacyKind ? `legacy/${e.legacyKind}` : "legacy") : "certified",
    };
  });
  for (const r of resolved) {
    if (r.raw.orderId) {
      if (!byOrderId.has(r.raw.orderId)) byOrderId.set(r.raw.orderId, []);
      byOrderId.get(r.raw.orderId).push(r);
    }
  }

  const usedEntries = new Set();
  const buckets = {
    COINCIDENTE_CLAVE: 0, COINCIDENTE_LEGADO: 0, CANDIDATA_SIN_CLAVE: 0,
    AMBIGUA: 0, FALTANTE_COMPROBADA: 0,
  };
  let historyOnly = 0;
  let stockMissing = 0;

  const unkeyed = [];
  const matchedKeys = new Set();
  for (const l of lines) {
    const variant = normVariant(l.variant, l.format);
    const day = (l.sold_at || l.business_day).slice(0, 10);
    const matches = l.order_id ? byOrderId.get(l.order_id) || [] : [];
    if (matches.length === 0) { unkeyed.push({ ...l, variant, day }); continue; }
    matchedKeys.add(`${l.winerim_product_id}|${variant}|${day}`);

    const entry = matches[0];
    usedEntries.add(entry.raw);
    const bucket = entry.origin === "certified" ? "COINCIDENTE_CLAVE" : "COINCIDENTE_LEGADO";
    buckets[bucket] += 1;
    const eff = effects(entry.raw);
    if (eff.history === "si" && eff.stock !== "si") { historyOnly += 1; stockMissing += 1; }
    csvRows.push([
      conn.location_name, conn.id, bucket, l.sold_at, entry.local, l.provider_doc_id,
      l.winerim_product_id, l.product_name, variant, l.quantity, entry.raw.qty,
      l.total_amount, entry.raw.amounts?.totalAmount, l.order_id, entry.origin,
      entry.raw.sale?.saleId, eff.history, eff.stock, l.local_status,
      matches.length > 1 ? "varias entradas con la misma clave" : "",
    ].map(csvCell).join(","));
  }

  // Candidate matching for Agora lines with no key of ours.
  for (const r of resolved) {
    if (usedEntries.has(r.raw)) continue;
    const key = `${r.winerimId || UNKNOWN}|${r.variant}|${r.day}`;
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(r);
  }
  for (const l of unkeyed) {
    const key = `${l.winerim_product_id}|${l.variant}|${l.day}`;
    const candidates = (pool.get(key) || []).filter((c) => !usedEntries.has(c.raw));
    let bucket;
    let entry = null;
    if (candidates.length === 0) bucket = "FALTANTE_COMPROBADA";
    else if (candidates.length === 1) { bucket = "CANDIDATA_SIN_CLAVE"; entry = candidates[0]; }
    else {
      const exact = candidates.filter((c) => Number(c.raw.qty) === Number(l.quantity));
      if (exact.length === 1) { bucket = "CANDIDATA_SIN_CLAVE"; entry = exact[0]; }
      else bucket = "AMBIGUA";
    }
    if (entry) usedEntries.add(entry.raw);
    buckets[bucket] += 1;
    const eff = entry ? effects(entry.raw) : { history: UNKNOWN, stock: UNKNOWN };
    if (entry && eff.history === "si" && eff.stock !== "si") { historyOnly += 1; stockMissing += 1; }
    csvRows.push([
      conn.location_name, conn.id, bucket, l.sold_at, entry?.local, l.provider_doc_id,
      l.winerim_product_id, l.product_name, l.variant, l.quantity, entry?.raw.qty,
      l.total_amount, entry?.raw.amounts?.totalAmount, entry?.raw.orderId,
      entry?.origin, entry?.raw.sale?.saleId, eff.history, eff.stock, l.local_status,
      bucket === "AMBIGUA" ? `${candidates.length} candidatas por vino/formato/dia` :
        bucket === "CANDIDATA_SIN_CLAVE" ? "coincidencia candidata, no certeza" : "",
    ].map(csvCell).join(","));
  }

  // Winerim entries never claimed by an Agora line -> possible duplicates / outside Agora.
  let possibleDuplicates = 0;
  for (const r of resolved) {
    if (usedEntries.has(r.raw)) continue;
    possibleDuplicates += 1;
    const eff = effects(r.raw);
    csvRows.push([
      conn.location_name, conn.id, "POSIBLE_DUPLICADA", UNKNOWN, r.local, UNKNOWN,
      r.winerimId, r.wineName, r.variant, UNKNOWN, r.raw.qty, UNKNOWN,
      r.raw.amounts?.totalAmount, r.raw.orderId, r.origin, r.raw.sale?.saleId,
      eff.history, eff.stock, UNKNOWN, "en Winerim sin linea de Agora que la respalde",
    ].map(csvCell).join(","));
  }

  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  summary.push({
    restaurante: conn.location_name,
    connection_id: conn.id,
    lineas_agora: lines.length,
    total_clasificado: total,
    historial_winerim: entries.length,
    operaciones: pagination?.sources?.operations ?? UNKNOWN,
    legado: pagination?.sources?.legacy ?? UNKNOWN,
    ...buckets,
    POSIBLE_DUPLICADA: possibleDuplicates,
    solo_historial_sin_stock: historyOnly,
    stock_pendiente: stockMissing,
    error_historial: error || "",
  });
  process.stderr.write(`${conn.location_name}: ${JSON.stringify(summary.at(-1))}\n`);
}

mkdirSync("/mnt/documents", { recursive: true });
mkdirSync("docs/operations", { recursive: true });
const csvPath = `/mnt/documents/reconciliacion-winerim-historial-${FROM}_${TO}.csv`;
writeFileSync(csvPath, csvRows.join("\n") + "\n");

const md = [
  `# Reconciliación Agora ↔ Winerim (historial completo) — ${FROM} a ${TO} (exclusivo)`,
  ``,
  `Fase 2. **Solo diagnóstico**: no se importó ninguna venta ni se movió stock.`,
  `Lectura: \`GET /api/v2/sales/history?includeLegacy=true\`, todas las páginas (límite 100).`,
  `Corte común con Ágora: desde ${FROM} 00:00:00 hasta ${TO} 00:00:00, zona ${TZ}.`,
  ``,
  `| Restaurante | Líneas Ágora | Clasificadas | Historial Winerim | Certificadas | Legado | Coinc. clave | Coinc. legado | Candidatas | Ambiguas | Faltantes comprobadas | Posibles duplicadas | Sin stock aplicado |`,
  `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
  ...summary.map((r) => `| ${r.restaurante} | ${r.lineas_agora} | ${r.total_clasificado} | ${r.historial_winerim} | ${r.operaciones} | ${r.legado} | ${r.COINCIDENTE_CLAVE} | ${r.COINCIDENTE_LEGADO} | ${r.CANDIDATA_SIN_CLAVE} | ${r.AMBIGUA} | ${r.FALTANTE_COMPROBADA} | ${r.POSIBLE_DUPLICADA} | ${r.stock_pendiente} |`),
  ``,
  `Cada línea de Ágora cae en exactamente un bucket, así que **Clasificadas = Líneas Ágora**.`,
  `Las *posibles duplicadas* son entradas de Winerim sin línea de Ágora que las respalde y no suman al total.`,
  `Las *candidatas* se emparejan por vino, formato y día: son indicios, no certezas.`,
  `Historial y stock se informan por separado; lo que Winerim no informa figura como \`${UNKNOWN}\`.`,
  ``,
  `Detalle línea a línea: \`${csvPath}\`.`,
  ``,
].join("\n");
const mdPath = `docs/operations/reconciliacion-winerim-historial-${FROM}_${TO}.md`;
writeFileSync(mdPath, md);

console.log(JSON.stringify({ from: FROM, to: TO, tz: TZ, restaurantes: summary, csvPath, mdPath }, null, 2));
