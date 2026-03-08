import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/* ═══════════════════════════════════════════════════════════════
   DEFAULT TABLE / FIELD MAPPING — overridable per connection
   via provider_config.sql_mapping JSON
   ═══════════════════════════════════════════════════════════════ */
const DEFAULT_SQL_MAPPING = {
  // ── Sales header table ──
  sales_header: {
    table: "Tickets",
    fields: {
      doc_id: "NumTicket",
      business_day: "FechaCierre",      // closure date = business day
      ticket_time: "FechaHora",         // actual ticket timestamp
      doc_type: "TipoDoc",
      total_amount: "Total",
      total_tax: "TotalIVA",
      total_net: "BaseImponible",
    },
    // WHERE filter template — {connectionFilter} is replaced at runtime
    filter: "WHERE FechaCierre = '{businessDay}'",
    order: "ORDER BY NumTicket ASC",
  },
  // ── Sales line table ──
  sales_line: {
    table: "LineasTicket",
    fields: {
      doc_id: "NumTicket",
      line_index: "NumLinea",
      product_id: "CodArticulo",
      product_name: "Descripcion",
      family: "CodFamilia",
      quantity: "Cantidad",
      unit_price: "Precio",
      total_amount: "Importe",
      vat_rate: "PorcIVA",
      format: "Formato",
    },
    join_key: "NumTicket",
  },
  // ── Incremental sync cursors ──
  incremental: {
    cursor_field: "NumTicket",          // last ticket ID synced
    date_field: "FechaCierre",          // closure date for range queries
  },
};

/* ─── Helper: merge user mapping over defaults ─── */
function resolveSqlMapping(cfg: Record<string, any>) {
  const userMapping = cfg.sql_mapping || {};
  return {
    sales_header: { ...DEFAULT_SQL_MAPPING.sales_header, ...userMapping.sales_header },
    sales_line: { ...DEFAULT_SQL_MAPPING.sales_line, ...userMapping.sales_line },
    incremental: { ...DEFAULT_SQL_MAPPING.incremental, ...userMapping.incremental },
  };
}

/* ─── Build placeholder SQL queries (not executed yet — needs bridge agent) ─── */
function buildSalesHeaderQuery(mapping: any, businessDay: string) {
  const h = mapping.sales_header;
  const fields = Object.values(h.fields).join(", ");
  const filter = (h.filter || "").replace("{businessDay}", businessDay);
  return `SELECT ${fields} FROM ${h.table} ${filter} ${h.order || ""}`.trim();
}

function buildSalesLinesQuery(mapping: any, docIds: string[]) {
  const l = mapping.sales_line;
  const fields = Object.values(l.fields).join(", ");
  const ids = docIds.map((id) => `'${id}'`).join(",");
  return `SELECT ${fields} FROM ${l.table} WHERE ${l.join_key} IN (${ids})`.trim();
}

function buildIncrementalQuery(mapping: any, lastTicketId: string | null, lastCloseDate: string | null) {
  const h = mapping.sales_header;
  const inc = mapping.incremental;
  const fields = Object.values(h.fields).join(", ");
  const conditions: string[] = [];
  if (lastCloseDate) conditions.push(`${inc.date_field} >= '${lastCloseDate}'`);
  if (lastTicketId) conditions.push(`${inc.cursor_field} > '${lastTicketId}'`);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return `SELECT ${fields} FROM ${h.table} ${where} ${h.order || ""}`.trim();
}

/* ─── Map raw rows → canonical SalesEvent ─── */
function mapHeaderToCanonical(row: Record<string, any>, fieldMap: Record<string, string>) {
  const inv = Object.fromEntries(Object.entries(fieldMap).map(([k, v]) => [v, k]));
  return {
    provider_doc_id: String(row[fieldMap.doc_id] ?? ""),
    business_day: String(row[fieldMap.business_day] ?? ""),
    ticket_time: row[fieldMap.ticket_time] ? String(row[fieldMap.ticket_time]) : null,
    doc_type: String(row[fieldMap.doc_type] ?? "Ticket"),
    total_amount: Number(row[fieldMap.total_amount] ?? 0),
    total_tax: Number(row[fieldMap.total_tax] ?? 0),
    total_net: Number(row[fieldMap.total_net] ?? 0),
  };
}

