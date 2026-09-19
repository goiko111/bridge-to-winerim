#!/usr/bin/env bun
/**
 * DIAGNOSTIC-ONLY reconciliation: Agora sales -> Winerim POST /api/v2/sales/lookup.
 *
 * Read-only by construction:
 *   - never calls /sales/import, /stock/*, or any write path;
 *   - never touches pos_connections, provider_config, cursors or queues;
 *   - only reads local tables (psql SELECT) and POSTs lookup queries.
 *
 * It starts from Agora sales (sales_line_items: mapped wine lines with the real
 * provider timestamp), attaches the ORIGINAL keys we actually know
 * (stock_sync_log.idempotency_key, the orderId/receiptId stored inside
 * winerim_response), and asks Winerim in batches of <= 100.
 *
 * It NEVER invents historic identities: legacy-system lines have no orderId of
 * ours, so they are reported as "sin clave conocida" and are NOT looked up and
 * NOT labelled missing.
 *
 * Buckets:
 *   CONFIRMADAS            state CONFIRMED with every requested effect present
 *   EFECTOS_INCOMPLETOS    found, but history or stock effect missing/unknown
 *   ANTIGUAS_A_CONTRASTAR  legacyMatches present / state CONFIRMED_LEGACY
 *   SIN_COINCIDENCIA_CLAVE not found for the key we asked with (NOT "missing")
 *   SIN_CLAVE_CONOCIDA     Agora line with no key of ours to ask with
 *
 * Usage:
 *   bun scripts/reconcile-winerim-sales-lookup.mjs --from 2026-09-01 --to 2026-09-18
 *      [--connection <uuid>] [--limit-per-connection 2000]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const SUPABASE_URL = "https://csiertktrefwewsmequr.supabase.co";
const PROBE_URL = `${SUPABASE_URL}/functions/v1/winerim-sales-probe`;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzaWVydGt0cmVmd2V3c21lcXVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4OTM1NTQsImV4cCI6MjA4NjQ2OTU1NH0.9wGFr7tfbfqrj1ZepuluinJxpvjRQlk-9ZE9IAQ94o8";
const UNKNOWN = "desconocido";
const BATCH = 100;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM = arg("from", "2026-09-01");
const TO = arg("to", new Date().toISOString().slice(0, 10));
const ONLY_CONNECTION = arg("connection");
const LIMIT = Number(arg("limit-per-connection", "3000"));

function sql(query) {
  const out = execFileSync("psql", ["-At", "-c", query], { encoding: "utf8", maxBuffer: 1024 * 1024 * 256 });
  return out.trim() ? JSON.parse(out) : [];
}

function jsonQuery(inner) {
  return `select coalesce(json_agg(t), '[]'::json)::text from (${inner}) t`;
}

async function lookup(connectionId, orderIds) {
  const res = await fetch(PROBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      connectionId,
      path: "/sales/lookup",
      method: "POST",
      payload: { sourceSystem: "agora", orderIds },
    }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
  return parsed;
}

/** Known keys per Agora sale line, taken from what our own channel recorded. */
function keysForConnection(connectionId) {
  return sql(jsonQuery(`
    select
      l.id as line_id,
      l.name as product_name,
      l.provider_product_id,
      l.winerim_product_id,
      l.format,
      l.quantity,
      l.total_amount,
      to_char(coalesce(l.provider_sold_at, e.business_day::timestamp), 'YYYY-MM-DD"T"HH24:MI:SS') as sold_at,
      e.business_day::text as business_day,
      e.provider_doc_id,
      s.variant,
      s.stock_id,
      s.status as local_status,
      s.idempotency_key,
      coalesce(
        s.winerim_response->>'orderId',
        s.winerim_response->'salesImport'->>'orderId',
        s.winerim_response->'response'->'sales'->0->>'orderId'
      ) as order_id,
      s.winerim_response->'response'->'sales'->0->>'receiptId' as receipt_id
    from sales_line_items l
    join sales_events e on e.id = l.sales_event_id
    left join stock_sync_log s
      on s.sales_line_item_id = l.id
     and s.status in ('SUCCESS','PENDING','FAILED')
    where l.connection_id = '${connectionId}'
      and l.is_wine_candidate
      and l.winerim_product_id is not null
      and e.business_day between '${FROM}' and '${TO}'
    order by e.business_day, l.created_at
    limit ${LIMIT}
  `));
}

