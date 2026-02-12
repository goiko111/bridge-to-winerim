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

    const { action, connectionId } = await req.json();

    // Get the connection config from the database
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

    const headers = { "Api-Token": api_token, "Accept": "application/json" };

    // Route actions
    if (action === "test") {
      // Primary: business-day export endpoint
      const today = new Date().toISOString().split("T")[0];
      const primaryUrl = `${base_url.replace(/\/+$/, "")}/api/export/?business-day=${today}&filter=Invoices`;

      let res = await fetch(primaryUrl, { headers });

      // Fallback: tickets endpoint
      if (!res.ok) {
        const fallbackUrl = `${base_url.replace(/\/+$/, "")}/api/export/tickets/`;
        res = await fetch(fallbackUrl, { headers });
      }

      if (!res.ok) {
        const text = await res.text();
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

    if (action === "export") {
      const { businessDay, filter } = await req.json().catch(() => ({}));
      const day = businessDay || new Date().toISOString().split("T")[0];
      const url = `${base_url.replace(/\/+$/, "")}/api/export/?business-day=${day}&filter=${filter || "Invoices"}`;

      const res = await fetch(url, { headers });
      if (!res.ok) {
        return new Response(
          JSON.stringify({ error: "Failed to fetch export", status: res.status }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const data = await res.json();
      return new Response(
        JSON.stringify({ data }),
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
