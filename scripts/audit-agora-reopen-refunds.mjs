// READ-ONLY audit: Agora refunds / reopens / ticket→invoice conversions (Sept 2026).
// For each refund wine line it proves, per (restaurant, day, wine), whether the
// stock applied in Winerim exceeds the real sales once superseded documents
// (Reopen / ConvertToStandard exact negations) are removed.
import fs from "node:fs";
import os from "node:os";

const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
  const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
const URL = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const session = JSON.parse(fs.readFileSync(`${os.homedir()}/.cache/lovable-auth/session.json`, "utf8")).session;
const H = { apikey: KEY, Authorization: `Bearer ${session.access_token}` };
const FROM = process.argv[2] || "2026-09-01";
const TO = process.argv[3] || "2026-09-30";

async function get(path) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...H, Range: `${off}-${off + 999}` } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const rows = await r.json(); out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
const lines = (raw) => (raw?.InvoiceItems || []).flatMap((i) => i.Lines || []);
const fp = (l) => [l.ProductId, l.SaleFormatId, l.Index, l.CreationDate, Number(l.UnitPrice || 0).toFixed(2)].join("|");
function exactNegation(refRaw, invRaw) {
  const a = new Map(), b = new Map();
  for (const l of lines(invRaw)) { if (!l.CreationDate) return false; a.set(fp(l), (a.get(fp(l)) || 0) + Number(l.Quantity)); }
  for (const l of lines(refRaw)) { if (!l.CreationDate) return false; b.set(fp(l), (b.get(fp(l)) || 0) - Number(l.Quantity)); }
  if (!a.size || a.size !== b.size) return false;
  for (const [k, v] of a) if (Math.abs((b.get(k) ?? NaN) - v) > 1e-9) return false;
  return true;
}

