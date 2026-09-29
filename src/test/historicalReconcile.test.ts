import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dedupeAgoraRepresentations, markMultiSaleAmbiguity, rangeRecordsToWinerimLines, reconcileHistorical, validateHistoricalReconcileRequest } from "../../supabase/functions/_shared/reconciliation-v2/historicalReconcile";
import { reconcileLines } from "../../supabase/functions/_shared/reconciliation-v2/engine";
import type { AgoraLine, WinerimLine } from "../../supabase/functions/_shared/reconciliation-v2/types";

const C = "1c5177f1-9459-4ee9-8b6e-4780f8b6b96b"; const DAY = "2026-09-25";
// Clinic 25/09: [invoice, openTicket, time, wineId, format, qty, amount€]
const AGORA: Array<[string, string, string, string, string, number, number]> = [
  ["27970", "ot-0a5b", "13:44:43", "118501", "COPA", 3, 24], ["27973", "ot-04c2", "13:58:44", "71259", "BOT", 1, 43],
  ["27972", "ot-b8c2", "14:20:55", "202758", "BOT", 1, 33], ["27967", "ot-0719", "14:50:57", "201742", "BOT", 1, 34],
  ["27971", "ot-6cbf", "15:04:28", "70714", "BOT", 1, 33], ["27971", "ot-6cbf", "15:04:38", "71263", "COPA", 2, 17],
  ["27976", "ot-6a07", "20:21:05", "109480", "BOT", 2, 122], ["27975", "ot-353f", "20:52:06", "70760", "COPA", 1, 9],
  ["27978", "ot-6bb6", "21:32:47", "367305", "COPA", 1, 7.5], ["27978", "ot-6bb6", "21:33:01", "71263", "COPA", 3, 25.5],
  ["27979", "ot-bd3b", "22:21:56", "71263", "COPA", 1, 8.5], ["27979", "ot-bd3b", "22:21:58", "118501", "COPA", 1, 8.5],
];
const agoraLine = (doc: string, open: boolean, t: string, wine: string, format: string, qty: number, eur: number): AgoraLine => ({ connectionId: C, restaurantId: 346, businessDay: DAY, documentId: doc, sourceSystem: "AGORA", externalOrderId: doc, orderId: doc, sourceLineId: `${doc}:${t}`, wineId: wine, providerProductId: `p${wine}`, format, quantity: qty, amountMinor: Math.round(eur * 100), effectiveAt: `${DAY}T${t}`, isOpen: open, isCancelled: false });
const agora = AGORA.flatMap(([inv, ot, t, w, f, q, a]) => [agoraLine(inv, false, t, w, f, q, a), agoraLine(ot, true, t, w, f, q, a)]);
const stock = { known: true, status: "APPLIED", evidence: "receipt", receiptId: "r", stockApplied: true, movements: [{ stockMovementId: 1, difference: -1 }] };
const rec = (saleId: number, wineId: number, lines: Array<[string, string, number, number, string]>) => ({ saleId, status: "confirmed", wine: { wineId }, lines: lines.map(([lineId, format, qty, total, at]) => ({ lineId, format, qty, totalAmount: total, effectiveAt: at, source: { sourceSystem: "agora" }, stockEffect: stock })) });
const RANGE = [
  rec(187847, 71259, [["sale:187847", "botella", 1, 43, "2026-09-25T13:58:44"]]), rec(187875, 202758, [["sale:187875", "botella", 1, 33, "2026-09-25T14:20:55"]]),
  rec(187905, 201742, [["sale:187905", "botella", 1, 34, "2026-09-25T14:50:57"]]), rec(187918, 70714, [["sale:187918", "botella", 1, 33, "2026-09-25T15:04:28"]]),
  rec(188753, 71263, [["detail:49886", "copa", 1, 8.5, "2026-09-25T15:04:38"], ["detail:49917", "copa", 1, 8.5, "2026-09-25T15:04:38"], ["detail:50364", "copa", 1, 8.5, "2026-09-26T14:04:00"]]),
  rec(188378, 109480, [["sale:188378", "botella", 1, 61, "2026-09-25T20:21:05"]]), rec(188409, 109480, [["sale:188409", "botella", 1, 61, "2026-09-25T20:21:05"]]),
  rec(188432, 70760, [["detail:49277", "copa", 1, 9, "2026-09-25T20:52:06"], ["detail:53352", "copa", 1, 9.5, "2026-09-28T20:07:27"]]),
];
const rangeLines = rangeRecordsToWinerimLines(RANGE, 346, DAY, "2026-09-25T06:00:00", "2026-09-26T06:00:00");
const persistedLine = (saleId: number, lineId: string, wineId: string, amountMinor: number, at: string): WinerimLine => ({ restaurantId: 346, saleId, lineId, saleDetailId: null, saleStatus: "confirmed", sourceSystem: "agora", externalOrderId: null, orderId: null, sourceLineId: null, invoiceId: null, receiptId: "r", wineId, format: "copa", quantity: 1, amountMinor, effectiveAt: at, businessDay: DAY, stockEffect: { known: true, status: "APPLIED", stockApplied: true, receiptId: "r", movementIds: [2], movementDifference: -1, unbackedQty: null } });
const persisted = [persistedLine(188432, "detail:49277", "70760", 900, "2026-09-25T20:52:06"), persistedLine(186783, "detail:49465", "367305", 750, "2026-09-25T21:32:47")];
const completeness = { agoraComplete: true, winerimComplete: true, stockComplete: true, pagesRead: 0, expectedPages: null, reason: null };
const count = (states: string[]) => Object.fromEntries([...new Set(states)].map((s) => [s, states.filter((x) => x === s).length]));