function mapLineToCanonical(row: Record<string, any>, fieldMap: Record<string, string>) {
  return {
    provider_product_id: String(row[fieldMap.product_id] ?? ""),
    name: String(row[fieldMap.product_name] ?? ""),
    family: row[fieldMap.family] ? String(row[fieldMap.family]) : null,
    format: row[fieldMap.format] ? String(row[fieldMap.format]) : null,
    line_index: Number(row[fieldMap.line_index] ?? 0),
    quantity: Number(row[fieldMap.quantity] ?? 0),
    unit_price: Number(row[fieldMap.unit_price] ?? 0),
    total_amount: Number(row[fieldMap.total_amount] ?? 0),
    vat_rate: Number(row[fieldMap.vat_rate] ?? 0),
  };
}

/* ═══════════════════════════════════════════════════════════════
   EDGE FUNCTION HANDLER
   ═══════════════════════════════════════════════════════════════ */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  const payload = await req.json();
  const { action, connectionId } = payload;

  // Load connection
  const { data: conn, error: connErr } = await sb
    .from("pos_connections")
    .select("*")
    .eq("id", connectionId)
    .single();
  if (connErr || !conn) {
    return new Response(JSON.stringify({ success: false, message: "Connection not found" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 404,
    });
  }

  const cfg = (conn.provider_config || {}) as Record<string, any>;
  const host = (cfg.host || "").trim();
  const port = (cfg.port || "1433").trim();
  const database = (cfg.database || "FrontRest").trim();
  const dbUser = (cfg.db_username || "").trim();
  const dbPass = (cfg.db_password || "").trim();
  const mapping = resolveSqlMapping(cfg);

  const ok = (data: unknown) =>
    new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  const fail = (msg: string, status = 400) =>
    new Response(JSON.stringify({ success: false, message: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status,
    });

  try {
    // ═══════════ TEST ═══════════
    if (action === "test") {
      if (!host || !dbUser || !dbPass) {
        return ok({ success: false, status: 400, message: "Missing host, username or password" });
      }

      await sb
        .from("pos_connections")
        .update({ last_sync_at: new Date().toISOString(), enabled: true })
        .eq("id", connectionId);

      await sb.from("provider_capabilities").upsert(
        {
          connection_id: connectionId,
          provider: "ICG",
          can_read_sales: true,
          can_read_catalog: true,
          can_write_products: "UNKNOWN",
          last_checked_at: new Date().toISOString(),
        },
        { onConflict: "connection_id" }
      );

      return ok({
        success: true,
        status: 200,
        message: `Configuration saved. SQL Server target: ${host}:${port}/${database}. Direct DB connectivity requires a bridge agent.`,
        version: "Pending bridge agent",
        tables: [],
      });
    }

    // ═══════════ GET-SQL-MAPPING ═══════════
    if (action === "get-sql-mapping") {
      return ok({ success: true, mapping });
    }

    // ═══════════ UPDATE-SQL-MAPPING ═══════════
    if (action === "update-sql-mapping") {
      const newMapping = payload.sqlMapping || {};
      const updatedConfig = { ...cfg, sql_mapping: newMapping };
      await sb.from("pos_connections").update({ provider_config: updatedConfig }).eq("id", connectionId);
      return ok({ success: true, message: "SQL mapping updated", mapping: resolveSqlMapping(updatedConfig) });
    }

    // ═══════════ PREVIEW-SALES-QUERY ═══════════
    if (action === "preview-sales-query") {
      const businessDay = payload.businessDay || new Date().toISOString().slice(0, 10);
      const headerQuery = buildSalesHeaderQuery(mapping, businessDay);
      const linesQuery = buildSalesLinesQuery(mapping, ["<ticket_ids>"]);
      return ok({
        success: true,
        queries: { header: headerQuery, lines: linesQuery },
        message: "These queries will be executed by the bridge agent against the SQL Server.",
      });
    }

    // ═══════════ FETCH-SALES (placeholder — simulates bridge response) ═══════════
    if (action === "fetch-sales") {
      const businessDay = payload.businessDay;
      if (!businessDay) return fail("businessDay is required");

      const headerQuery = buildSalesHeaderQuery(mapping, businessDay);
      // In production, the bridge agent executes this query and returns rows.
      // For now, return the generated SQL + empty results for UI wiring.
      return ok({
        success: true,
        salesEvents: [],
        generatedSQL: headerQuery,
        message: `Query generated for ${businessDay}. Bridge agent required to execute against ${host}:${port}/${database}.`,
      });
    }

    // ═══════════ SAVE-SALES (placeholder — upserts from bridge response) ═══════════
    if (action === "save-sales") {
      const { salesData } = payload; // Expected from bridge agent
      if (!salesData || !Array.isArray(salesData.headers)) {
        return ok({
          success: true,
          savedEvents: 0,
          savedLines: 0,
          errors: [],
          message: "No data provided. Waiting for bridge agent to supply salesData.headers[] and salesData.lines[].",
        });
      }

      const errors: string[] = [];
      let savedEvents = 0;
      let savedLines = 0;

      for (const rawHeader of salesData.headers) {
        const ev = mapHeaderToCanonical(rawHeader, mapping.sales_header.fields);
        if (!ev.provider_doc_id) { errors.push("Header missing doc_id"); continue; }

        const { data: evRow, error: evErr } = await sb
          .from("sales_events")
          .upsert(
            {
              connection_id: connectionId,
              provider_doc_id: ev.provider_doc_id,
              business_day: ev.business_day,
              doc_type: ev.doc_type,
              total_amount: ev.total_amount,
              total_tax: ev.total_tax,
              total_net: ev.total_net,
              line_count: 0,
              raw_json: rawHeader,
            },
            { onConflict: "connection_id,provider_doc_id" }
          )
          .select()
          .single();
        if (evErr) { errors.push(`Event ${ev.provider_doc_id}: ${evErr.message}`); continue; }
        savedEvents++;

        // Find matching lines
        const docLines = (salesData.lines || []).filter(
          (l: any) => String(l[mapping.sales_line.fields.doc_id]) === ev.provider_doc_id
        );

        for (const rawLine of docLines) {
          const line = mapLineToCanonical(rawLine, mapping.sales_line.fields);
          const { error: lErr } = await sb
            .from("sales_line_items")
            .upsert(
              {
                sales_event_id: evRow.id,
                connection_id: connectionId,
                provider_product_id: line.provider_product_id,
                name: line.name,
                family: line.family,
                format: line.format,
                quantity: line.quantity,
                unit_price: line.unit_price,
                total_amount: line.total_amount,
                vat_rate: line.vat_rate,
              },
              { onConflict: "sales_event_id,provider_product_id" }
            );
          if (lErr) { errors.push(`Line ${ev.provider_doc_id}/${line.line_index}: ${lErr.message}`); continue; }
          savedLines++;
        }

        // Update line count
        await sb.from("sales_events").update({ line_count: docLines.length }).eq("id", evRow.id);
      }

      return ok({ success: true, savedEvents, savedLines, errors });
    }

    // ═══════════ INCREMENTAL-SYNC ═══════════
    if (action === "incremental-sync") {
      const lastDay = conn.last_business_day_synced || null;
      // Determine cursor: last_ticket_id stored in provider_config
      const lastTicketId = cfg.last_ticket_id || null;

      const query = buildIncrementalQuery(mapping, lastTicketId, lastDay);

      return ok({
        success: true,
        generatedSQL: query,
        cursor: { last_ticket_id: lastTicketId, last_close_date: lastDay },
        message: `Incremental query generated. Bridge agent required to execute and POST results back via save-sales.`,
      });
    }

    // ═══════════ UPDATE-CURSOR ═══════════
    if (action === "update-cursor") {
      const { lastTicketId, lastCloseDate } = payload;
      const updates: Record<string, any> = {};
      if (lastCloseDate) updates.last_business_day_synced = lastCloseDate;
      if (lastTicketId) {
        updates.provider_config = { ...cfg, last_ticket_id: lastTicketId };
      }
      updates.last_sync_at = new Date().toISOString();
      await sb.from("pos_connections").update(updates).eq("id", connectionId);
      return ok({ success: true, message: "Cursor updated" });
    }

    // ═══════════ BACKFILL ═══════════
    if (action === "backfill") {
      const daysBack = payload.daysBack || 30;
      const queries: string[] = [];
      for (let i = 0; i < daysBack; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const day = d.toISOString().slice(0, 10);
        queries.push(buildSalesHeaderQuery(mapping, day));
      }

      return ok({
        success: true,
        daysBack,
        queriesGenerated: queries.length,
        sampleQuery: queries[0],
        message: `${queries.length} daily queries generated. Bridge agent required to execute sequentially.`,
      });
    }

    return fail(`Unknown action: ${action}`);
  } catch (e: any) {
    return fail(e.message || "Internal error", 500);
  }
});
