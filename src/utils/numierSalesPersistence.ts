import { supabase } from "@/integrations/supabase/client";

interface PersistableSalesLineItem {
  provider_product_id: string;
  name: string;
  format: string;
  family: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  vat_rate: number;
  is_wine_candidate: boolean;
}

interface PersistableSalesEvent {
  provider_doc_id: string;
  business_day: string;
  doc_type: string;
  total_amount: number;
  total_tax: number;
  total_net: number;
  line_count: number;
  lines: PersistableSalesLineItem[];
}

export async function persistNumierSalesEvents(params: {
  connectionId: string;
  salesEvents: PersistableSalesEvent[];
  lastBusinessDay: string;
}) {
  const { connectionId, salesEvents, lastBusinessDay } = params;

  if (salesEvents.length === 0) {
    return { savedEvents: 0, savedLines: 0 };
  }

  const eventPayload = salesEvents.map((ev) => ({
    connection_id: connectionId,
    provider_doc_id: ev.provider_doc_id,
    business_day: ev.business_day,
    doc_type: ev.doc_type,
    total_amount: ev.total_amount,
    total_tax: ev.total_tax,
    total_net: ev.total_net,
    line_count: ev.line_count,
  }));

  const { data: eventRows, error: eventsError } = await supabase
    .from("sales_events")
    .upsert(eventPayload, { onConflict: "connection_id,provider_doc_id" })
    .select("id, provider_doc_id");

  if (eventsError) throw eventsError;

  const eventIdByProviderDocId = new Map(
    (eventRows || []).map((row) => [row.provider_doc_id, row.id]),
  );

  const eventIds = Array.from(eventIdByProviderDocId.values());
  if (eventIds.length > 0) {
    const { error: deleteError } = await supabase
      .from("sales_line_items")
      .delete()
      .in("sales_event_id", eventIds);

    if (deleteError) throw deleteError;
  }

  const allLineRows = salesEvents.flatMap((ev) => {
    const salesEventId = eventIdByProviderDocId.get(ev.provider_doc_id);
    if (!salesEventId) return [];

    return ev.lines.map((line) => ({
      sales_event_id: salesEventId,
      connection_id: connectionId,
      provider_product_id: line.provider_product_id,
      name: line.name,
      format: line.format,
      family: line.family,
      quantity: line.quantity,
      unit_price: line.unit_price,
      total_amount: line.total_amount,
      vat_rate: line.vat_rate,
      is_wine_candidate: line.is_wine_candidate,
    }));
  });

  const batchSize = 500;
  let savedLines = 0;
  for (let index = 0; index < allLineRows.length; index += batchSize) {
    const batch = allLineRows.slice(index, index + batchSize);
    if (batch.length === 0) continue;

    const { error: lineInsertError } = await supabase
      .from("sales_line_items")
      .insert(batch);

    if (lineInsertError) throw lineInsertError;
    savedLines += batch.length;
  }

  const { error: connectionUpdateError } = await supabase
    .from("pos_connections")
    .update({
      last_sync_at: new Date().toISOString(),
      last_business_day_synced: lastBusinessDay,
    })
    .eq("id", connectionId);

  if (connectionUpdateError) throw connectionUpdateError;

  return {
    savedEvents: eventRows?.length || 0,
    savedLines,
  };
}
