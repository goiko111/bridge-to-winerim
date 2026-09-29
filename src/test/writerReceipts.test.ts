import { describe, expect, it } from "vitest";
import { applyWriterReceipts, extractWriterReceipts, toLocalWallClock, writerReceiptOverlayMode } from "../../supabase/functions/_shared/reconciliation-v2/writerReceipts";
import { reconcileLines } from "../../supabase/functions/_shared/reconciliation-v2/engine";
import { reconcileHistorical } from "../../supabase/functions/_shared/reconciliation-v2/historicalReconcile";
import type { AgoraLine, WinerimLine } from "../../supabase/functions/_shared/reconciliation-v2/types";

const C = "e5b988f1-8471-4336-a1f7-a5c1626deab1"; const DAY = "2026-09-28"; const TZ = "Europe/Madrid";
const completeness = { agoraComplete: true, winerimComplete: true, stockComplete: true, pagesRead: 0, expectedPages: null, reason: null };
// Sa Vida 28/09 — 18 glasses appended to older sales: [wine, time, qty, €, saleId, detailIds, receipts split]
const EIGHTEEN: Array<[string, string, number, number, number, number[][]]> = [
  ["148547", "13:42:08", 1, 7, 178328, [[53134]]], ["369275", "15:04:19", 2, 14, 186682, [[53193], [53194]]], ["149565", "16:35:47", 1, 6, 182834, [[53254]]],
  ["148417", "17:05:11", 1, 7, 173368, [[53262]]], ["148575", "19:33:07", 2, 15, 153689, [[53305, 53306]]], ["172366", "20:44:17", 1, 9, 175825, [[53383]]],
  ["186134", "20:44:23", 1, 10.5, 154475, [[53384]]], ["148702", "20:50:19", 2, 19, 151771, [[53398, 53399]]], ["147878", "20:50:34", 1, 6, 178735, [[53400]]],
  ["164985", "21:57:35", 1, 8, 189346, [[53520]]], ["248703", "20:36:22", 2, 17, 190425, [[53376, 53377]]], ["165017", "21:12:32", 1, 8, 190471, [[53424]]],
  ["148394", "21:27:43", 2, 16, 187075, [[53452, 53453]]], ["148940", "21:28:39", 2, 16, 190467, [[53460, 53461]]], ["148014", "21:59:40", 2, 18, 188370, [[53524, 53525]]],
  ["147847", "22:58:00", 1, 7, 187344, [[53608]]], ["149011", "23:11:33", 1, 8, 168498, [[53628]]], ["148001", "23:30:00", 1, 7, 150000, [[53700]]],
];
let n = 0;
const agoraLine = (wine: string, t: string, qty: number, eur: number, open = false, doc = `inv-${wine}-${t}`): AgoraLine => ({ connectionId: C, restaurantId: 568, businessDay: DAY, documentId: doc, sourceSystem: "AGORA", externalOrderId: doc, orderId: doc, sourceLineId: `${doc}:0`, wineId: wine, providerProductId: `8${wine}`, format: "COPA", quantity: qty, amountMinor: Math.round(eur * 100), effectiveAt: `${DAY}T${t}`, isOpen: open, isCancelled: false });
const sale = (wine: string, t: string, qty: number, eur: number, saleId: number, details: number[], extra: Record<string, unknown> = {}) => ({ qty, index: 0, result: "APPLIED", httpStatus: 200, historyWritten: true, saleId, saleDetailIds: details, sourceSystem: "agora", variant: "copa", orderId: `agora:e5b988f1:${DAY}:${wine}:cop:${(n++).toString(36)}`, receiptId: `rcpt_${saleId}_${details.join("_")}`, effectiveAt: `${DAY}T${t}+02:00`, amounts: { source: "catalog", totalAmount: eur }, stockApplied: true, bottleDeducted: false, bottlesOpened: 0, stockMovementIds: [], glasses: { before: 4, after: 5, bottleInUseBefore: true }, ...extra });
const log = (wine: string, sales: unknown[], status = "SUCCESS", id = `log-${n++}`) => ({ id, status, winerim_product_id: wine, winerim_response: { businessDay: DAY, salesImport: { response: { sales } } } });
const eighteenLogs = EIGHTEEN.flatMap(([w, t, q, e, s, groups]) => groups.map((d) => log(w, [sale(w, t, q / groups.length, e / groups.length, s, d)])));
const eighteenAgora = EIGHTEEN.map(([w, t, q, e]) => agoraLine(w, t, q, e));
const missingRows = (agora: AgoraLine[], winerim: WinerimLine[] = []) => reconcileLines({ connectionId: C, agora, winerim, deletions: [], completeness });
const run = (agora: AgoraLine[], logs: ReturnType<typeof log>[], known: WinerimLine[] = []) => applyWriterReceipts(missingRows(agora, known), extractWriterReceipts(logs, { connectionId: C, businessDay: DAY, timeZone: TZ }).receipts, known);
const states = (rows: { state: string }[]) => Object.fromEntries([...new Set(rows.map((r) => r.state))].map((s) => [s, rows.filter((r) => r.state === s).length]));