describe("run-daily-reconciliation historical_range", () => {
  it("rejects dryRun:false, missing businessDay and unknown modes", () => {
    expect(() => validateHistoricalReconcileRequest({ salesSourceMode: "historical_range", dryRun: false, businessDay: DAY })).toThrow(/dryRun/);
    expect(() => validateHistoricalReconcileRequest({ salesSourceMode: "historical_range", businessDay: DAY })).toThrow(/dryRun/);
    expect(() => validateHistoricalReconcileRequest({ salesSourceMode: "historical_range", dryRun: true })).toThrow(/businessDay/);
    expect(() => validateHistoricalReconcileRequest({ salesSourceMode: "historical_range", dryRun: true, businessDay: "2026-13-45x" })).toThrow(/businessDay/);
    expect(() => validateHistoricalReconcileRequest({ salesSourceMode: "incremental", dryRun: true, businessDay: DAY })).toThrow(/salesSourceMode/);
  });
  it("keeps only in-day range lines", () => { expect(rangeLines).toHaveLength(9); expect(rangeLines.every((l) => l.effectiveAt < "2026-09-26T06:00:00")).toBe(true); });
  it("dedupes Clinic 24 Agora rows to 12 economic lines", () => {
    const { economic, supersededOpen } = dedupeAgoraRepresentations(agora);
    expect(agora).toHaveLength(24); expect(economic).toHaveLength(12); expect(supersededOpen).toHaveLength(12); expect(economic.every((l) => !l.isOpen)).toBe(true);
  });
  it("does not dedupe two distinct closed sales with the same signature", () => {
    const twin = [agoraLine("A", false, "10:00:00", "1", "BOT", 1, 10), agoraLine("B", false, "10:00:00", "1", "BOT", 1, 10), agoraLine("ot", true, "10:00:00", "1", "BOT", 1, 10)];
    expect(dedupeAgoraRepresentations(twin).economic).toHaveLength(3);
  });
  it("Clinic fixture: 7 MATCHED, 1 AMBIGUOUS, 4 HISTORY_MISSING without grouping distinct saleIds", () => {
    const out = reconcileHistorical({ connectionId: C, agora, rangeLines, persistedLines: persisted, deletions: [], completeness });
    const agoraResults = out.results.filter((r) => r.agora);
    expect(agoraResults).toHaveLength(12);
    expect(count(agoraResults.map((r) => r.state))).toEqual({ MATCHED: 7, AMBIGUOUS: 1, HISTORY_MISSING: 4 });
    const amb = agoraResults.find((r) => r.state === "AMBIGUOUS")!;
    expect(amb.agora!.wineId).toBe("109480"); expect(amb.winerim).toBeNull(); expect(amb.evidence).toMatchObject({ reason: "MULTI_SALE_SIGNATURE_SUM", candidateSaleIds: [188378, 188409] });
    expect(agoraResults.filter((r) => r.state === "HISTORY_MISSING").map((r) => `${r.agora!.documentId}:${r.agora!.wineId}`).sort()).toEqual(["27970:118501", "27978:71263", "27979:118501", "27979:71263"]);
    expect(out.persistedOnlyLines).toBe(1);
    const extras = out.results.filter((r) => !r.agora).map((r) => r.winerim!.lineId).sort();
    expect(extras).toEqual(["sale:188378", "sale:188409"]);
  });
  it("normal engine is unchanged: same fixture without the overlay keeps 109480 HISTORY_MISSING", () => {
    const economic = dedupeAgoraRepresentations(agora).economic;
    const plain = reconcileLines({ connectionId: C, agora: economic, winerim: [...rangeLines, persisted[1]], deletions: [], completeness });
    expect(plain.find((r) => r.agora?.wineId === "109480")!.state).toBe("HISTORY_MISSING");
    expect(markMultiSaleAmbiguity(plain, [...rangeLines]).find((r) => r.agora?.wineId === "109480")!.state).toBe("AMBIGUOUS");
  });
  it("edge wiring: historical branch is dry-run only, never commits/locks and scheduler never sets the mode", () => {
    const src = readFileSync("supabase/functions/run-daily-reconciliation/index.ts", "utf8");
    const start = src.indexOf("if (historical) {"); const end = src.indexOf("const now = new Date()", start); const branch = src.slice(start, end);
    expect(start).toBeGreaterThan(0);
    for (const f of ["claim(", "rpc(", ".insert(", ".update(", ".upsert(", ".delete(", "salesSync", "checkpoint("]) expect(branch).not.toContain(f);
    expect(src).toContain("if (historical) validateHistoricalReconcileRequest(body)");
    expect(src.indexOf("validateHistoricalReconcileRequest(body)")).toBeLessThan(src.indexOf("asDryRun(body.dryRun)"));
    expect(readFileSync("supabase/scheduler/reconciliation_v2_schedule.example.sql", "utf8")).not.toContain("salesSourceMode");
    expect(src).toContain("let results = historical ? [] : reconcileLines({ connectionId, agora, winerim: winerimRows, deletions: deletionRows, completeness });");
  });
});
