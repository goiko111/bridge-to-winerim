import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Default wine-like family names (case-insensitive match)
const DEFAULT_WINE_FAMILIES = [
  "vino", "vinos", "bodega", "bodegas", "cava", "cavas", "champagne",
  "espumoso", "espumosos", "tinto", "tintos", "blanco", "blancos",
  "rosado", "rosados", "crianza", "reserva", "bebidas", "wine", "wines",
];

const NON_WINE_KEYWORDS = [
  "agua", "water", "snack", "tarta", "postre", "café", "coffee", "té",
  "tea", "refresco", "zumo", "juice", "cerveza", "beer", "pan", "bread",
];

interface AgoraLine {
  ProductId?: string;
  ProductName?: string;
  SaleFormatName?: string;
  FamilyName?: string;
  Quantity?: number;
  UnitPrice?: number;
  TotalAmount?: number;
  VatRate?: number;
  [key: string]: unknown;
}

interface AgoraInvoiceItem {
  Lines?: AgoraLine[];
  [key: string]: unknown;
}

interface AgoraInvoice {
  InvoiceId?: string;
  Id?: string;
  InvoiceItems?: AgoraInvoiceItem[];
  TotalAmount?: number;
  TotalTaxAmount?: number;
  TotalNetAmount?: number;
  Type?: string;
  [key: string]: unknown;
}

function parseInvoices(data: Record<string, unknown>): AgoraInvoice[] {
  if (data.Invoices && Array.isArray(data.Invoices)) return data.Invoices;
  // Try top-level array
  if (Array.isArray(data)) return data;
  return [];
}

