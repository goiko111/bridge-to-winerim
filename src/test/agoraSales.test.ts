import {
  agoraDocumentType,
  buildAgoraInvoiceDocId,
  isAgoraDocumentWithinBusinessDay,
  isAgoraRefundDocument,
  normalizeAgoraLineFormat,
  withAgoraOperationalMetadata,
} from "../../supabase/functions/_shared/agoraSales";

describe("Agora sales document identity and refunds", () => {
  it("keeps the legacy number identity for normal invoices", () => {
    const invoice = {
      BusinessDay: "2026-07-14",
      DocumentType: "BasicInvoice",
      Serie: "T",
      Number: 6525,
    };

    expect(buildAgoraInvoiceDocId(invoice, "2026-07-14", 0)).toBe("6525");
    expect(agoraDocumentType(invoice)).toBe("BasicInvoice");
    expect(isAgoraRefundDocument(invoice)).toBe(false);
  });

  it("namespaces refunds so their series counter cannot overwrite an invoice", () => {
    const refund = {
      BusinessDay: "2026-07-14",
      DocumentType: "BasicRefund",
      Serie: "TD",
      Number: 59,
      Totals: { GrossAmount: -87.3 },
    };

    expect(buildAgoraInvoiceDocId(refund, "2026-07-14", 0)).toBe("refund:2026-07-14:td:59");
    expect(isAgoraRefundDocument(refund)).toBe(true);
    expect(withAgoraOperationalMetadata(refund)).toMatchObject({
      _agora_refund: true,
      _stock_sync_eligible: false,
      _stock_sync_skip_reason: "refund_document_requires_explicit_reconciliation",
    });
  });

  it("also recognizes a negative document total when the type is missing", () => {
    expect(isAgoraRefundDocument({ Totals: { GrossAmount: -10 } })).toBe(true);
  });

  it("keeps current and after-midnight lines inside the requested business day", () => {
    const invoice = {
      InvoiceItems: [{
        Lines: [
          { CreationDate: "2026-07-14T22:10:00" },
          { CreationDate: "2026-07-15T01:15:00" },
        ],
      }],
    };

    expect(isAgoraDocumentWithinBusinessDay(invoice, "2026-07-14")).toBe(true);
    expect(withAgoraOperationalMetadata(invoice, "2026-07-14")).toBe(invoice);
  });

  it("keeps stale refund originals for audit but excludes them from stock sync", () => {
    const staleOriginal = {
      DocumentType: "StandardInvoice",
      BusinessDay: "2026-07-14",
      InvoiceItems: [{ Lines: [{ CreationDate: "2026-06-29T21:14:52" }] }],
    };

    expect(isAgoraDocumentWithinBusinessDay(staleOriginal, "2026-07-14")).toBe(false);
    expect(withAgoraOperationalMetadata(staleOriginal, "2026-07-14")).toMatchObject({
      _agora_out_of_day_document: true,
      _stock_sync_eligible: false,
      _stock_sync_skip_reason: "provider_line_dates_outside_requested_business_day",
    });
  });

  it("does not disable providers that omit line timestamps", () => {
    const invoice = { BusinessDay: "2026-07-14", DocumentType: "BasicInvoice" };
    expect(isAgoraDocumentWithinBusinessDay(invoice, "2026-07-14")).toBe(true);
    expect(withAgoraOperationalMetadata(invoice, "2026-07-14")).toBe(invoice);
  });

  it("preserves the exact legacy identity priority for normal invoices", () => {
    const invoice = { InvoiceId: "INV-42", Number: 6525, DocumentType: "BasicInvoice" };
    expect(buildAgoraInvoiceDocId(invoice, "2026-07-14", 0)).toBe("INV-42");
    expect(buildAgoraInvoiceDocId({}, "2026-07-14", 3)).toBe("2026-07-14_inv_3");
  });

  it("normalizes dotted and spaced Agora variant prefixes identically", () => {
    expect(normalizeAgoraLineFormat("C. SEIS+SEIS", "")).toBe("COPA");
    expect(normalizeAgoraLineFormat("C SEIS+SEIS", "")).toBe("COPA");
    expect(normalizeAgoraLineFormat("B. Emilio Moro", "")).toBe("BOT");
    expect(normalizeAgoraLineFormat("M. Prado Enea", "")).toBe("MAGNUM");
  });
});
