import {
  agoraDocumentType,
  buildAgoraInvoiceDocId,
  isAgoraRefundDocument,
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

  it("preserves the exact legacy identity priority for normal invoices", () => {
    const invoice = { InvoiceId: "INV-42", Number: 6525, DocumentType: "BasicInvoice" };
    expect(buildAgoraInvoiceDocId(invoice, "2026-07-14", 0)).toBe("INV-42");
    expect(buildAgoraInvoiceDocId({}, "2026-07-14", 3)).toBe("2026-07-14_inv_3");
  });
});