describe("writer receipts as second causal source (historical_range)", () => {
  it("converts offset timestamps to Madrid wall clock, DST-aware", () => {
    expect(toLocalWallClock("2026-09-28T13:42:08+02:00", TZ)).toBe("2026-09-28T13:42:08");
    expect(toLocalWallClock("2026-11-02T12:00:00Z", TZ)).toBe("2026-11-02T13:00:00");
  });
  it("18 false HISTORY_MISSING are MATCHED by WRITER_RECEIPT keeping provenance and never pretending a range hit", () => {
    expect(states(missingRows(eighteenAgora))).toEqual({ HISTORY_MISSING: 18 });
    const out = run(eighteenAgora, eighteenLogs);
    expect(states(out.results)).toEqual({ MATCHED: 18 }); expect(out.confirmed).toBe(18);
    const e = out.results.find((r) => r.agora?.wineId === "369275")!.evidence as Record<string, unknown>;
    expect(e).toMatchObject({ evidenceKind: "WRITER_RECEIPT", appearedInRemoteRange: false, saleIds: [186682], saleDetailIds: [53193, 53194], quantity: 2 });
    expect((e.receiptIds as string[]).length).toBe(2); expect((e.orderIds as string[]).length).toBe(2);
  });
  it("glass from an already-open bottle keeps Winerim adjustment, no bottle movement invented", () => {
    const e = run(eighteenAgora, eighteenLogs).results[0].evidence as { stockEffect: Record<string, unknown> };
    expect(e.stockEffect).toMatchObject({ source: "WRITER_RECEIPT", stockApplied: true, movementIds: [], bottleDeducted: false, bottlesOpened: 0, bottleMovementInferred: false });
  });
  it("280997: Agora 3.5 glasses vs 4 sent with reused 15:04:12 stays AMBIGUOUS (3 lines)", () => {
    const agora = [agoraLine("280997", "15:04:12", 1, 6), agoraLine("280997", "15:20:40", 2, 12), agoraLine("280997", "16:02:10", 0.5, 3)];
    const logs = [log("280997", [sale("280997", "15:04:12", 1, 6, 188308, [53192])]), log("280997", [sale("280997", "15:04:12", 1, 6, 191456, [53232])]), log("280997", [sale("280997", "15:04:12", 2, 12, 191456, [53275, 53276])])];
    const out = run(agora, logs); expect(states(out.results)).toEqual({ AMBIGUOUS: 3 });
    expect((out.results[0].evidence as { reasons: string[] }).reasons).toContain("QUANTITY_MISMATCH");
    expect((out.results[1].evidence as { reasons: string[] }).reasons).toEqual(["EFFECTIVE_AT_MISMATCH"]);
  });
  it("OPEN is never consumed as invoice", () => {
    const open = agoraLine("148702", "20:50:39", 1, 9.5, true, "ot-040c3845");
    const out = run([open], [log("148702", [sale("148702", "20:50:39", 1, 9.5, 151771, [53399])])]);
    expect(states(out.results)).toEqual({ OPEN: 1 });
  });
  it("duplicate acknowledgement is not consumed twice", () => {
    const s = sale("148547", "13:42:08", 1, 7, 178328, [53134]);
    const ex = extractWriterReceipts([log("148547", [s]), log("148547", [s])], { connectionId: C, businessDay: DAY, timeZone: TZ });
    expect(ex.receipts).toHaveLength(1); expect(ex.rejected.DUPLICATE_RECEIPT).toBe(1);
    expect(states(run([agoraLine("148547", "13:42:08", 2, 14)], [log("148547", [s]), log("148547", [s])]).results)).toEqual({ AMBIGUOUS: 1 });
  });
  it("success without historyWritten does not confirm", () => {
    const out = run([agoraLine("148547", "13:42:08", 1, 7)], [log("148547", [sale("148547", "13:42:08", 1, 7, 178328, [53134], { historyWritten: false })])]);
    expect(states(out.results)).toEqual({ HISTORY_MISSING: 1 });
  });
  it("non-SUCCESS log or non-200 sale does not confirm", () => {
    expect(states(run([agoraLine("148547", "13:42:08", 1, 7)], [log("148547", [sale("148547", "13:42:08", 1, 7, 178328, [53134])], "FAILED")]).results)).toEqual({ HISTORY_MISSING: 1 });
    expect(states(run([agoraLine("148547", "13:42:08", 1, 7)], [log("148547", [sale("148547", "13:42:08", 1, 7, 178328, [53134], { httpStatus: 409 })])]).results)).toEqual({ HISTORY_MISSING: 1 });
  });
  it("incompatible orderId/receipt does not confirm", () => {
    const a = [agoraLine("148547", "13:42:08", 1, 7)];
    expect(states(run(a, [log("148547", [sale("148547", "13:42:08", 1, 7, 178328, [53134], { orderId: "agora:1c5177f1:2026-09-28:148547:cop:x" })])]).results)).toEqual({ HISTORY_MISSING: 1 });
    expect(states(run(a, [log("148547", [sale("148547", "13:42:08", 1, 7, 178328, [53134], { orderId: `agora:e5b988f1:${DAY}:999999:cop:x` })])]).results)).toEqual({ HISTORY_MISSING: 1 });
    expect(states(run(a, [log("148547", [sale("148547", "13:42:08", 1, 7, 178328, [53134], { receiptId: null })])]).results)).toEqual({ HISTORY_MISSING: 1 });
  });
  it("amount mismatch stays AMBIGUOUS", () => {
    expect(states(run([agoraLine("148394", "21:27:43", 1, 8)], [log("148394", [sale("148394", "21:27:43", 1, 7.5, 187075, [53452])])]).results)).toEqual({ AMBIGUOUS: 1 });
  });
  it("receipt already represented by a range line is not reused (no double consumption)", () => {
    const range: WinerimLine = { restaurantId: 568, saleId: 191531, lineId: "sale:191531", saleDetailId: null, saleStatus: "confirmed", sourceSystem: "agora", externalOrderId: null, orderId: null, sourceLineId: null, invoiceId: null, receiptId: "r", wineId: "352358", format: "copa", quantity: 2, amountMinor: 2100, effectiveAt: `${DAY}T19:50:12`, businessDay: DAY, stockEffect: { known: true, status: "APPLIED", stockApplied: true, receiptId: "r", movementIds: [238408], movementDifference: -1, unbackedQty: null } };
    const agora = [agoraLine("352358", "19:50:12", 2, 21)];
    const out = run(agora, [log("352358", [sale("352358", "19:50:12", 2, 21, 191531, [53321, 53322])])], [range]);
    expect(out.excludedAlreadyInRange).toBe(1); expect(out.results[0].state).toBe("MATCHED");
    expect((out.results[0].evidence as Record<string, unknown>).evidenceKind).not.toBe("WRITER_RECEIPT");
  });
  it("Clinic historical regression: without receipts the 7/1/4 path is unchanged", () => {
    const rows = reconcileHistorical({ connectionId: "1c5177f1-9459-4ee9-8b6e-4780f8b6b96b", agora: [], rangeLines: [], persistedLines: [], deletions: [], completeness }).results;
    expect(applyWriterReceipts(rows, [], []).results).toEqual(rows);
  });
  it("normal-path gate: default OFF, explicit + dryRun only, scheduler denied, non-boolean rejected", () => {
    expect(writerReceiptOverlayMode({ requested: undefined, dryRun: true, scheduler: false, historical: false })).toBe("OFF");
    expect(writerReceiptOverlayMode({ requested: false, dryRun: true, scheduler: false, historical: false })).toBe("OFF");
    expect(writerReceiptOverlayMode({ requested: true, dryRun: true, scheduler: false, historical: false })).toBe("NORMAL_DRY_RUN");
    expect(() => writerReceiptOverlayMode({ requested: true, dryRun: false, scheduler: false, historical: false })).toThrow(/dryRun/);
    expect(() => writerReceiptOverlayMode({ requested: true, dryRun: true, scheduler: true, historical: false })).toThrow(/scheduler/);
    expect(() => writerReceiptOverlayMode({ requested: "yes", dryRun: true, scheduler: false, historical: false })).toThrow(/booleano/);
    expect(writerReceiptOverlayMode({ requested: undefined, dryRun: true, scheduler: false, historical: true })).toBe("HISTORICAL");
  });
});
