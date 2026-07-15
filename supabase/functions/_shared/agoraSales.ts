function normalizedIdPart(value: unknown, fallback = "-"): string {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return normalized || fallback;
}

export function agoraDocumentType(invoice: Record<string, unknown>): string {
  return String(invoice.DocumentType || invoice.Type || "BasicInvoice").trim() || "BasicInvoice";
}

export function isAgoraRefundDocument(invoice: Record<string, unknown>): boolean {
  const documentType = agoraDocumentType(invoice).toLowerCase();
  if (/refund|credit|void|cancel|anul/.test(documentType)) return true;

  const totals = invoice.Totals as Record<string, unknown> | undefined;
  const grossAmount = Number(totals?.GrossAmount ?? invoice.TotalAmount);
  return Number.isFinite(grossAmount) && grossAmount < 0;
}

export function withAgoraOperationalMetadata(invoice: Record<string, unknown>): Record<string, unknown> {
  if (!isAgoraRefundDocument(invoice)) return invoice;
  return {
    ...invoice,
    _agora_refund: true,
    _stock_sync_eligible: false,
    _stock_sync_skip_reason: "refund_document_requires_explicit_reconciliation",
  };
}

// Preserve the exact legacy candidate order for normal invoices so a deploy
// cannot duplicate historical sales by changing provider_doc_id.
// Refund counters live in a separate series and must be namespaced: otherwise
// a refund can overwrite a normal invoice that happens to share its number.
export function buildAgoraInvoiceDocId(
  invoice: Record<string, unknown>,
  requestedDay: string,
  invoiceIndex: number,
): string {
  const legacyIdCandidates = [
    invoice.GlobalId,
    invoice.InvoiceId,
    invoice.Id,
    invoice.DocumentId,
    invoice.DocId,
    invoice.TicketId,
    invoice.OrderId,
    invoice.Number,
    invoice.InvoiceNumber,
    invoice.DocumentNumber,
    invoice.Code,
  ];
  const legacyId = legacyIdCandidates
    .map((candidate) => String(candidate || "").trim())
    .find(Boolean);
  const businessDay = /^\d{4}-\d{2}-\d{2}$/.test(String(invoice.BusinessDay || ""))
    ? String(invoice.BusinessDay)
    : requestedDay;

  if (legacyId && !isAgoraRefundDocument(invoice)) return legacyId;
  if (legacyId) {
    return ["refund", normalizedIdPart(businessDay), normalizedIdPart(invoice.Serie), normalizedIdPart(legacyId)].join(":");
  }

  const legacyFallback = `${requestedDay}_inv_${invoiceIndex}`;
  return isAgoraRefundDocument(invoice)
    ? `refund:${normalizedIdPart(businessDay)}:fallback:${invoiceIndex}`
    : legacyFallback;
}
