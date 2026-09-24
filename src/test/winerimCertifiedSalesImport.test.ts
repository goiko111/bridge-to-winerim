import { describe, expect, it } from "vitest";
import {
  assessCertifiedWinerimSalesImportResponse,
  buildCertifiedWinerimSalesImportBody,
  certifiedModeForWinerimSalesImport,
  isWinerimCertifiedSalesImportEnabled,
  retryableCertifiedSales,
} from "../../supabase/functions/_shared/winerimCertifiedSalesImport.ts";

const sale = { orderId: "agora:abc:2026-09-17:363716:cop:xyz", stockId: 20001, qty: 2, soldAt: "2026-09-17T13:20:00+02:00" };

describe("winerim certified sales import", () => {
  it("is opt-in per connection", () => {
    expect(isWinerimCertifiedSalesImportEnabled(null)).toBe(false);
    expect(isWinerimCertifiedSalesImportEnabled({ winerim_certified_sales_import: false })).toBe(false);
    expect(isWinerimCertifiedSalesImportEnabled({ winerim_certified_sales_import: true })).toBe(true);
  });

  it("only moves stock on the live operational lane", () => {
    expect(certifiedModeForWinerimSalesImport({ mode: "operational", live: true })).toBe("history_and_stock");
    expect(certifiedModeForWinerimSalesImport({ mode: "operational", live: false })).toBe("history_only");
    expect(certifiedModeForWinerimSalesImport({ mode: "historical", live: false })).toBe("history_only");
  });

  it("sends mode, sourceSystem, soldAt and a stable sourceLineId", () => {
    const body = buildCertifiedWinerimSalesImportBody({ mode: "history_and_stock", sales: [sale], variant: "copa" });
    expect(body.mode).toBe("history_and_stock");
    expect(body.sourceSystem).toBe("agora");
    const lines = body.sales as Array<Record<string, unknown>>;
    expect(lines[0].soldAt).toBe("2026-09-17T13:20:00+02:00");
    expect(lines[0].sourceLineId).toBe("1");
    expect(lines[0].variant).toBe("copa");
  });

  it("accepts an applied line with stock", () => {
    const result = assessCertifiedWinerimSalesImportResponse({
      status: 200,
      response: { sales: [{ orderId: sale.orderId, result: "APPLIED", stockApplied: true, receiptId: "rcpt_1" }] },
      sales: [sale],
      requireStockApplied: true,
    });
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(1);
    expect(result.stockApplied).toBe(true);
    expect(result.receiptIds).toEqual(["rcpt_1"]);
  });

  it("treats duplicates and legacy-already-imported as done, never as failures", () => {
    const duplicate = assessCertifiedWinerimSalesImportResponse({
      status: 200,
      response: { sales: [{ orderId: sale.orderId, result: "DUPLICATE", stockApplied: true }] },
      sales: [sale],
      requireStockApplied: true,
    });
    expect(duplicate.ok).toBe(true);
    expect(duplicate.skipped).toBe(1);

    const legacy = assessCertifiedWinerimSalesImportResponse({
      status: 409,
      response: { sales: [{ orderId: sale.orderId, result: "REJECTED", reasonCode: "LEGACY_ALREADY_IMPORTED" }] },
      sales: [sale],
      requireStockApplied: true,
    });
    expect(legacy.ok).toBe(true);
    expect(legacy.retryable).toBe(false);
  });

  it("fails closed on validation rejections and flags retryable conflicts", () => {
    const rejected = assessCertifiedWinerimSalesImportResponse({
      status: 400,
      response: { sales: [{ orderId: sale.orderId, result: "REJECTED", reasonCode: "VALIDATION_ERROR", retryable: false }] },
      sales: [sale],
      requireStockApplied: true,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.retryable).toBe(false);

    const busy = { sales: [{ orderId: sale.orderId, result: "REJECTED", reasonCode: "RESOURCE_BUSY", retryable: true }] };
    expect(retryableCertifiedSales([sale], busy)).toEqual([sale]);
    expect(
      assessCertifiedWinerimSalesImportResponse({ status: 409, response: busy, sales: [sale], requireStockApplied: true }).retryable,
    ).toBe(true);
  });

  it("fails when the live lane did not move stock", () => {
    const result = assessCertifiedWinerimSalesImportResponse({
      status: 200,
      response: { sales: [{ orderId: sale.orderId, result: "APPLIED", stockApplied: false, historyWritten: true }] },
      sales: [sale],
      requireStockApplied: true,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts APPLIED with stock_control_disabled as terminal without faking stock", () => {
    const result = assessCertifiedWinerimSalesImportResponse({
      status: 200,
      response: {
        sales: [{
          orderId: sale.orderId,
          result: "APPLIED",
          historyWritten: true,
          stockApplied: false,
          stockSkipReason: "stock_control_disabled",
        }],
      },
      sales: [sale],
      requireStockApplied: true,
    });
    expect(result.ok).toBe(true);
    expect(result.retryable).toBe(false);
    expect(result.failed).toBe(0);
    expect(result.stockApplied).toBe(false);
    expect(result.imported).toBe(1);
  });

  it("accepts DUPLICATE with stock_control_disabled as terminal", () => {
    const result = assessCertifiedWinerimSalesImportResponse({
      status: 200,
      response: {
        sales: [{
          orderId: sale.orderId,
          result: "DUPLICATE",
          historyWritten: true,
          stockApplied: false,
          stockSkipReason: "stock_control_disabled",
        }],
      },
      sales: [sale],
      requireStockApplied: true,
    });
    expect(result.ok).toBe(true);
    expect(result.retryable).toBe(false);
    expect(result.failed).toBe(0);
    expect(result.stockApplied).toBe(false);
    expect(result.skipped).toBe(1);
  });

  it("still fails closed when stock is skipped for any other reason", () => {
    const other = assessCertifiedWinerimSalesImportResponse({
      status: 200,
      response: {
        sales: [{
          orderId: sale.orderId,
          result: "APPLIED",
          historyWritten: true,
          stockApplied: false,
          stockSkipReason: "variant_inactive",
        }],
      },
      sales: [sale],
      requireStockApplied: true,
    });
    expect(other.ok).toBe(false);

    const noReason = assessCertifiedWinerimSalesImportResponse({
      status: 200,
      response: {
        sales: [{ orderId: sale.orderId, result: "APPLIED", historyWritten: true, stockApplied: false }],
      },
      sales: [sale],
      requireStockApplied: true,
    });
    expect(noReason.ok).toBe(false);

    const noHistory = assessCertifiedWinerimSalesImportResponse({
      status: 200,
      response: {
        sales: [{
          orderId: sale.orderId,
          result: "APPLIED",
          historyWritten: false,
          stockApplied: false,
          stockSkipReason: "stock_control_disabled",
        }],
      },
      sales: [sale],
      requireStockApplied: true,
    });
    expect(noHistory.ok).toBe(false);
  });

  it("accepts a history-only line when stock is not required", () => {
    const result = assessCertifiedWinerimSalesImportResponse({
      status: 200,
      response: { sales: [{ orderId: sale.orderId, result: "APPLIED", stockApplied: false, historyWritten: true }] },
      sales: [sale],
      requireStockApplied: false,
    });
    expect(result.ok).toBe(true);
  });
});
