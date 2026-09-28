import { describe, expect, it } from "vitest";
import { agoraProviderIdentity, classifyAgoraCoverage, resolveAgoraIdentity, type AgoraDbLine } from "../../supabase/functions/_shared/reconciliation-v2/agoraReader";
import { canonicalizeReconciliationState, RECONCILIATION_STATES } from "../../supabase/functions/_shared/reconciliation-v2/types";

const connectionId = "1c5177f1-9459-4ee9-8b6e-4780f8b6b96b";
const providerLine = (index: number, overrides: Record<string, unknown> = {}) => ({
  classification: "WINE", familyName: "TINTOS WINERIM", lineId: `27747:${index}:0`,
  productName: `Vino Clinic ${index}`, providerProductId: String(1789 + index), quantity: 1,
  saleFormatId: String(1789 + index), soldAt: `2026-09-26T14:${String(index % 60).padStart(2, "0")}:42`,
  totalAmount: 25 + index, unitPrice: 25 + index, ...overrides,
});
const dbLine = (rawLine: ReturnType<typeof providerLine>, lines = [rawLine], overrides: Partial<AgoraDbLine> = {}): AgoraDbLine => ({
  id: crypto.randomUUID(), connection_id: connectionId,
  provider_product_id: String(rawLine.providerProductId), provider_sold_at: String(rawLine.soldAt),
  format: "botella", quantity: Number(rawLine.quantity), total_amount: Number(rawLine.totalAmount),
  winerim_product_id: String(9000 + Number(rawLine.providerProductId)), mapped: true,
  is_wine_candidate: true, family: String(rawLine.familyName), name: String(rawLine.productName),
  sales_event: { provider_doc_id: "27747", business_day: "2026-09-26", doc_type: "BasicInvoice", raw_json: { businessDay: "2026-09-26", documentId: "27747", lifecycleId: "27747", identitySource: "FALLBACK", isRefund: false, kind: "DEFINITIVE_INVOICE", provider: "agora", lines } },
  ...overrides,
});

describe("Agora raw_json.lines adapter", () => {
  it("resolves the actual Clinic invoice shape with immutable line identity", () => {
    const rawLine = providerLine(0, { lineId: "27747:0:0", providerProductId: "1789", quantity: 3, totalAmount: 0, soldAt: "2026-09-08T14:56:42" });
    const row = dbLine(rawLine, [rawLine], { quantity: 3, total_amount: 0, provider_sold_at: "2026-09-08T14:56:42", sales_event: { provider_doc_id: "27747", business_day: "2026-09-08", doc_type: "BasicInvoice", raw_json: { businessDay: "2026-09-08", documentId: "27747", lifecycleId: "27747", identitySource: "FALLBACK", isRefund: false, kind: "DEFINITIVE_INVOICE", provider: "agora", lines: [rawLine] } } });
    const resolved = resolveAgoraIdentity(row, 346);
    expect(resolved.missing).toEqual([]);
    expect(resolved.line).toMatchObject({ restaurantId: 346, documentId: "27747", externalOrderId: "27747", sourceLineId: "27747:0:0", quantity: 3, amountMinor: 0, effectiveAt: "2026-09-08T14:56:42" });
    expect(agoraProviderIdentity(row)).toContain("SALE|27747|27747:0:0|1789");
  });

  it("demonstrates a usable Clinic-size 360-line day and fails closed only on duplicate signatures", () => {
    const lines = Array.from({ length: 360 }, (_, index) => providerLine(index));
    lines[1] = { ...lines[0], lineId: "27747:1:0" };
    const rows = lines.map((line) => dbLine(line, lines));
    const resolutions = rows.map((row) => resolveAgoraIdentity(row, 346));
    expect(resolutions.filter((item) => item.line).length).toBe(358);
    expect(resolutions.filter((item) => item.missing.includes("RAW_LINE_AMBIGUOUS")).length).toBe(2);
  });

  it("classifies a zero-event day as incomplete and does not invent sales", () => {
    expect(classifyAgoraCoverage({ eventCount: 0, lineCount: 0, pageComplete: true, unresolvedCount: 0 })).toEqual({ complete: false, reasons: ["AGORA_NO_EVENTS_FOR_BUSINESS_DAY"] });
  });

  it("preserves business day for late-arriving lines, refunds, open tickets and tenant isolation", () => {
    const late = providerLine(4, { soldAt: "2026-09-27T00:05:00" });
    const lateResult = resolveAgoraIdentity(dbLine(late), 346).line!;
    expect(lateResult.businessDay).toBe("2026-09-26"); expect(lateResult.effectiveAt).toBe("2026-09-27T00:05:00"); expect(lateResult.connectionId).toBe(connectionId);
    const refundRow = dbLine(late, [late], { sales_event: { provider_doc_id: "R-1", business_day: "2026-09-26", doc_type: "BasicRefund", raw_json: { documentId: "R-1", lifecycleId: "R-1", isRefund: true, kind: "REFUND", provider: "agora", lines: [late] } } });
    expect(resolveAgoraIdentity(refundRow, 346).line?.isCancelled).toBe(true);
    const openRow = dbLine(late, [late], { sales_event: { provider_doc_id: "T-1", business_day: "2026-09-26", doc_type: "OpenTicket", raw_json: { documentId: "T-1", lifecycleId: "T-1", isRefund: false, kind: "OPEN_TICKET", provider: "agora", lines: [late] } } });
    expect(resolveAgoraIdentity(openRow, 346).line?.isOpen).toBe(true);
  });

  it("is deterministic across repeated reads", () => {
    const rawLine = providerLine(8); const row = dbLine(rawLine);
    expect(resolveAgoraIdentity(row, 346).line).toEqual(resolveAgoraIdentity(row, 346).line);
  });
});

describe("public state contract v3", () => {
  it("contains exactly the nine visible states", () => expect(RECONCILIATION_STATES).toEqual(["MATCHED","HISTORY_MISSING","STOCK_MISSING","BOTH_MISSING","STOCK_UNKNOWN","AMBIGUOUS","SOURCE_INCOMPLETE","DELETED_OR_CANCELLED","OPEN"]));
  it.each([
    ["MISSING_IN_WINERIM", "HISTORY_MISSING"], ["PARTIAL_STOCK", "STOCK_MISSING"], ["STOCK_CONFLICT", "STOCK_MISSING"],
    ["OPEN_PENDING", "OPEN"], ["REVERSAL_PENDING", "DELETED_OR_CANCELLED"], ["CONFIRMED_DUPLICATE", "AMBIGUOUS"],
    ["RESOLVED_EXTERNALLY", "MATCHED"], ["EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE", "STOCK_UNKNOWN"],
  ])("translates legacy %s explicitly", (legacy, canonical) => expect(canonicalizeReconciliationState(legacy)).toBe(canonical));
});
