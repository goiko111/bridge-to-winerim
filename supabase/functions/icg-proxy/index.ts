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
      business_day: "FechaCierre",
      ticket_time: "FechaHora",
      doc_type: "TipoDoc",
      total_amount: "Total",
      total_tax: "TotalIVA",
      total_net: "BaseImponible",
    },
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
    cursor_field: "NumTicket",
    date_field: "FechaCierre",
  },
  // ── Catalog: products table ──
  catalog_product: {
    table: "Articulos",
    fields: {
      product_id: "CodArticulo",
      name: "Descripcion",
      family: "CodFamilia",
      price: "PVP1",
      vat_rate: "PorcIVA",
      format: "Formato",
      active: "Activo",
      barcode: "CodigoBarras",
    },
    filter: "WHERE Activo = 1",
    order: "ORDER BY CodArticulo ASC",
  },
  // ── Catalog: families table ──
  catalog_family: {
    table: "Familias",
    fields: {
      family_id: "CodFamilia",
      name: "Descripcion",
    },
    order: "ORDER BY CodFamilia ASC",
  },
  // ── Write: price update ──
  write_price: {
    table: "Articulos",
    fields: {
      product_id: "CodArticulo",
      price: "PVP1",
    },
    // UPDATE template — {productId} and {price} replaced at runtime
    template: "UPDATE Articulos SET PVP1 = {price} WHERE CodArticulo = '{productId}'",
  },
};

/* ─── Helper: deep merge user mapping over defaults ─── */
function resolveSqlMapping(cfg: Record<string, any>) {
  const u = cfg.sql_mapping || {};
  return {
    sales_header: { ...DEFAULT_SQL_MAPPING.sales_header, ...u.sales_header },
    sales_line: { ...DEFAULT_SQL_MAPPING.sales_line, ...u.sales_line },
    incremental: { ...DEFAULT_SQL_MAPPING.incremental, ...u.incremental },
    catalog_product: { ...DEFAULT_SQL_MAPPING.catalog_product, ...u.catalog_product },
    catalog_family: { ...DEFAULT_SQL_MAPPING.catalog_family, ...u.catalog_family },
    write_price: { ...DEFAULT_SQL_MAPPING.write_price, ...u.write_price },
  };
}

/* ─── Sales query builders ─── */
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

/* ─── Catalog query builders ─── */
function buildCatalogProductQuery(mapping: any) {
  const c = mapping.catalog_product;
  const fields = Object.values(c.fields).join(", ");
  return `SELECT ${fields} FROM ${c.table} ${c.filter || ""} ${c.order || ""}`.trim();
}

function buildCatalogFamilyQuery(mapping: any) {
  const f = mapping.catalog_family;
  const fields = Object.values(f.fields).join(", ");
  return `SELECT ${fields} FROM ${f.table} ${f.order || ""}`.trim();
}

function buildPriceUpdateQuery(mapping: any, productId: string, price: number) {
  const w = mapping.write_price;
  return (w.template || DEFAULT_SQL_MAPPING.write_price.template)
    .replace("{productId}", productId)
    .replace("{price}", String(price));
}

function buildVerifyProductQuery(mapping: any, productId: string) {
  const c = mapping.catalog_product;
  const idField = c.fields.product_id;
  const nameField = c.fields.name;
  const priceField = c.fields.price;
  return `SELECT ${idField}, ${nameField}, ${priceField} FROM ${c.table} WHERE ${idField} = '${productId}'`.trim();
}

