#!/usr/bin/env bun
/**
 * PHASE 3 — DIAGNOSTIC-ONLY recovery proposal (no writes at all).
 *
 * Reuses the phase-2 capture (/mnt/documents/reconciliacion-winerim-historial-*.csv)
 * instead of re-reading Winerim, and fixes the three biases the client found:
 *
 *  1. OPEN TICKET vs INVOICE. Agora keeps the same line identity in both
 *     representations: ProductId + SaleFormatId + line CreationDate (stored as
 *     provider_sold_at). A line that appears as OpenTicket and later as
 *     BasicInvoice is ONE physical sale. If either representation is already
 *     identified in Winerim, the other one is NOT missing.
 *  2. REFUNDS. doc_type = BasicRefund is a return, never an ordinary sale.
 *  3. GLASS BREAKDOWN. Same wine+format+day where the identified quantity
 *     already covers the unidentified quantity -> ambiguous, not missing.
 *
 * Stock is never inferred: `desconocido` stays `desconocido` and such lines are
 * routed to A_CONFIRMAR, never to stock_only / history_and_stock.
 *
 * Usage: bun scripts/reconcile-winerim-recovery-plan.mjs [--from 2026-09-01] [--to 2026-09-19]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const UNKNOWN = "desconocido";
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const FROM = arg("from", "2026-09-01");
const TO = arg("to", "2026-09-19");
const SRC = arg("src", `/mnt/documents/reconciliacion-winerim-historial-${FROM}_${TO}.csv`);

function sql(query) {
  const out = execFileSync("psql", ["-At", "-c", query], { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
  return out.trim() ? JSON.parse(out) : [];
}

/** Minimal RFC4180 CSV parser (quotes + embedded commas/newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(cell); cell = ""; continue; }
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (c === "\r") continue;
    cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift();
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx]])));
}

const csvCell = (v) => {
  const s = v === null || v === undefined || v === "" ? UNKNOWN : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---------------------------------------------------------------- input data
const rows = parseCsv(readFileSync(SRC, "utf8"));

const docTypes = new Map(
  sql(`select coalesce(json_agg(t),'[]'::json)::text from (
    select connection_id::text as cid, provider_doc_id as doc, doc_type
    from sales_events
    where business_day >= '${FROM}' and business_day < '${TO}'
  ) t`).map((r) => [`${r.cid}|${r.doc}`, r.doc_type]),
);

const IDENTIFIED = new Set(["COINCIDENTE_CLAVE", "COINCIDENTE_LEGADO", "CANDIDATA_SIN_CLAVE"]);
const WINERIM_ONLY = new Set(["POSIBLE_DUPLICADA", "FUERA_DE_AGORA"]);

const num = (v) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

for (const r of rows) {
  r.repr = WINERIM_ONLY.has(r.bucket)
    ? "solo_winerim"
    : String(r.ticket_agora).startsWith("open_ticket:")
      ? "ticket_abierto"
      : docTypes.get(`${r.connection_id}|${r.ticket_agora}`) === "BasicRefund"
        ? "devolucion"
        : "factura";
  r.qty = num(r.cantidad_agora);
  r.amount = num(r.importe_agora);
  r.day = String(r.fecha_hora_agora || "").slice(0, 10);
  r.identified = IDENTIFIED.has(r.bucket);
}

// ------------------------------------------------------- reclassification
const byConnection = new Map();
for (const r of rows) {
  if (!byConnection.has(r.connection_id)) byConnection.set(r.connection_id, []);
  byConnection.get(r.connection_id).push(r);
}

const summary = [];
const out = [];

for (const [cid, all] of byConnection) {
  const agora = all.filter((r) => r.repr !== "solo_winerim");
  const exact = new Map(); // wine|format|soldAt|qty|amount -> rows (same physical line)
  const daily = new Map(); // wine|format|day -> rows
  for (const r of agora) {
    const ek = `${r.vino_winerim}|${r.formato}|${r.fecha_hora_agora}|${r.qty}|${r.amount}`;
    const dk = `${r.vino_winerim}|${r.formato}|${r.day}`;
    if (!exact.has(ek)) exact.set(ek, []);
    if (!daily.has(dk)) daily.set(dk, []);
    exact.get(ek).push(r);
    daily.get(dk).push(r);
    r.ek = ek;
    r.dk = dk;
  }

  for (const r of agora) {
    const siblings = exact.get(r.ek).filter((s) => s !== r);
    const identifiedSibling = siblings.find((s) => s.identified);
    const invoiceSibling = siblings.find((s) => s.repr === "factura");

    if (r.repr === "devolucion") {
      r.fase3 = "DEVOLUCION";
      r.motivo = "documento de devolucion (BasicRefund): no es venta ordinaria";
    } else if (r.identified) {
      r.fase3 = r.bucket;
      r.motivo = "identificada en Winerim en la fase 2";
    } else if (identifiedSibling) {
      r.fase3 = "RESUELTA_MISMA_LINEA";
      r.motivo = `misma linea fisica (producto+formato+hora+cantidad+importe) ya identificada en Winerim ${
        identifiedSibling.sale_id && identifiedSibling.sale_id !== UNKNOWN ? `venta ${identifiedSibling.sale_id}` : "por clave"
      } como ${identifiedSibling.repr}: no es faltante`;
      r.ref_sale_id = identifiedSibling.sale_id;
      r.ref_ticket = identifiedSibling.ticket_agora;
    } else if (r.repr === "ticket_abierto" && invoiceSibling) {
      r.fase3 = "REPRESENTACION_PREVIA";
      r.motivo = `representacion previa de la factura ${invoiceSibling.ticket_agora}: se cuenta una sola vez`;
      r.ref_ticket = invoiceSibling.ticket_agora;
    } else if (r.repr === "factura" && siblings.some((s) => s.repr === "ticket_abierto")) {
      r.fase3 = r.bucket === "AMBIGUA" ? "AMBIGUA" : "FALTANTE_REAL";
      r.motivo = "factura con ticket abierto gemelo, ninguno identificado en Winerim";
    } else {
      // Glass/portion breakdown: identified quantity that day already covers this line.
      const group = daily.get(r.dk);
      const idQty = group.filter((s) => s.identified).reduce((a, s) => a + (s.qty || 0), 0);
      const pendQty = group.filter((s) => !s.identified && s.repr !== "devolucion")
        .reduce((a, s) => a + (s.qty || 0), 0);
      if (idQty > 0 && idQty >= pendQty) {
        r.fase3 = "AMBIGUA_POR_DESGLOSE";
        r.motivo = `mismo vino/formato/dia: ${idQty} ud ya identificadas cubren ${pendQty} ud pendientes (posible desglose de copas)`;
      } else if (r.bucket === "AMBIGUA") {
        r.fase3 = "AMBIGUA";
        r.motivo = r.nota || "varias entradas candidatas por vino/formato/dia";
      } else {
        r.fase3 = "FALTANTE_REAL";
        r.motivo = "sin ninguna entrada en el historial de Winerim ni otra representacion identificada";
      }
    }

    // Recovery mode. Stock unknown is NEVER turned into "not discounted".
    if (r.fase3 === "FALTANTE_REAL") {
      r.propuesta = "history_and_stock";
      r.propuesta_nota = "sin rastro en Winerim: falta historial y falta stock";
    } else if (r.identified && r.historial_escrito === "si" && r.stock_aplicado !== "si") {
      r.propuesta = "A_CONFIRMAR";
      r.propuesta_nota = r.stock_aplicado === "no"
        ? "Winerim informa historial sin stock: confirmar antes de mover stock"
        : "efecto sobre stock desconocido: no se puede decidir automaticamente";
    } else {
      r.propuesta = "NINGUNA";
      r.propuesta_nota = r.fase3 === "DEVOLUCION" ? "devolucion, fuera del alcance de la recuperacion" : "";
    }
  }

  const count = (pred) => agora.filter(pred).length;
  const units = (pred) => agora.filter(pred).reduce((a, r) => a + (r.qty || 0), 0);
  summary.push({
    restaurante: all[0].restaurante,
    connection_id: cid,
    lineas: agora.length,
    identificadas: count((r) => r.identified),
    resueltas_misma_linea: count((r) => r.fase3 === "RESUELTA_MISMA_LINEA"),
    representacion_previa: count((r) => r.fase3 === "REPRESENTACION_PREVIA"),
    devoluciones: count((r) => r.fase3 === "DEVOLUCION"),
    ambiguas: count((r) => r.fase3 === "AMBIGUA" || r.fase3 === "AMBIGUA_POR_DESGLOSE"),
    faltantes_reales: count((r) => r.fase3 === "FALTANTE_REAL"),
    uds_faltantes: units((r) => r.fase3 === "FALTANTE_REAL"),
    a_confirmar: count((r) => r.propuesta === "A_CONFIRMAR"),
    faltantes_fase2: count((r) => r.bucket === "FALTANTE_COMPROBADA"),
  });

  for (const r of agora) out.push(r);
}

// ------------------------------------------------------------------ output
mkdirSync("docs/operations", { recursive: true });
const header = [
  "restaurante", "connection_id", "fase3", "propuesta", "representacion", "bucket_fase2",
  "fecha_hora_agora", "ticket_agora", "vino_winerim", "producto", "formato",
  "cantidad", "importe", "order_id", "sale_id", "historial_escrito", "stock_aplicado",
  "ref_ticket", "ref_sale_id", "motivo", "propuesta_nota",
];
const csv = [header.join(",")];
for (const r of out) {
  csv.push([
    r.restaurante, r.connection_id, r.fase3, r.propuesta, r.repr, r.bucket,
    r.fecha_hora_agora, r.ticket_agora, r.vino_winerim, r.producto, r.formato,
    r.cantidad_agora, r.importe_agora, r.order_id, r.sale_id, r.historial_escrito,
    r.stock_aplicado, r.ref_ticket, r.ref_sale_id, r.motivo, r.propuesta_nota,
  ].map(csvCell).join(","));
}
const csvPath = `/mnt/documents/plan-recuperacion-winerim-${FROM}_${TO}.csv`;
writeFileSync(csvPath, csv.join("\n") + "\n");

summary.sort((a, b) => b.faltantes_reales - a.faltantes_reales || a.restaurante.localeCompare(b.restaurante));
const tot = (k) => summary.reduce((a, r) => a + r[k], 0);

const md = [
  `# Plan de recuperación Ágora ↔ Winerim — ${FROM} a ${TO} (exclusivo)`,
  ``,
  `Fase 3. **Solo diagnóstico**: no se importó ninguna venta ni se movió stock.`,
  `Reutiliza la captura de la fase 2 (\`${SRC}\`); no se ha vuelto a leer Winerim.`,
  ``,
  `Correcciones aplicadas sobre las "faltantes comprobadas" de la fase 2:`,
  ``,
  `1. **Ticket abierto ↔ factura**: Ágora conserva la identidad de línea`,
  `   (producto + formato de venta + hora de creación de la línea, guardada en`,
  `   \`provider_sold_at\`). Si la misma línea física aparece como ticket abierto y`,
  `   como factura, es **una sola venta**: basta que una de las dos esté`,
  `   identificada en Winerim para que la otra no sea faltante.`,
  `2. **Devoluciones**: los documentos \`BasicRefund\` salen del cómputo de ventas.`,
  `3. **Copas desglosadas**: cuando las unidades ya identificadas del mismo vino,`,
  `   formato y día cubren las pendientes, la línea queda *ambigua*, no faltante.`,
  `4. **Stock desconocido sigue desconocido**: ninguna línea con efecto de stock`,
  `   no informado se propone para descuento automático; va a *a confirmar*.`,
  ``,
  `| Restaurante | Líneas Ágora | Identificadas | Misma línea ya registrada | Representación previa | Devoluciones | Ambiguas | Faltantes reales | Uds. faltantes | A confirmar | Faltantes fase 2 |`,
  `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
  ...summary.map((r) => `| ${r.restaurante} | ${r.lineas} | ${r.identificadas} | ${r.resueltas_misma_linea} | ${r.representacion_previa} | ${r.devoluciones} | ${r.ambiguas} | ${r.faltantes_reales} | ${r.uds_faltantes} | ${r.a_confirmar} | ${r.faltantes_fase2} |`),
  `| **TOTAL** | ${tot("lineas")} | ${tot("identificadas")} | ${tot("resueltas_misma_linea")} | ${tot("representacion_previa")} | ${tot("devoluciones")} | ${tot("ambiguas")} | ${tot("faltantes_reales")} | ${tot("uds_faltantes")} | ${tot("a_confirmar")} | ${tot("faltantes_fase2")} |`,
  ``,
  `## Propuesta de recuperación (no aplicada)`,
  ``,
  `- **Faltantes reales** → \`history_and_stock\` con \`soldAt\` = fecha y hora exactas`,
  `  del TPV: no existe ninguna entrada en el historial de Winerim ni otra`,
  `  representación identificada de esa línea.`,
  `- **A confirmar** → Winerim informa historial pero el efecto sobre stock es`,
  `  desconocido o negativo. No se propone \`stock_only\` de forma automática.`,
  `- **Misma línea ya registrada / representación previa / devoluciones / ambiguas**`,
  `  → no se recuperan.`,
  ``,
  `Detalle línea a línea, con motivo y referencia cruzada: \`${csvPath}\`.`,
  ``,
].join("\n");
const mdPath = `docs/operations/plan-recuperacion-winerim-${FROM}_${TO}.md`;
writeFileSync(mdPath, md);

console.log(JSON.stringify({ from: FROM, to: TO, totales: {
  lineas: tot("lineas"), faltantes_fase2: tot("faltantes_fase2"), faltantes_reales: tot("faltantes_reales"),
  resueltas_misma_linea: tot("resueltas_misma_linea"), representacion_previa: tot("representacion_previa"),
  devoluciones: tot("devoluciones"), ambiguas: tot("ambiguas"), a_confirmar: tot("a_confirmar"),
}, summary, csvPath, mdPath }, null, 2));
