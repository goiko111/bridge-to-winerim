import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const payload = await req.json();
    const { action, connectionId } = payload;

    if (!connectionId) {
      return new Response(JSON.stringify({ success: false, message: "Missing connectionId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load connection
    const { data: conn, error: connErr } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("id", connectionId)
      .single();

    if (connErr || !conn) {
      return new Response(JSON.stringify({ success: false, message: "Connection not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Extract BDP-specific config from provider_config
    const config = (conn.provider_config || {}) as Record<string, unknown>;
    const baseUrl = (conn.base_url || "").replace(/\/+$/, "");
    const port = config.port ? String(config.port) : "";
    const userKey = config.user_key ? String(config.user_key) : "";
    const password = config.password ? String(config.password) : "";
    const exportProfileCode = config.export_profile_code ? String(config.export_profile_code) : "";

    // Build the full host with port
    const host = port ? `${baseUrl}:${port}` : baseUrl;

    // ── ACTION: test ──
    if (action === "test") {
      try {
        // BDP NET Weblink Rest API: lightweight GET to check connectivity
        // Try common BDP endpoints — adjust based on actual API docs
        const testUrl = `${host}/api/v1/status`;
        
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        
        // BDP uses user_key/password for Basic or custom auth
        if (userKey && password) {
          headers["Authorization"] = `Basic ${btoa(`${userKey}:${password}`)}`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const resp = await fetch(testUrl, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const bodyText = await resp.text();
        const preview = bodyText.substring(0, 2048);

        return new Response(JSON.stringify({
          success: resp.ok,
          status: resp.status,
          statusText: resp.statusText,
          contentType: resp.headers.get("content-type") || "unknown",
          bodyPreview: preview,
          message: resp.ok ? "Connection successful" : `HTTP ${resp.status}: ${resp.statusText}`,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return new Response(JSON.stringify({
          success: false,
          status: 0,
          statusText: "Network Error",
          contentType: null,
          bodyPreview: null,
          message: msg.includes("abort") ? "Connection timed out (15s)" : msg,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── ACTION: test-custom ──
    // Allows testing any endpoint path with the configured credentials
    if (action === "test-custom") {
      const { path, method: httpMethod } = payload;
      const testUrl = `${host}${path || "/"}`;
      
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (userKey && password) {
          headers["Authorization"] = `Basic ${btoa(`${userKey}:${password}`)}`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const resp = await fetch(testUrl, {
          method: (httpMethod || "GET").toUpperCase(),
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const bodyText = await resp.text();
        const preview = bodyText.substring(0, 2048);

        return new Response(JSON.stringify({
          success: resp.ok,
          status: resp.status,
          statusText: resp.statusText,
          contentType: resp.headers.get("content-type") || "unknown",
          bodyPreview: preview,
          url: testUrl,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return new Response(JSON.stringify({
          success: false,
          status: 0,
          message: msg.includes("abort") ? "Connection timed out (15s)" : msg,
          url: testUrl,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ success: false, message: `Unknown action: ${action}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ success: false, message: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