function classify(result) {
  const ops = Array.isArray(result?.operations) ? result.operations : [];
  const legacy = Array.isArray(result?.legacyMatches) ? result.legacyMatches : [];
  const state = String(result?.state || "").toUpperCase();

  if (state === "CONFIRMED_LEGACY" || (legacy.length > 0 && ops.length === 0)) return "ANTIGUAS_A_CONTRASTAR";
  if (result?.found !== true || ops.length === 0) return legacy.length > 0 ? "ANTIGUAS_A_CONTRASTAR" : "SIN_COINCIDENCIA_CLAVE";

  const op = ops[0];
  const requested = String(op?.mode || "");
  const historyOk = op?.historyWritten === true;
  const stockNeeded = requested.includes("stock");
  const stockStatus = String(op?.stockEffect?.status || "");
  const stockResolved = op?.stockApplied === true ||
    /^SKIPPED_/.test(stockStatus) || stockStatus === "ALREADY_APPLIED";
  const missing = Array.isArray(op?.missingEffects) ? op.missingEffects : [];

  if (!historyOk || missing.length > 0 || (stockNeeded && !stockResolved)) return "EFECTOS_INCOMPLETOS";
  return "CONFIRMADAS";
}

function evidence(op) {
  if (!op) return UNKNOWN;
  const st = op.stockEffect || {};
  const status = st.status ? String(st.status) : UNKNOWN;
  const before = st.units && st.units.before !== undefined && st.units.before !== null ? st.units.before : UNKNOWN;
  const after = st.units && st.units.after !== undefined && st.units.after !== null ? st.units.after : UNKNOWN;
  const applied = op.stockApplied === true ? "si" : op.stockApplied === false ? "no" : UNKNOWN;
  return `${status} | aplicado=${applied} | unidades ${before}->${after}`;
}

