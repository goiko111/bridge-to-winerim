import {
  agoraDocumentType,
  buildAgoraInvoiceDocId,
  completeAgoraSalesEventDocIds,
  isAgoraDocumentWithinBusinessDay,
  isAgoraRefundDocument,
  normalizeAgoraLineFormat,
  shouldPauseAgoraInvoiceProcessing,
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

  it("uses only events with all persisted lines as resume checkpoints", () => {
    const completed = completeAgoraSalesEventDocIds([
      { provider_doc_id: "complete", line_count: 3, sales_line_items: [{ count: 3 }] },
      { provider_doc_id: "empty-complete", line_count: 0, sales_line_items: [{ count: 0 }] },
      { provider_doc_id: "insert-crashed", line_count: 4, sales_line_items: [{ count: 0 }] },
      { provider_doc_id: "partial", line_count: 4, sales_line_items: [{ count: 2 }] },
      { provider_doc_id: "missing-count", line_count: 1 },
      { provider_doc_id: "", line_count: 1, sales_line_items: [{ count: 1 }] },
    ]);

    expect([...completed]).toEqual(["complete", "empty-complete"]);
  });

  it("resumes a day with more than one thousand invoices", () => {
    const invoices = Array.from({ length: 1214 }, (_, index) => ({ Number: index + 1 }));
    const firstCycleRows = invoices.slice(0, 915).map((invoice) => ({
      provider_doc_id: String(invoice.Number),
      line_count: 1,
      sales_line_items: [{ count: 1 }],
    }));
    const firstCompleted = completeAgoraSalesEventDocIds(firstCycleRows);
    const firstPending = invoices.filter((invoice, index) => (
      !firstCompleted.has(buildAgoraInvoiceDocId(invoice, "2026-08-03", index))
    ));

    expect(firstPending).toHaveLength(299);

    const secondCycleRows = [
      ...firstCycleRows,
      ...firstPending.slice(0, 175).map((invoice) => ({
        provider_doc_id: String(invoice.Number),
        line_count: 1,
        sales_line_items: [{ count: 1 }],
      })),
    ];
    const secondCompleted = completeAgoraSalesEventDocIds(secondCycleRows);
    const secondPending = invoices.filter((invoice, index) => (
      !secondCompleted.has(buildAgoraInvoiceDocId(invoice, "2026-08-03", index))
    ));

    expect(secondPending).toHaveLength(124);
    expect(secondPending[0]).toEqual({ Number: 1091 });
  });

  it("stops invoice work with time left for a fail-closed response", () => {
    expect(shouldPauseAgoraInvoiceProcessing(104_999, 120_000)).toBe(false);
    expect(shouldPauseAgoraInvoiceProcessing(105_000, 120_000)).toBe(true);
    expect(shouldPauseAgoraInvoiceProcessing(119_999, 120_000, 0)).toBe(false);
    expect(shouldPauseAgoraInvoiceProcessing(120_000, 120_000, 0)).toBe(true);
  });
});
