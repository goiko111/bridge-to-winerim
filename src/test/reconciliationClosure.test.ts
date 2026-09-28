import { describe, expect, it } from "vitest";
import { applyIdempotent, buildCsv, classifyLine, incrementalWindow, reconcileDay, referenceState, revenueSeries, runSync, sanitize, scopeToTenant, UNKNOWN_AGORA, type AgoraTicketLine, type SyncPageResult, type Tracking } from "../../supabase/functions/_shared/reconciliation-v2/closure";
import { CLINIC_PETALOS_2023, CLINIC_PETALOS_2023_PUBLISHED } from "../../supabase/functions/_shared/reconciliation-v2/fixtures/reference-states";
import { createWinerimFleetClient } from "../../supabase/functions/_shared/reconciliation-v2/winerimFleetClient";

const NOW = Date.parse("2026-09-28T10:00:00Z");
const page = (n: number, hasMore: boolean): SyncPageResult => ({ records: [{ identity: `r${n}`, revisionHash: "h1" }], deletions: [], nextCursor: `c${n}`, hasMore });
const line = (p: Partial<AgoraTicketLine>): AgoraTicketLine => ({ identity: "T1|L1", restaurantId: 9, businessDay: "2026-09-26", wineId: "w1", qty: 1, amountMinor: 3700, status: "FINAL", revision: 1, ...p });

