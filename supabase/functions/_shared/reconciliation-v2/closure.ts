// Módulo puro (sin red, sin BD) que cierra técnicamente la v3 en modo AUDIT_ONLY.
// Todo lo que aquí se decide es determinista y probado con fixtures contractuales.

// ---------- 1. Sincronización: primera carga + incremental ----------
export const SYNC_OVERLAP_MS = 24 * 3_600_000;
export const SYNC_STABLE_DELAY_MS = 60_000;

export type SyncCheckpoint = { cursor: string | null; lastCompleteAt: string | null };
export type SyncPageResult = { records: Array<{ identity: string; revisionHash: string }>; deletions: Array<{ identity: string }>; nextCursor: string; hasMore: boolean };

/** Ventana incremental: changedSince = último completo − 24 h; hasta = ahora − 60 s. */
export function incrementalWindow(checkpoint: SyncCheckpoint, now: number) {
  const until = new Date(now - SYNC_STABLE_DELAY_MS).toISOString();
  if (checkpoint.cursor) return { mode: "CURSOR" as const, cursor: checkpoint.cursor, changedSince: null, until };
  if (!checkpoint.lastCompleteAt) return { mode: "FIRST_LOAD" as const, cursor: null, changedSince: null, until };
  return { mode: "INCREMENTAL" as const, cursor: null, changedSince: new Date(Date.parse(checkpoint.lastCompleteAt) - SYNC_OVERLAP_MS).toISOString(), until };
}

/**
 * Ejecuta páginas hasta agotamiento. El cursor solo avanza tras persistir la página
 * entera; ante error o página incompleta, el checkpoint queda donde estaba.
 */
export async function runSync(input: {
  checkpoint: SyncCheckpoint; maxPages: number; now: number;
  fetchPage: (cursor: string | null) => Promise<SyncPageResult>;
  persistPage: (page: SyncPageResult) => Promise<void>;
}) {
  let checkpoint = { ...input.checkpoint }; let pages = 0;
  try {
    let cursor = checkpoint.cursor;
    while (pages < input.maxPages) {
      const page = await input.fetchPage(cursor);
      if (!page || typeof page.nextCursor !== "string") throw new Error("PAGE_INCOMPLETE");
      await input.persistPage(page);
      pages += 1; cursor = page.nextCursor; checkpoint = { ...checkpoint, cursor };
      if (!page.hasMore) return { state: "COMPLETE" as const, pages, checkpoint: { cursor, lastCompleteAt: new Date(input.now - SYNC_STABLE_DELAY_MS).toISOString() } };
    }
    return { state: "SOURCE_INCOMPLETE" as const, pages, checkpoint, error: "MAX_PAGES" };
  } catch (error) {
    return { state: "SOURCE_INCOMPLETE" as const, pages, checkpoint, error: String((error as Error).message ?? error) };
  }
}

/** Almacén idempotente por identidad canónica + revision hash. */
export function applyIdempotent(store: Map<string, string>, page: SyncPageResult) {
  let inserted = 0; let updated = 0; let unchanged = 0; let deleted = 0;
  for (const row of page.records) {
    const prev = store.get(row.identity);
    if (prev === undefined) inserted += 1; else if (prev === row.revisionHash) unchanged += 1; else updated += 1;
    store.set(row.identity, row.revisionHash);
  }
  for (const row of page.deletions) if (store.delete(row.identity)) deleted += 1;
  return { inserted, updated, unchanged, deleted };
}

// ---------- 3/4. Estados canónicos y ciclo fiscal ----------
export const CANONICAL_STATES = ["MATCHED", "HISTORY_MISSING_STOCK_APPLIED", "HISTORY_PRESENT_STOCK_MISSING", "BOTH_MISSING", "STOCK_UNKNOWN", "AMBIGUOUS", "VOIDED_REFUNDED", "SOURCE_INCOMPLETE", "OPEN", "REVERSAL_PENDING"] as const;
export type CanonicalState = (typeof CANONICAL_STATES)[number];
export type FiscalStatus = "OPEN" | "FINAL" | "CANCELLED" | "REFUND";

export type AgoraTicketLine = { identity: string; restaurantId: number; businessDay: string; wineId: string; qty: number; amountMinor: number; status: FiscalStatus; revision: number };
export type WinerimHistoryLine = { lineId: string; restaurantId: number; businessDay: string; wineId: string; qty: number; stockApplied: boolean | null };

/** OPEN→FINAL sustituye la misma identidad; llegadas tardías con revisión mayor reemplazan; CANCELLED/REFUND netean. */
export function foldFiscal(lines: AgoraTicketLine[]) {
  const byId = new Map<string, AgoraTicketLine>();
  for (const line of lines) { const prev = byId.get(line.identity); if (!prev || line.revision >= prev.revision) byId.set(line.identity, line); }
  return [...byId.values()];
}

