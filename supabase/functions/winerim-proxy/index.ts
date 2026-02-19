import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { action, connectionId, wines, productId, quantity } = await req.json();

    // Fetch connection to get winerim_api_token
    const { data: connection, error: connError } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("id", connectionId)
      .single();

    if (connError || !connection) {
      return new Response(
        JSON.stringify({ error: "Connection not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const winerimToken = (connection.winerim_api_token || "").trim();
    if (!winerimToken) {
      return new Response(
        JSON.stringify({ error: "No Winerim API token configured for this connection" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const winerimHeaders = {
      "Authorization": `Bearer ${winerimToken}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };

    // ── FETCH WINE CATALOG ──
    if (action === "fetch-catalog") {
      const res = await fetch("https://api.winerim.com/api/v2/wines", {
        headers: winerimHeaders,
      });
      if (!res.ok) {
        const body = await res.text();
        return new Response(
          JSON.stringify({ success: false, status: res.status, error: body.substring(0, 2048) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const data = await res.json();
      return new Response(
        JSON.stringify({ success: true, wines: data }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── UPDATE STOCK (single product) ──
    if (action === "update-stock") {
      if (!productId || quantity === undefined) {
        return new Response(
          JSON.stringify({ error: "productId and quantity required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const res = await fetch(`https://api.winerim.com/api/v2/stock`, {
        method: "PUT",
        headers: winerimHeaders,
        body: JSON.stringify({ product_id: productId, quantity_change: -Math.abs(quantity) }),
      });

      const responseBody = await res.text();
      let parsed;
      try { parsed = JSON.parse(responseBody); } catch { parsed = { raw: responseBody }; }

      return new Response(
        JSON.stringify({ success: res.ok, status: res.status, response: parsed }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── BULK UPDATE STOCK (multiple products) ──
    if (action === "bulk-update-stock") {
      if (!wines || !Array.isArray(wines)) {
        return new Response(
          JSON.stringify({ error: "wines array required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const results: { productId: string; success: boolean; status?: number; error?: string }[] = [];

      for (const wine of wines) {
        try {
          const res = await fetch(`https://api.winerim.com/api/v2/stock`, {
            method: "PUT",
            headers: winerimHeaders,
            body: JSON.stringify({
              product_id: wine.winerim_product_id,
              quantity_change: -Math.abs(wine.quantity),
            }),
          });
          const body = await res.text();
          results.push({
            productId: wine.winerim_product_id,
            success: res.ok,
            status: res.status,
            error: res.ok ? undefined : body.substring(0, 500),
          });
        } catch (e) {
          results.push({
            productId: wine.winerim_product_id,
            success: false,
            error: String(e),
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      return new Response(
        JSON.stringify({ success: true, total: wines.length, successCount, failedCount: wines.length - successCount, results }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("winerim-proxy error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