describe("sincronización", () => {
  it("primera carga paginada hasta agotamiento y luego incremental con solape 24 h y retraso 60 s", async () => {
    expect(incrementalWindow({ cursor: null, lastCompleteAt: null }, NOW).mode).toBe("FIRST_LOAD");
    const pages = [page(1, true), page(2, true), page(3, false)]; let i = 0;
    const res = await runSync({ checkpoint: { cursor: null, lastCompleteAt: null }, maxPages: 10, now: NOW, fetchPage: async () => pages[i++], persistPage: async () => {} });
    expect(res).toMatchObject({ state: "COMPLETE", pages: 3, checkpoint: { cursor: "c3", lastCompleteAt: "2026-09-28T09:59:00.000Z" } });
    const w = incrementalWindow({ cursor: null, lastCompleteAt: "2026-09-28T09:59:00.000Z" }, NOW);
    expect(w).toMatchObject({ mode: "INCREMENTAL", changedSince: "2026-09-27T09:59:00.000Z", until: "2026-09-28T09:59:00.000Z" });
  });
  it("caída en página N: el cursor no avanza más allá de la última página persistida", async () => {
    let i = 0; const res = await runSync({ checkpoint: { cursor: "c0", lastCompleteAt: null }, maxPages: 10, now: NOW, fetchPage: async () => { i += 1; if (i === 3) throw new Error("HTTP_503"); return page(i, true); }, persistPage: async () => {} });
    expect(res).toMatchObject({ state: "SOURCE_INCOMPLETE", pages: 2, checkpoint: { cursor: "c2", lastCompleteAt: null } });
    const failPersist = await runSync({ checkpoint: { cursor: "c0", lastCompleteAt: null }, maxPages: 5, now: NOW, fetchPage: async () => page(1, false), persistPage: async () => { throw new Error("DB"); } });
    expect(failPersist.checkpoint.cursor).toBe("c0");
  });
  it("idempotencia: venta nueva, corrección, reenvío y borrado", () => {
    const store = new Map<string, string>();
    expect(applyIdempotent(store, page(1, false))).toMatchObject({ inserted: 1 });
    expect(applyIdempotent(store, page(1, false))).toMatchObject({ unchanged: 1, inserted: 0 });
    expect(applyIdempotent(store, { records: [{ identity: "r1", revisionHash: "h2" }], deletions: [], nextCursor: "x", hasMore: false })).toMatchObject({ updated: 1 });
    expect(applyIdempotent(store, { records: [], deletions: [{ identity: "r1" }], nextCursor: "x", hasMore: false })).toMatchObject({ deleted: 1 }); expect(store.size).toBe(0);
  });
  it("429 con Retry-After está acotado (sin bucle) y 400 no reintenta", async () => {
    let calls = 0; const sleeps: number[] = [];
    const c = createWinerimFleetClient({ token: "wfk_x", fetchImpl: async () => { calls += 1; return new Response("{}", { status: 429, headers: { "Retry-After": "120" } }); }, sleep: async (ms) => { sleeps.push(ms); } });
    await expect(c.restaurants()).rejects.toMatchObject({ code: "HTTP_429" }); expect(calls).toBe(3); expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
    calls = 0; const bad = createWinerimFleetClient({ token: "wfk_x", fetchImpl: async () => { calls += 1; return new Response("{}", { status: 400 }); }, sleep: async () => {} });
    await expect(bad.restaurants()).rejects.toMatchObject({ code: "HTTP_400" }); expect(calls).toBe(1);
  });
  it("respuesta nula y snapshot /stock validados; movimientos con cursor", async () => {
    const nul = createWinerimFleetClient({ token: "wfk_x", fetchImpl: async () => new Response("null", { status: 200 }) });
    await expect(nul.restaurants()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const mv = createWinerimFleetClient({ token: "wfk_x", fetchImpl: async () => new Response(JSON.stringify({ restaurantId: 9, data: [{ movementId: 5 }], nextAfterId: 5, hasMore: false })) });
    await expect(mv.movements(9, { afterId: 4 })).resolves.toMatchObject({ nextAfterId: 5, hasMore: false });
  });
});

describe("reconciliación y ciclo fiscal", () => {
  const w = [{ lineId: "W1", restaurantId: 9, businessDay: "2026-09-26", wineId: "w1", qty: 1, stockApplied: true }];
  it("OPEN excluido; OPEN→FINAL sin duplicar; cada línea Winerim se consume una vez", () => {
    expect(reconcileDay({ agora: [line({ status: "OPEN" })], winerim: w, sourcesComplete: true })).toMatchObject({ results: [{ state: "OPEN" }], totalsQty: 0 });
    const r = reconcileDay({ agora: [line({ status: "OPEN", revision: 1 }), line({ status: "FINAL", revision: 2 })], winerim: w, sourcesComplete: true });
    expect(r.results).toHaveLength(1); expect(r.results[0]).toMatchObject({ state: "MATCHED", winerimLineId: "W1", proposal: null });
    const dup = reconcileDay({ agora: [line({}), line({ identity: "T2|L1" })], winerim: w, sourcesComplete: true });
    expect(dup.results.map((x) => x.state)).toEqual(["MATCHED", "BOTH_MISSING"]);
  });
  it("cancelación/devolución, REVERSAL_PENDING, llegada tardía, stock y fuente incompleta", () => {
    expect(reconcileDay({ agora: [line({ status: "REFUND" })], winerim: w, sourcesComplete: true }).results[0].state).toBe("VOIDED_REFUNDED");
    expect(reconcileDay({ agora: [line({})], winerim: w, sourcesComplete: true, reversalPending: new Set(["T1|L1"]) }).results[0].state).toBe("REVERSAL_PENDING");
    expect(reconcileDay({ agora: [line({})], winerim: w, sourcesComplete: true, reversalPending: new Set(["T1|L1"]), externalReadback: new Set(["T1|L1"]) }).results[0].state).toBe("MATCHED");
    expect(reconcileDay({ agora: [line({ qty: 1, revision: 1 }), line({ qty: 2, revision: 3 })], winerim: w, sourcesComplete: true }).results[0].state).toBe("BOTH_MISSING");
    expect(reconcileDay({ agora: [line({})], winerim: [{ ...w[0], stockApplied: false }], sourcesComplete: true }).results[0].state).toBe("HISTORY_PRESENT_STOCK_MISSING");
    expect(reconcileDay({ agora: [line({})], winerim: [{ ...w[0], stockApplied: null }], sourcesComplete: true }).results[0].state).toBe("STOCK_UNKNOWN");
    expect(reconcileDay({ agora: [line({})], winerim: [w[0], { ...w[0], lineId: "W2" }], sourcesComplete: true }).results[0].state).toBe("AMBIGUOUS");
    expect(reconcileDay({ agora: [line({})], winerim: w, sourcesComplete: false }).results[0].state).toBe("SOURCE_INCOMPLETE");
  });
});

describe("categorías, CSV, tenant y secretos", () => {
  it("clasifica solo por mapping/regla y calcula evolutivo", () => {
    const rules = [{ family: "CERVEZAS", category: "OTHER_BEVERAGE" as const, source: "RULE" as const }];
    expect(classifyLine({ family: "VINOS TINTOS", productId: "1", mappedWine: false }, rules)).toEqual({ category: "UNCLASSIFIED", evidence: "SIN_REGLA" });
    expect(classifyLine({ family: "X", productId: "2", mappedWine: true }, rules).category).toBe("WINE");
    const s = revenueSeries([{ day: "2026-09-01", category: "WINE", amountMinor: 1000 }, { day: "2026-09-01", category: "FOOD", amountMinor: 1000 }, { day: "2026-09-02", category: "WINE", amountMinor: 3000 }]);
    expect(s.month).toMatchObject({ total: 5000, WINE: 4000, winePct: 0.8 }); expect(s.trend).toBe(1000); expect(s.series[0].winePct).toBe(0.5);
  });
  it("CSV completo vs incompleto fail-closed", () => {
    expect(buildCsv([{ a: 1 }], { complete: true })).toMatchObject({ complete: true, filename: "conciliacion.csv" });
    const inc = buildCsv([{ a: "x,y" }], { complete: false, reason: "página 3 fallida" });
    expect(inc.filename).toBe("conciliacion_INCOMPLETA.csv"); expect(inc.body).toContain("NO_USAR_COMO_COMPLETO"); expect(inc.body).toContain('"x,y"');
  });
  it("tenant cruzado filtrado y token saneado", () => {
    expect(scopeToTenant([{ connectionId: "a" }, { connectionId: "b" }], new Set(["a"]))).toEqual([{ connectionId: "a" }]);
    expect(sanitize("err WINERIM-API-TOKEN: wfk_abc123 url?x=wfk_zz")).not.toMatch(/wfk_[a-z0-9]/);
  });
});

describe("estado por referencia", () => {
  it("Clinic menuId 346 Pétalos del Bierzo 2023: SOLO_INVENTARIO, sin incidencia ni seguimiento, Ágora DESCONOCIDO", () => {
    const tracking = new Map<string, Tracking>();
    const r = referenceState(CLINIC_PETALOS_2023, tracking, "2026-09-28T09:30:00Z");
    expect(r).toMatchObject({ state: "SOLO_INVENTARIO", isIncident: false, tracking: null, agora: UNKNOWN_AGORA });
    expect(r.state).not.toBe("PENDIENTE_DE_PUBLICAR"); expect(tracking.size).toBe(0);
  });
  it("al entrar en carta: seguimiento determinista y PUBLICADO solo con readback exacto", () => {
    const tracking = new Map<string, Tracking>();
    const pending = referenceState({ ...CLINIC_PETALOS_2023, inActiveMenu: true }, tracking, "2026-09-28T09:30:00Z");
    expect(pending).toMatchObject({ state: "PENDIENTE_DE_PUBLICAR", isIncident: true }); expect(pending.tracking?.key).toBe("taberna-del-clinic|346|372078|BOTELLA_750");
    const pub = referenceState(CLINIC_PETALOS_2023_PUBLISHED, tracking, "2026-09-28T09:40:00Z");
    expect(pub).toMatchObject({ state: "PUBLICADO_EN_AGORA", isIncident: false }); expect(pub.tracking?.openedAt).toBe("2026-09-28T09:30:00Z"); expect(tracking.size).toBe(1);
    const agora = CLINIC_PETALOS_2023_PUBLISHED.agora!;
    expect(referenceState({ ...CLINIC_PETALOS_2023_PUBLISHED, agora: { ...agora, priceMinor: 3900 } }, new Map(), "t").state).toBe("PRECIO_DIFERENTE");
    expect(referenceState({ ...CLINIC_PETALOS_2023_PUBLISHED, agora: { ...agora, visible: false } }, new Map(), "t").state).toBe("NO_VISIBLE_EN_PDA");
    expect(referenceState({ ...CLINIC_PETALOS_2023_PUBLISHED, agora: { ...agora, family: "DESCONOCIDO" } }, new Map(), "t").state).toBe("PENDIENTE_DE_PUBLICAR");
    expect(referenceState({ ...CLINIC_PETALOS_2023, inActiveMenu: false, agora }, new Map(), "t").state).toBe("SOLO_INVENTARIO");
  });
});