export function reconcileDay(input: { agora: AgoraTicketLine[]; winerim: WinerimHistoryLine[]; sourcesComplete: boolean; reversalPending?: Set<string>; externalReadback?: Set<string> }) {
  const results: Array<{ identity: string; state: CanonicalState; winerimLineId: string | null; proposal: null }> = [];
  if (!input.sourcesComplete) return { results: input.agora.map((a) => ({ identity: a.identity, state: "SOURCE_INCOMPLETE" as CanonicalState, winerimLineId: null, proposal: null })), totalsQty: 0 };
  const pool = [...input.winerim]; const used = new Set<string>(); let totalsQty = 0;
  for (const line of foldFiscal(input.agora)) {
    if (line.status === "OPEN") { results.push({ identity: line.identity, state: "OPEN", winerimLineId: null, proposal: null }); continue; }
    if (input.reversalPending?.has(line.identity) && !input.externalReadback?.has(line.identity)) { results.push({ identity: line.identity, state: "REVERSAL_PENDING", winerimLineId: null, proposal: null }); continue; }
    if (line.status === "CANCELLED" || line.status === "REFUND") { results.push({ identity: line.identity, state: "VOIDED_REFUNDED", winerimLineId: null, proposal: null }); continue; }
    totalsQty += line.qty;
    const candidates = pool.filter((w) => !used.has(w.lineId) && w.restaurantId === line.restaurantId && w.businessDay === line.businessDay && w.wineId === line.wineId && w.qty === line.qty);
    if (candidates.length > 1) { results.push({ identity: line.identity, state: "AMBIGUOUS", winerimLineId: null, proposal: null }); continue; }
    const match = candidates[0];
    if (!match) { results.push({ identity: line.identity, state: "BOTH_MISSING", winerimLineId: null, proposal: null }); continue; }
    used.add(match.lineId);
    const state: CanonicalState = match.stockApplied === null ? "STOCK_UNKNOWN" : match.stockApplied ? "MATCHED" : "HISTORY_PRESENT_STOCK_MISSING";
    results.push({ identity: line.identity, state, winerimLineId: match.lineId, proposal: null });
  }
  return { results, totalsQty };
}

// ---------- 5. Facturación por categoría ----------
export type RevenueCategory = "WINE" | "OTHER_BEVERAGE" | "FOOD" | "UNCLASSIFIED";
export type CategoryRule = { family: string; category: RevenueCategory; source: "MAPPING" | "RULE" };

export function classifyLine(line: { family: string | null; productId: string; mappedWine: boolean }, rules: CategoryRule[]) {
  if (line.mappedWine) return { category: "WINE" as RevenueCategory, evidence: "MAPPING:product_mappings" };
  const rule = rules.find((r) => line.family != null && r.family === line.family);
  if (rule) return { category: rule.category, evidence: `${rule.source}:family=${rule.family}` };
  return { category: "UNCLASSIFIED" as RevenueCategory, evidence: "SIN_REGLA" }; // nunca por nombre
}

export function revenueSeries(rows: Array<{ day: string; category: RevenueCategory; amountMinor: number }>) {
  const days = new Map<string, Record<RevenueCategory, number>>();
  for (const r of rows) { const d = days.get(r.day) ?? { WINE: 0, OTHER_BEVERAGE: 0, FOOD: 0, UNCLASSIFIED: 0 }; d[r.category] += r.amountMinor; days.set(r.day, d); }
  const series = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => { const total = c.WINE + c.OTHER_BEVERAGE + c.FOOD + c.UNCLASSIFIED; return { day, ...c, total, winePct: total ? c.WINE / total : 0 }; });
  const month = series.reduce((acc, d) => { for (const k of ["WINE", "OTHER_BEVERAGE", "FOOD", "UNCLASSIFIED", "total"] as const) acc[k] += d[k]; return acc; }, { WINE: 0, OTHER_BEVERAGE: 0, FOOD: 0, UNCLASSIFIED: 0, total: 0 });
  const trend = series.length > 1 ? series[series.length - 1].total - series[0].total : 0;
  return { series, month: { ...month, winePct: month.total ? month.WINE / month.total : 0 }, trend };
}