const conns = new Map((await get("pos_connections?select=id,location_name&provider=eq.agora")).map((c) => [c.id, c.location_name]));
const refunds = await get(`sales_events?select=id,connection_id,business_day,provider_doc_id,raw_json&business_day=gte.${FROM}&business_day=lte.${TO}&raw_json->>_agora_refund=eq.true`);
const dayKeys = new Set(refunds.map((r) => `${r.connection_id}|${r.business_day}`));
const rows = [];
for (const dk of dayKeys) {
  const [cid, day] = dk.split("|");
  const events = await get(`sales_events?select=id,doc_type,provider_doc_id,raw_json&connection_id=eq.${cid}&business_day=eq.${day}`);
  const byId = new Map(events.map((e) => [e.id, e]));
  const ids = events.map((e) => e.id);
  const sli = [];
  for (let i = 0; i < ids.length; i += 80) sli.push(...await get(`sales_line_items?select=sales_event_id,winerim_product_id,name,quantity,format&winerim_product_id=not.is.null&sales_event_id=in.(${ids.slice(i, i + 80).join(",")})`));
  const logs = [];
  for (let i = 0; i < ids.length; i += 80) logs.push(...await get(`stock_sync_log?select=sales_event_id,winerim_product_id,variant,quantity,idempotency_key,winerim_response&status=eq.SUCCESS&sales_event_id=in.(${ids.slice(i, i + 80).join(",")})`));
  const invByKey = new Map();
  for (const e of events) if (e.raw_json?._agora_refund !== true && e.raw_json?.Serie) invByKey.set(`${e.raw_json.Serie}#${e.raw_json.Number}`, [...(invByKey.get(`${e.raw_json.Serie}#${e.raw_json.Number}`) || []), e]);
  const superseded = new Set();
  const cls = new Map();
  for (const r of events.filter((e) => e.raw_json?._agora_refund === true)) {
    const rel = r.raw_json.RelatedInvoice || {};
    const m = invByKey.get(`${rel.Serie}#${rel.Number}`) || [];
    const src = String(r.raw_json.RefundSource || "");
    let kind, relId = m[0]?.id || null;
    if (m.length !== 1) kind = "AMBIGUOUS";
    else if (["reopen", "converttostandard"].includes(src.toLowerCase())) {
      if (exactNegation(r.raw_json, m[0].raw_json)) { kind = "SUPERSEDES"; superseded.add(m[0].id); } else kind = "AMBIGUOUS";
    } else kind = exactNegation(r.raw_json, m[0].raw_json) ? "REVERSAL_PENDING_FULL" : "REVERSAL_PENDING_PARTIAL";
    cls.set(r.id, { kind, relId, src, rel: `${rel.Serie || ""} ${rel.Number || ""}`.trim() });
  }
  const definitive = (e) => e.doc_type !== "OpenTicket" && e.raw_json?._agora_refund !== true && e.raw_json?._stock_sync_eligible !== false;
  for (const r of events.filter((e) => cls.has(e.id))) {
    const c = cls.get(r.id);
    const wines = new Map();
    for (const l of sli.filter((l) => l.sales_event_id === r.id)) wines.set(l.winerim_product_id, { name: l.name, q: (wines.get(l.winerim_product_id)?.q || 0) + Number(l.quantity) });
    for (const [w, info] of wines) {
      const sum = (pred) => sli.filter((l) => l.winerim_product_id === w && pred(byId.get(l.sales_event_id))).reduce((s, l) => s + Number(l.quantity), 0);
      const invOld = sum((e) => definitive(e));
      const invNew = sum((e) => definitive(e) && !superseded.has(e.id));
      const wl = logs.filter((l) => l.winerim_product_id === w);
      const applied = wl.reduce((s, l) => s + Number(l.quantity), 0);
      const saleIds = [...new Set(wl.flatMap((l) => (l.winerim_response?.salesImport?.body?.sales || l.winerim_response?.salesImport?.sales || []).map((s) => s.saleId || s.id).filter(Boolean)))];
      const excess = applied - invNew;
      let action;
      if (c.kind === "AMBIGUOUS") action = "Revisar manualmente: no se puede probar la relación línea a línea";
      else if (c.kind.startsWith("REVERSAL_PENDING")) action = excess > 0 ? `Revertir ${excess} en Winerim cuando exista el endpoint` : "Anulación ya neutra en stock o no aplicada; verificar";
      else action = excess > 0 ? `Duplicado probado: revertir ${excess} (conservar la primera venta)` : "Sin duplicado";
      rows.push({ restaurante: conns.get(cid) || cid, dia: day, devolucion: r.provider_doc_id, origen: c.src, factura_relacionada: c.rel, clasificacion: c.kind,
        vino: w, nombre: info.name, qty_devuelta: -info.q, ventas_facturas_antes: invOld, ventas_reales: invNew, stock_aplicado: applied,
        exceso: excess, sale_ids: saleIds.join(" "), confianza: c.kind === "AMBIGUOUS" ? "baja" : "alta (negación exacta línea a línea)", accion: action });
    }
  }
}
rows.sort((a, b) => (a.restaurante + a.dia).localeCompare(b.restaurante + b.dia));
const cols = Object.keys(rows[0] || { restaurante: 1 });
const csv = [cols.join(";"), ...rows.map((r) => cols.map((k) => String(r[k] ?? "").replace(/;/g, ",")).join(";"))].join("\n");
fs.mkdirSync("/mnt/documents", { recursive: true });
fs.writeFileSync(`/mnt/documents/auditoria-reaperturas-anulaciones-${FROM}_${TO}.csv`, csv);
const by = {};
for (const r of rows) { const k = `${r.restaurante}|${r.clasificacion}`; by[k] ||= { n: 0, exceso: 0 }; by[k].n++; by[k].exceso += Math.max(0, r.exceso); }
console.log(JSON.stringify({ lines: rows.length, summary: by, dq: rows.filter((r) => r.restaurante.startsWith("Don Quijote")) }, null, 1));
