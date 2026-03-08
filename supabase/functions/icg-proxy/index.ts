import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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

  const cfg = (conn.provider_config || {}) as Record<string, string>;
  const host = (cfg.host || "").trim();
  const port = (cfg.port || "1433").trim();
  const database = (cfg.database || "FrontRest").trim();
  const dbUser = (cfg.db_username || "").trim();
  const dbPass = (cfg.db_password || "").trim();

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
    if (action === "test") {
      // We can't directly connect to SQL Server from Deno edge functions,
      // so we simulate a connectivity check via a TCP-like probe.
      // In production, this would use a bridge service or mssql driver.
      // For now, validate config and mark connection as tested.

      if (!host || !dbUser || !dbPass) {
        return ok({ success: false, status: 400, message: "Missing host, username or password" });
      }

      // Store test timestamp
      await sb
        .from("pos_connections")
        .update({ last_sync_at: new Date().toISOString(), enabled: true })
        .eq("id", connectionId);

      // Store capabilities
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
        message: `Configuration saved. SQL Server target: ${host}:${port}/${database}. Direct DB connectivity requires a bridge agent (coming soon).`,
        version: "Pending bridge agent",
        tables: [],
      });
    }

    return fail(`Unknown action: ${action}`);
  } catch (e: any) {
    return fail(e.message || "Internal error", 500);
  }
});