// ---------- 6. CSV fail-closed ----------
export function buildCsv(rows: Array<Record<string, string | number | null>>, coverage: { complete: boolean; reason?: string }) {
  const headers = rows.length ? Object.keys(rows[0]) : ["sin_filas"];
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const banner = coverage.complete ? "# cobertura=COMPLETA" : `# cobertura=INCOMPLETA;motivo=${coverage.reason ?? "fuente incompleta"};NO_USAR_COMO_COMPLETO`;
  return { complete: coverage.complete, filename: coverage.complete ? "conciliacion.csv" : "conciliacion_INCOMPLETA.csv", body: [banner, headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n") };
}

// ---------- 7. Aislamiento tenant y saneado ----------
export function scopeToTenant<T extends { connectionId: string }>(rows: T[], allowed: Set<string>) { return rows.filter((r) => allowed.has(r.connectionId)); }
export function sanitize(text: string) { return text.replace(/wfk_[A-Za-z0-9_-]+/g, "wfk_***").replace(/(WINERIM-API-TOKEN|api-token)\s*[:=]\s*\S+/gi, "$1: ***"); }

// ---------- 11. Estado por referencia (catálogo) ----------
export const REFERENCE_STATES = ["SOLO_INVENTARIO", "ACTIVO_EN_CARTA", "PENDIENTE_DE_PUBLICAR", "PUBLICADO_EN_AGORA", "PRECIO_DIFERENTE", "NO_VISIBLE_EN_PDA"] as const;
export type ReferenceState = (typeof REFERENCE_STATES)[number];
export type Tri = boolean | "DESCONOCIDO";

export type AgoraReadback = {
  source: "READBACK" | "SOURCE_INCOMPLETE";
  salesCenter: string | "DESCONOCIDO"; priceList: string | "DESCONOCIDO"; family: string | "DESCONOCIDO";
  visible: Tri; saleable: Tri; priceMinor: number | "DESCONOCIDO"; readAt: string | null;
};
export type ReferenceInput = {
  connectionId: string; menuId: number; restaurantName: string; wineId: number; name: string; vintage: string; format: string;
  priceMinor: number; stock: number; inInventory: boolean; inActiveMenu: boolean; inInactiveMenu: boolean; availableInAddWine: boolean;
  agora: AgoraReadback | null;
};
export type Tracking = { key: string; openedAt: string; closedAt: string | null };

export const UNKNOWN_AGORA: AgoraReadback = { source: "SOURCE_INCOMPLETE", salesCenter: "DESCONOCIDO", priceList: "DESCONOCIDO", family: "DESCONOCIDO", visible: "DESCONOCIDO", saleable: "DESCONOCIDO", priceMinor: "DESCONOCIDO", readAt: null };

export const trackingKey = (r: Pick<ReferenceInput, "connectionId" | "menuId" | "wineId" | "format">) => `${r.connectionId}|${r.menuId}|${r.wineId}|${r.format}`;

/**
 * SOLO_INVENTARIO nunca pasa a PENDIENTE_DE_PUBLICAR. Solo la entrada en carta activa
 * abre seguimiento; PUBLICADO_EN_AGORA exige readback exacto (no inferencia).
 */
export function referenceState(r: ReferenceInput, tracking: Map<string, Tracking>, now: string) {
  const key = trackingKey(r); const agora = r.agora ?? UNKNOWN_AGORA;
  if (!r.inActiveMenu) {
    const state: ReferenceState = "SOLO_INVENTARIO";
    return { key, state, isIncident: false, agora, tracking: tracking.get(key) ?? null, reason: r.inInventory ? "Existe en ERP/inventario; no está en carta activa ni inactiva" + (r.availableInAddWine ? "; disponible en «añadir vino»" : "") : "No está en carta activa" };
  }
  let t = tracking.get(key); if (!t) { t = { key, openedAt: now, closedAt: null }; tracking.set(key, t); }
  if (agora.source !== "READBACK") return { key, state: "PENDIENTE_DE_PUBLICAR" as ReferenceState, isIncident: true, agora, tracking: t, reason: "Sin readback Ágora: SOURCE_INCOMPLETE" };
  if (agora.visible !== true || agora.saleable !== true) return { key, state: (agora.visible === false || agora.saleable === false ? "NO_VISIBLE_EN_PDA" : "PENDIENTE_DE_PUBLICAR") as ReferenceState, isIncident: true, agora, tracking: t, reason: "Visible/vendible no confirmado" };
  if (agora.priceMinor === "DESCONOCIDO") return { key, state: "PENDIENTE_DE_PUBLICAR" as ReferenceState, isIncident: true, agora, tracking: t, reason: "Precio Ágora desconocido" };
  if (agora.priceMinor !== r.priceMinor) return { key, state: "PRECIO_DIFERENTE" as ReferenceState, isIncident: true, agora, tracking: t, reason: `Ágora ${agora.priceMinor / 100} € ≠ Winerim ${r.priceMinor / 100} €` };
  if ([agora.salesCenter, agora.priceList, agora.family].includes("DESCONOCIDO")) return { key, state: "PENDIENTE_DE_PUBLICAR" as ReferenceState, isIncident: true, agora, tracking: t, reason: "Centro/lista/familia sin readback" };
  t.closedAt = t.closedAt ?? agora.readAt ?? now;
  return { key, state: "PUBLICADO_EN_AGORA" as ReferenceState, isIncident: false, agora, tracking: t, reason: "Readback exacto Ágora" };
}