function isWineCandidate(
  family: string | undefined,
  name: string | undefined,
  wineFamilies: string[]
): boolean {
  const f = (family || "").toLowerCase();
  const n = (name || "").toLowerCase();

  // If family matches non-wine keywords, exclude
  for (const kw of NON_WINE_KEYWORDS) {
    if (f.includes(kw) || n.includes(kw)) return false;
  }

  // If family matches wine families, include
  for (const wf of wineFamilies) {
    if (f.includes(wf.toLowerCase())) return true;
  }

  // If no family info, default to candidate (user can filter later)
  if (!f) return true;

  return false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { action, connectionId, businessDay, daysBack } = await req.json();

    const { data: connection, error: connError } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("id", connectionId)
      .single();

    if (connError || !connection) {
      return new Response(
        JSON.stringify({ error: "Connection not found", details: connError?.message }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { base_url, api_token } = connection;
    const baseUrlClean = base_url.replace(/\/+$/, "");
    const headers = { "Api-Token": api_token, Accept: "application/json" };

    // ── TEST ──
    if (action === "test") {
      const today = new Date().toISOString().split("T")[0];
      const url = `${baseUrlClean}/api/export/?business-day=${today}&filter=Invoices`;
      let res = await fetch(url, { headers });
      if (!res.ok) {
        res = await fetch(`${baseUrlClean}/api/export/tickets/`, { headers });
      }
      if (!res.ok) {
        return new Response(
          JSON.stringify({ success: false, status: res.status, message: `Agora responded ${res.status}` }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── FIND LAST BUSINESS DAY WITH SALES ──
    if (action === "find-last-business-day") {
      const scanDays = daysBack || 30;
      const daysWithSales: string[] = [];

      for (let i = 0; i < scanDays; i++) {
        const day = new Date(Date.now() - i * 86400000).toISOString().split("T")[0];
        try {
          const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
          const res = await fetch(url, { headers });
          if (res.ok) {
            const body = await res.text();
            const trimmed = body.trim();
            if (trimmed && trimmed !== "{}" && trimmed !== "[]") {
              const parsed = JSON.parse(trimmed);
              const invoices = parseInvoices(parsed);
              if (invoices.length > 0) {
                daysWithSales.push(day);
                // For speed, stop after finding 10 days with sales
                if (daysWithSales.length >= 10) break;
              }
            }
          }
        } catch (_) { /* skip */ }
      }

      return new Response(
        JSON.stringify({ daysWithSales }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── FETCH & PARSE SALES FOR A BUSINESS DAY ──
    if (action === "fetch-day") {
      const day = businessDay;
      if (!day) {
        return new Response(
          JSON.stringify({ error: "businessDay is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return new Response(
          JSON.stringify({ error: `Agora responded ${res.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const rawData = await res.json();
      const invoices = parseInvoices(rawData);

      // Load wine family rules for this connection
      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);

      const customWineFamilies = familyRules
        ?.filter((r: { is_wine: boolean }) => r.is_wine)
        .map((r: { family_name: string }) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      // Collect all unique families for auto-detection
      const allFamilies = new Set<string>();

      const salesEvents = invoices.map((inv) => {
        const docId = String(inv.InvoiceId || inv.Id || "");
        const items = inv.InvoiceItems || [];
        const lines: {
          provider_product_id: string;
          name: string;
          format: string;
          family: string;
          quantity: number;
          unit_price: number;
          total_amount: number;
          vat_rate: number;
          is_wine_candidate: boolean;
        }[] = [];

        let docTotal = 0;

        for (const item of items) {
          for (const line of (item.Lines || [])) {
            const family = String(line.FamilyName || "");
            if (family) allFamilies.add(family);

            const lineTotal = Number(line.TotalAmount || 0);
            docTotal += lineTotal;

            lines.push({
              provider_product_id: String(line.ProductId || ""),
              name: String(line.ProductName || ""),
              format: String(line.SaleFormatName || ""),
              family,
              quantity: Number(line.Quantity || 0),
              unit_price: Number(line.UnitPrice || 0),
              total_amount: lineTotal,
              vat_rate: Number(line.VatRate || 0),
              is_wine_candidate: isWineCandidate(family, String(line.ProductName || ""), wineFamilies),
            });
          }
        }

        return {
          provider_doc_id: docId,
          business_day: day,
          doc_type: String(inv.Type || "BasicInvoice"),
          total_amount: Number(inv.TotalAmount || docTotal),
          total_tax: Number(inv.TotalTaxAmount || 0),
          total_net: Number(inv.TotalNetAmount || 0),
          line_count: lines.length,
          lines,
        };
      });

      // Detect wine-like families
      const detectedFamilies = Array.from(allFamilies).map((f) => ({
        name: f,
        suggestedWine: DEFAULT_WINE_FAMILIES.some((wf) => f.toLowerCase().includes(wf)),
      }));

      return new Response(
        JSON.stringify({
          businessDay: day,
          invoiceCount: invoices.length,
          salesEvents,
          detectedFamilies,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── SAVE SALES TO DB ──
    if (action === "save-sales") {
      const day = businessDay;
      if (!day) {
        return new Response(
          JSON.stringify({ error: "businessDay required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // First fetch the parsed data
      const fetchRes = await fetch(req.url, {
        method: "POST",
        headers: { ...Object.fromEntries(req.headers.entries()) },
        body: JSON.stringify({ action: "fetch-day", connectionId, businessDay: day }),
      });

      // Instead of self-calling, inline the fetch
      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return new Response(
          JSON.stringify({ error: `Agora responded ${res.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const rawData = await res.json();
      const invoices = parseInvoices(rawData);

      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);

      const customWineFamilies = familyRules
        ?.filter((r: { is_wine: boolean }) => r.is_wine)
        .map((r: { family_name: string }) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      let savedEvents = 0;
      let savedLines = 0;

      for (const inv of invoices) {
        const docId = String(inv.InvoiceId || inv.Id || "");
        const items = inv.InvoiceItems || [];
        let docTotal = 0;
        const lineData: Record<string, unknown>[] = [];

        for (const item of items) {
          for (const line of (item.Lines || [])) {
            const lineTotal = Number(line.TotalAmount || 0);
            docTotal += lineTotal;
            lineData.push({
              provider_product_id: String(line.ProductId || ""),
              name: String(line.ProductName || ""),
              format: String(line.SaleFormatName || ""),
              family: String(line.FamilyName || ""),
              quantity: Number(line.Quantity || 0),
              unit_price: Number(line.UnitPrice || 0),
              total_amount: lineTotal,
              vat_rate: Number(line.VatRate || 0),
              is_wine_candidate: isWineCandidate(
                String(line.FamilyName || ""),
                String(line.ProductName || ""),
                wineFamilies
              ),
            });
          }
        }

        // Upsert event
        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId,
            provider_doc_id: docId,
            business_day: day,
            doc_type: String(inv.Type || "BasicInvoice"),
            total_amount: Number(inv.TotalAmount || docTotal),
            total_tax: Number(inv.TotalTaxAmount || 0),
            total_net: Number(inv.TotalNetAmount || 0),
            line_count: lineData.length,
            raw_json: inv,
          }, { onConflict: "connection_id,provider_doc_id" })
          .select("id")
          .single();

        if (eventErr || !eventRow) continue;
        savedEvents++;

        // Delete old lines for this event then insert new
        await supabase.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);

        const linesToInsert = lineData.map((l) => ({
          ...l,
          sales_event_id: eventRow.id,
          connection_id: connectionId,
        }));

        if (linesToInsert.length > 0) {
          const { error: lineErr } = await supabase.from("sales_line_items").insert(linesToInsert);
          if (!lineErr) savedLines += linesToInsert.length;
        }
      }

      // Update cursor
      await supabase
        .from("pos_connections")
        .update({ last_business_day_synced: day, last_sync_at: new Date().toISOString() })
        .eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, savedEvents, savedLines, businessDay: day }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── DIAGNOSE (legacy) ──
    if (action === "diagnose" || action === "export") {
      const day = businessDay || new Date().toISOString().split("T")[0];
      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetch(url, { headers });
      const data = await res.json();
      return new Response(
        JSON.stringify({ data, status: res.status }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
