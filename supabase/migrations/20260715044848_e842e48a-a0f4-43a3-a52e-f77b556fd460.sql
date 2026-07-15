-- Agora exports refunds through the Invoices feed. They must remain available
-- for audit/reconciliation, but they are not positive sales and must never be
-- sent to Winerim through the stock/sales import path.
UPDATE public.sales_events
SET
  doc_type = COALESCE(NULLIF(raw_json ->> 'DocumentType', ''), doc_type),
  raw_json = raw_json || jsonb_build_object(
    '_agora_refund', true,
    '_stock_sync_eligible', false,
    '_stock_sync_skip_reason', 'refund_document_requires_explicit_reconciliation'
  )
WHERE
  lower(COALESCE(raw_json ->> 'DocumentType', raw_json ->> 'Type', '')) ~ '(refund|credit|void|cancel|anul)'
  OR CASE
    WHEN COALESCE(raw_json #>> '{Totals,GrossAmount}', raw_json ->> 'TotalAmount', '') ~ '^-?[0-9]+([.][0-9]+)?$'
      THEN COALESCE(raw_json #>> '{Totals,GrossAmount}', raw_json ->> 'TotalAmount')::numeric < 0
    ELSE false
  END;

-- Refund and invoice series have independent counters. Namespace existing
-- refund ids so a TD/59 refund cannot overwrite a T/59 normal invoice.
WITH refund_ids AS (
  SELECT
    event.id,
    concat(
      'refund:',
      regexp_replace(lower(COALESCE(NULLIF(event.raw_json ->> 'BusinessDay', ''), event.business_day::text)), '[^a-z0-9_-]+', '-', 'g'),
      ':',
      COALESCE(NULLIF(regexp_replace(lower(COALESCE(event.raw_json ->> 'Serie', '')), '[^a-z0-9_-]+', '-', 'g'), ''), '-'),
      ':',
      regexp_replace(lower(event.raw_json ->> 'Number'), '[^a-z0-9_-]+', '-', 'g')
    ) AS canonical_id
  FROM public.sales_events event
  WHERE
    event.raw_json ->> 'Number' IS NOT NULL
    AND event.raw_json ->> '_agora_refund' = 'true'
    AND event.provider_doc_id NOT LIKE 'refund:%'
)
UPDATE public.sales_events event
SET provider_doc_id = refund_ids.canonical_id
FROM refund_ids
WHERE
  event.id = refund_ids.id
  AND NOT EXISTS (
    SELECT 1
    FROM public.sales_events duplicate
    WHERE duplicate.connection_id = event.connection_id
      AND duplicate.provider_doc_id = refund_ids.canonical_id
      AND duplicate.id <> event.id
  );