function csvCell(v) {
  const s = v === null || v === undefined || v === "" ? UNKNOWN : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const connections = sql(jsonQuery(`
  select id, location_name
  from pos_connections
  where provider = 'agora' and enabled = true
    ${ONLY_CONNECTION ? `and id = '${ONLY_CONNECTION}'` : ""}
  order by location_name
`));

const stamp = new Date().toISOString().slice(0, 10);
const csvRows = [[
  "restaurante", "connection_id", "bucket", "fecha_agora", "fecha_efectiva_winerim", "ticket_agora",
  "vino_winerim", "producto", "formato", "cantidad", "importe", "order_id", "receipt_id",
  "idempotency_key", "sale_id", "estado_lookup", "evidencia_stock", "estado_local",
].join(",")];
const perRestaurant = [];

for (const conn of connections) {
  const lines = keysForConnection(conn.id);
  if (lines.length === 0) continue;

  const withKey = lines.filter((l) => l.order_id);
  const withoutKey = lines.filter((l) => !l.order_id);

  // De-duplicate orderIds: one order can back several local claim rows.
  const byOrderId = new Map();
  for (const l of withKey) {
    if (!byOrderId.has(l.order_id)) byOrderId.set(l.order_id, []);
    byOrderId.get(l.order_id).push(l);
  }
  const orderIds = [...byOrderId.keys()];

  const buckets = {
    CONFIRMADAS: 0, EFECTOS_INCOMPLETOS: 0, ANTIGUAS_A_CONTRASTAR: 0,
    SIN_COINCIDENCIA_CLAVE: 0, SIN_CLAVE_CONOCIDA: withoutKey.length,
  };
  let lookupErrors = 0;

  for (let i = 0; i < orderIds.length; i += BATCH) {
    const chunk = orderIds.slice(i, i + BATCH);
    const res = await lookup(conn.id, chunk);
    const results = res?.body?.results;
    if (!Array.isArray(results)) {
      lookupErrors += chunk.length;
      process.stderr.write(`  lookup error ${conn.location_name}: ${JSON.stringify(res).slice(0, 300)}\n`);
      continue;
    }
    for (const result of results) {
      const orderId = result?.query?.orderId;
      const localLines = byOrderId.get(orderId) || [];
      const bucket = classify(result);
      buckets[bucket] += Math.max(localLines.length, 1);
      const op = Array.isArray(result?.operations) ? result.operations[0] : null;
      const legacyOp = Array.isArray(result?.legacyMatches) ? result.legacyMatches[0] : null;
      const src = op || legacyOp || {};
      for (const l of localLines.length ? localLines : [{}]) {
        csvRows.push([
          conn.location_name, conn.id, bucket, l.sold_at || l.business_day, src.effectiveAt,
          l.provider_doc_id, l.winerim_product_id, l.product_name,
          src.format || l.variant || l.format, src.qty ?? l.quantity,
          src.amounts?.totalAmount ?? l.total_amount, orderId,
          src.receiptId || l.receipt_id, src.idempotencyKey || l.idempotency_key,
          src.history?.sale?.saleId, result?.state, evidence(op), l.local_status,
        ].map(csvCell).join(","));
      }
    }
  }

  for (const l of withoutKey) {
    csvRows.push([
      conn.location_name, conn.id, "SIN_CLAVE_CONOCIDA", l.sold_at || l.business_day, UNKNOWN,
      l.provider_doc_id, l.winerim_product_id, l.product_name, l.variant || l.format,
      l.quantity, l.total_amount, UNKNOWN, UNKNOWN, l.idempotency_key, UNKNOWN,
      "NO_CONSULTADO", UNKNOWN, l.local_status,
    ].map(csvCell).join(","));
  }

  perRestaurant.push({
    restaurante: conn.location_name,
    connection_id: conn.id,
    lineas_agora: lines.length,
    claves_consultadas: orderIds.length,
    ...buckets,
    errores_lookup: lookupErrors,
  });
  process.stderr.write(`${conn.location_name}: ${JSON.stringify(buckets)}\n`);
}

mkdirSync("/mnt/documents", { recursive: true });
mkdirSync("docs/operations", { recursive: true });
const csvPath = `/mnt/documents/reconciliacion-winerim-lookup-${FROM}_${TO}.csv`;
writeFileSync(csvPath, csvRows.join("\n") + "\n");

const md = [
  `# Reconciliación Agora ↔ Winerim (lookup) — ${FROM} a ${TO}`,
  ``,
  `Generado ${stamp}. **Solo diagnóstico**: no se importó ninguna venta ni se movió stock.`,
  `Punto de partida: líneas de vino mapeadas de Agora. Solo se consultan claves originales`,
  `realmente conocidas; nunca se reconstruyen identidades antiguas con el formato nuevo.`,
  ``,
  `| Restaurante | Líneas Agora | Claves consultadas | Confirmadas | Efectos incompletos | Antiguas a contrastar | Sin coincidencia con la clave | Sin clave conocida | Errores lookup |`,
  `|---|---:|---:|---:|---:|---:|---:|---:|---:|`,
  ...perRestaurant.map((r) =>
    `| ${r.restaurante} | ${r.lineas_agora} | ${r.claves_consultadas} | ${r.CONFIRMADAS} | ${r.EFECTOS_INCOMPLETOS} | ${r.ANTIGUAS_A_CONTRASTAR} | ${r.SIN_COINCIDENCIA_CLAVE} | ${r.SIN_CLAVE_CONOCIDA} | ${r.errores_lookup} |`),
  ``,
  `**Sin coincidencia con la clave** no significa venta faltante: puede existir en Winerim`,
  `con otro identificador o haberse registrado a mano. Lo desconocido figura como \`${UNKNOWN}\`.`,
  ``,
  `Detalle línea a línea (fechas, referencias, formato, cantidad, importe, evidencia de stock): \`${csvPath}\`.`,
  ``,
].join("\n");
const mdPath = `docs/operations/reconciliacion-winerim-lookup-${FROM}_${TO}.md`;
writeFileSync(mdPath, md);

console.log(JSON.stringify({ from: FROM, to: TO, restaurantes: perRestaurant, csvPath, mdPath }, null, 2));
