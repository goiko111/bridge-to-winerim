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

function nextIsoDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function normalizedLocalTimestamp(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]}T${match[2]}` : null;
}

function invoiceLineTimestamps(invoice: Record<string, unknown>): string[] {
  const timestamps: string[] = [];
  const items = Array.isArray(invoice.InvoiceItems) ? invoice.InvoiceItems : [];
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const lines = Array.isArray(item.Lines) ? item.Lines : [];
    for (const rawLine of lines) {
      if (!rawLine || typeof rawLine !== "object") continue;
      const line = rawLine as Record<string, unknown>;
      const timestamp = normalizedLocalTimestamp(
        line.CreationDate ?? line.CreatedAt ?? line.CreatedDate ?? line.Date,
      );
      if (timestamp) timestamps.push(timestamp);
    }
  }
  return timestamps;
}

export function isAgoraDocumentWithinBusinessDay(
  invoice: Record<string, unknown>,
  requestedDay: string,
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDay)) return true;
  const timestamps = invoiceLineTimestamps(invoice);
  if (timestamps.length === 0) return true;

  const start = `${requestedDay}T00:00:00`;
  // Agora business days can legitimately finish after midnight. Noon is a
  // deliberately generous boundary while still rejecting old invoices that
  // reappear only because a refund was created on the requested day.
  const end = `${nextIsoDay(requestedDay)}T12:00:00`;
  return timestamps.some((timestamp) => timestamp >= start && timestamp < end);
}

export function withAgoraOperationalMetadata(
  invoice: Record<string, unknown>,
  requestedDay?: string,
): Record<string, unknown> {
  if (isAgoraRefundDocument(invoice)) {
    return {
      ...invoice,
      _agora_refund: true,
      _stock_sync_eligible: false,
      _stock_sync_skip_reason: "refund_document_requires_explicit_reconciliation",
    };
  }
  if (requestedDay && !isAgoraDocumentWithinBusinessDay(invoice, requestedDay)) {
    return {
      ...invoice,
      _agora_out_of_day_document: true,
      _stock_sync_eligible: false,
      _stock_sync_skip_reason: "provider_line_dates_outside_requested_business_day",
    };
  }
  return invoice;
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