/* ─── Canonical mappers ─── */
function mapHeaderToCanonical(row: Record<string, any>, fieldMap: Record<string, string>) {
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

function mapCatalogProductToCanonical(row: Record<string, any>, fieldMap: Record<string, string>) {
  return {
    provider_product_id: String(row[fieldMap.product_id] ?? ""),
    name: String(row[fieldMap.name] ?? ""),
    family: row[fieldMap.family] ? String(row[fieldMap.family]) : null,
    price: Number(row[fieldMap.price] ?? 0),
    vat_rate: Number(row[fieldMap.vat_rate] ?? 0),
    format: row[fieldMap.format] ? String(row[fieldMap.format]) : null,
    active: row[fieldMap.active] !== undefined ? Boolean(row[fieldMap.active]) : true,
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

  // Write control flags
  const writeEnabled = cfg.write_enabled === true;
  const requireApproval = cfg.require_manual_approval !== false; // default true

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

      await sb.from("pos_connections")
        .update({ last_sync_at: new Date().toISOString(), enabled: true })
        .eq("id", connectionId);

      await sb.from("provider_capabilities").upsert(
        {
          connection_id: connectionId,
          provider: "ICG",
          can_read_sales: true,
          can_read_catalog: true,
          can_write_products: writeEnabled ? "YES" : "UNKNOWN",
          last_checked_at: new Date().toISOString(),
        },
        { onConflict: "connection_id" }
      );

      return ok({
        success: true,
        status: 200,
        message: `Configuration saved. SQL Server target: ${host}:${port}/${database}. Bridge agent required for execution.`,
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

    // ═══════════ UPDATE-WRITE-SETTINGS ═══════════
    if (action === "update-write-settings") {
      const updatedConfig = {
        ...cfg,
        write_enabled: payload.writeEnabled ?? cfg.write_enabled,
        require_manual_approval: payload.requireApproval ?? cfg.require_manual_approval,
      };
      await sb.from("pos_connections").update({ provider_config: updatedConfig }).eq("id", connectionId);

      // Update capabilities
      await sb.from("provider_capabilities").upsert(
        {
          connection_id: connectionId,
          provider: "ICG",
          can_write_products: updatedConfig.write_enabled ? "YES" : "NO",
          last_checked_at: new Date().toISOString(),
        },
        { onConflict: "connection_id" }
      );

      return ok({
        success: true,
        writeEnabled: updatedConfig.write_enabled,
        requireApproval: updatedConfig.require_manual_approval,
        message: "Write settings updated",
      });
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

    // ═══════════ FETCH-SALES ═══════════
    if (action === "fetch-sales") {
      const businessDay = payload.businessDay;
      if (!businessDay) return fail("businessDay is required");
      const headerQuery = buildSalesHeaderQuery(mapping, businessDay);
      return ok({
        success: true,
        salesEvents: [],
        generatedSQL: headerQuery,
        message: `Query generated for ${businessDay}. Bridge agent required to execute against ${host}:${port}/${database}.`,
      });
    }

    // ═══════════ SAVE-SALES ═══════════
    if (action === "save-sales") {
      const { salesData } = payload;
      if (!salesData || !Array.isArray(salesData.headers)) {
        return ok({
          success: true, savedEvents: 0, savedLines: 0, errors: [],
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
          .upsert({
            connection_id: connectionId,
            provider_doc_id: ev.provider_doc_id,
            business_day: ev.business_day,
            doc_type: ev.doc_type,
            total_amount: ev.total_amount,
            total_tax: ev.total_tax,
            total_net: ev.total_net,
            line_count: 0,
            raw_json: rawHeader,
          }, { onConflict: "connection_id,provider_doc_id" })
          .select().single();
        if (evErr) { errors.push(`Event ${ev.provider_doc_id}: ${evErr.message}`); continue; }
        savedEvents++;

        const docLines = (salesData.lines || []).filter(
          (l: any) => String(l[mapping.sales_line.fields.doc_id]) === ev.provider_doc_id
        );

        for (const rawLine of docLines) {
          const line = mapLineToCanonical(rawLine, mapping.sales_line.fields);
          const { error: lErr } = await sb
            .from("sales_line_items")
            .upsert({
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
            }, { onConflict: "sales_event_id,provider_product_id" });
          if (lErr) { errors.push(`Line ${ev.provider_doc_id}/${line.line_index}: ${lErr.message}`); continue; }
          savedLines++;
        }

        await sb.from("sales_events").update({ line_count: docLines.length }).eq("id", evRow.id);
      }

      return ok({ success: true, savedEvents, savedLines, errors });
    }

    // ═══════════ INCREMENTAL-SYNC ═══════════
    if (action === "incremental-sync") {
      const lastDay = conn.last_business_day_synced || null;
      const lastTicketId = cfg.last_ticket_id || null;
      const query = buildIncrementalQuery(mapping, lastTicketId, lastDay);
      return ok({
        success: true, generatedSQL: query,
        cursor: { last_ticket_id: lastTicketId, last_close_date: lastDay },
        message: `Incremental query generated. Bridge agent required to execute and POST results back via save-sales.`,
      });
    }

    // ═══════════ UPDATE-CURSOR ═══════════
    if (action === "update-cursor") {
      const { lastTicketId, lastCloseDate } = payload;
      const updates: Record<string, any> = {};
      if (lastCloseDate) updates.last_business_day_synced = lastCloseDate;
      if (lastTicketId) updates.provider_config = { ...cfg, last_ticket_id: lastTicketId };
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
        queries.push(buildSalesHeaderQuery(mapping, d.toISOString().slice(0, 10)));
      }
      return ok({
        success: true, daysBack, queriesGenerated: queries.length, sampleQuery: queries[0],
        message: `${queries.length} daily queries generated. Bridge agent required to execute sequentially.`,
      });
    }

    // ═══════════════════════════════════════════════
    // CATALOG ACTIONS
    // ═══════════════════════════════════════════════

    // ═══════════ PREVIEW-CATALOG-QUERY ═══════════
    if (action === "preview-catalog-query") {
      const productQuery = buildCatalogProductQuery(mapping);
      const familyQuery = buildCatalogFamilyQuery(mapping);
      return ok({
        success: true,
        queries: { products: productQuery, families: familyQuery },
        message: "These queries will be executed by the bridge agent to read the ICG product catalog.",
      });
    }

    // ═══════════ SYNC-CATALOG (placeholder — upserts from bridge data) ═══════════
    if (action === "sync-catalog") {
      const { catalogData } = payload;
      if (!catalogData || !Array.isArray(catalogData.products)) {
        const productQuery = buildCatalogProductQuery(mapping);
        const familyQuery = buildCatalogFamilyQuery(mapping);
        return ok({
          success: true,
          totalProducts: 0, upserted: 0, totalFamilies: 0, families: [],
          generatedSQL: { products: productQuery, families: familyQuery },
          errors: [],
          message: "No data provided. Bridge agent must execute the generated SQL and POST catalogData.products[] + catalogData.families[].",
        });
      }

      const errors: string[] = [];
      let upserted = 0;
      const families: { id: string; name: string }[] = [];

      // Process families
      if (Array.isArray(catalogData.families)) {
        for (const rawFam of catalogData.families) {
          const fId = String(rawFam[mapping.catalog_family.fields.family_id] ?? "");
          const fName = String(rawFam[mapping.catalog_family.fields.name] ?? "");
          if (fId) families.push({ id: fId, name: fName });
        }
      }

      // Process products
      for (const rawProd of catalogData.products) {
        const prod = mapCatalogProductToCanonical(rawProd, mapping.catalog_product.fields);
        if (!prod.provider_product_id) { errors.push("Product missing product_id"); continue; }

        const { error: pErr } = await sb
          .from("provider_products")
          .upsert({
            connection_id: connectionId,
            provider_product_id: prod.provider_product_id,
            name: prod.name,
            family: prod.family,
            price: prod.price,
            vat_rate: prod.vat_rate,
            sale_format: prod.format,
            last_synced_at: new Date().toISOString(),
            sync_status: "SYNCED",
          }, { onConflict: "connection_id,provider_product_id" });
        if (pErr) { errors.push(`Product ${prod.provider_product_id}: ${pErr.message}`); continue; }
        upserted++;
      }

      // Update connection catalog metadata
      await sb.from("pos_connections").update({
        last_catalog_sync_at: new Date().toISOString(),
        catalog_product_count: catalogData.products.length,
      }).eq("id", connectionId);

      return ok({
        success: true,
        totalProducts: catalogData.products.length,
        upserted,
        totalFamilies: families.length,
        families,
        errors,
      });
    }

    // ═══════════ WRITE-PRICE (dry-run or live) ═══════════
    if (action === "write-price") {
      const { productId, price, dryRun } = payload;
      if (!productId || price === undefined) return fail("productId and price are required");

      const isDryRun = dryRun === true;
      const updateSQL = buildPriceUpdateQuery(mapping, productId, price);
      const verifySQL = buildVerifyProductQuery(mapping, productId);

      // Gate: write must be enabled
      if (!isDryRun && !writeEnabled) {
        return ok({
          success: false,
          blocked: true,
          reason: "WRITE_DISABLED",
          message: "Price writes are disabled for this connection. Enable writes in the Catalog & Write settings.",
          generatedSQL: updateSQL,
        });
      }

      // Gate: manual approval required — enqueue as outbound_task
      if (!isDryRun && requireApproval) {
        const { data: task, error: tErr } = await sb
          .from("outbound_tasks")
          .insert({
            connection_id: connectionId,
            task_type: "ICG_PRICE_UPDATE",
            status: "PENDING_APPROVAL",
            payload_json: { productId, price, updateSQL, verifySQL },
          })
          .select().single();

        return ok({
          success: true,
          pendingApproval: true,
          taskId: task?.id,
          message: `Price update queued for manual approval (task ${task?.id}). Approve it to execute.`,
          generatedSQL: updateSQL,
        });
      }

      // Dry run — just return the SQL
      if (isDryRun) {
        return ok({
          success: true,
          dryRun: true,
          generatedSQL: updateSQL,
          verifySQL,
          message: `DRY RUN — This UPDATE would be executed by the bridge agent. No changes made.`,
        });
      }

      // Live write placeholder — bridge agent would execute
      return ok({
        success: true,
        executed: false,
        generatedSQL: updateSQL,
        verifySQL,
        message: `Write SQL generated. Bridge agent required to execute UPDATE against ${host}:${port}/${database}.`,
      });
    }

    // ═══════════ APPROVE-WRITE ═══════════
    if (action === "approve-write") {
      const { taskId } = payload;
      if (!taskId) return fail("taskId is required");

      const { data: task, error: tErr } = await sb
        .from("outbound_tasks")
        .select("*")
        .eq("id", taskId)
        .eq("connection_id", connectionId)
        .single();
      if (tErr || !task) return fail("Task not found");
      if (task.status !== "PENDING_APPROVAL") return fail(`Task status is ${task.status}, expected PENDING_APPROVAL`);

      // Move to QUEUED for bridge agent execution
      await sb.from("outbound_tasks").update({ status: "QUEUED", updated_at: new Date().toISOString() }).eq("id", taskId);

      const p = task.payload_json as any;
      return ok({
        success: true,
        message: `Task ${taskId} approved and queued for execution.`,
        generatedSQL: p?.updateSQL,
      });
    }

    // ═══════════ REJECT-WRITE ═══════════
    if (action === "reject-write") {
      const { taskId, reason } = payload;
      if (!taskId) return fail("taskId is required");

      await sb.from("outbound_tasks").update({
        status: "REJECTED",
        blocked_reason: reason || "Rejected by operator",
        updated_at: new Date().toISOString(),
      }).eq("id", taskId).eq("connection_id", connectionId);

      return ok({ success: true, message: `Task ${taskId} rejected.` });
    }

    // ═══════════ LIST-PENDING-WRITES ═══════════
    if (action === "list-pending-writes") {
      const { data: tasks } = await sb
        .from("outbound_tasks")
        .select("*")
        .eq("connection_id", connectionId)
        .eq("task_type", "ICG_PRICE_UPDATE")
        .eq("status", "PENDING_APPROVAL")
        .order("created_at", { ascending: false })
        .limit(50);

      return ok({
        success: true,
        tasks: (tasks || []).map((t: any) => ({
          id: t.id,
          productId: (t.payload_json as any)?.productId,
          price: (t.payload_json as any)?.price,
          sql: (t.payload_json as any)?.updateSQL,
          createdAt: t.created_at,
        })),
      });
    }

    // ═══════════ VERIFY-PRODUCT ═══════════
    if (action === "verify-product") {
      const { productId } = payload;
      if (!productId) return fail("productId is required");
      const verifySQL = buildVerifyProductQuery(mapping, productId);
      return ok({
        success: true,
        generatedSQL: verifySQL,
        message: `Verify query generated. Bridge agent must execute and return the row to confirm product exists with price > 0.`,
      });
    }

    return fail(`Unknown action: ${action}`);
  } catch (e: any) {
    return fail(e.message || "Internal error", 500);
  }
});
