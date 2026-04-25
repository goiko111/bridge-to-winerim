import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Region URL maps ──
// Browser-facing authorize URLs (www subdomain)
function getAuthorizeBase(region: string): string {
  if (region.includes("eu")) return "https://www.eu.clover.com";
  if (region.includes("la")) return "https://www.la.clover.com";
  if (region.includes("sandbox")) return "https://sandbox.dev.clover.com";
  return "https://www.clover.com"; // NA production
}

// Server-side API base for token exchange + REST calls
function getApiBase(region: string): string {
  if (region.includes("eu")) return "https://api.eu.clover.com";
  if (region.includes("la")) return "https://api.la.clover.com";
  if (region.includes("sandbox")) return "https://apisandbox.dev.clover.com";
  return "https://api.clover.com"; // NA production
}

function generateState(connectionId: string, nonce: string): string {
  const payload = JSON.stringify({ connectionId, nonce, ts: Date.now() });
  return btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parseState(state: string): { connectionId: string; nonce: string; ts: number } | null {
  try {
    const padded = state.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const cloverAppId = Deno.env.get("CLOVER_APP_ID")!;
  const cloverAppSecret = Deno.env.get("CLOVER_APP_SECRET")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const url = new URL(req.url);
    let action = url.searchParams.get("action") || "";

    if (req.method === "POST") {
      const body = await req.json();
      action = body.action || action;

      // ── START: Generate OAuth URL ──
      if (action === "start") {
        const { connectionId, region } = body;
        if (!connectionId) {
          return new Response(
            JSON.stringify({ error: "connectionId required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Resolve region key from connection or param
        const { data: conn } = await supabase
          .from("pos_connections")
          .select("base_url")
          .eq("id", connectionId)
          .single();

        const regionKey = region || conn?.base_url || "https://api.clover.com";
        const authorizeBase = getAuthorizeBase(regionKey);

        const nonce = crypto.randomUUID();
        const state = generateState(connectionId, nonce);

        // Store state for CSRF validation
        await supabase
          .from("provider_credentials")
          .upsert(
            {
              connection_id: connectionId,
              merchant_id: "PENDING",
              access_token_enc: "",
              oauth_state: state,
              oauth_state_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
              status: "PENDING",
              scopes: ["ORDERS_R", "INVENTORY_R", "MERCHANT_R", "PAYMENTS_R", "ITEMS_R"],
            },
            { onConflict: "connection_id" }
          );

        // Redirect URI = this edge function's callback endpoint
        const redirectUri = `${supabaseUrl}/functions/v1/clover-oauth?action=callback`;

        // Clover OAuth v2 authorize URL (browser-facing, www domain)
        const authorizeUrl =
          `${authorizeBase}/oauth/v2/authorize?client_id=${cloverAppId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&response_type=code`;

        return new Response(
          JSON.stringify({ authorizeUrl, state }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // ── REFRESH TOKEN ──
      if (action === "refresh") {
        const { connectionId } = body;
        if (!connectionId) {
          return new Response(
            JSON.stringify({ error: "connectionId required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { data: cred } = await supabase
          .from("provider_credentials")
          .select("*")
          .eq("connection_id", connectionId)
          .single();

        if (!cred || !cred.refresh_token_enc) {
          return new Response(
            JSON.stringify({ error: "No refresh token available" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Get region from connection
        const { data: conn } = await supabase
          .from("pos_connections")
          .select("base_url")
          .eq("id", connectionId)
          .single();

        const apiBase = getApiBase(conn?.base_url || "");
        const refreshUrl = `${apiBase}/oauth/v2/refresh`;

        const refreshRes = await fetch(refreshUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: cloverAppId,
            client_secret: cloverAppSecret,
            refresh_token: cred.refresh_token_enc,
          }),
        });

        if (!refreshRes.ok) {
          const errText = await refreshRes.text();
          console.error("Refresh failed:", refreshRes.status, errText);
          return new Response(
            JSON.stringify({ error: `Refresh failed: ${refreshRes.status}` }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const refreshData = await refreshRes.json();
        if (refreshData.access_token) {
          await supabase
            .from("provider_credentials")
            .update({
              access_token_enc: refreshData.access_token,
              refresh_token_enc: refreshData.refresh_token || cred.refresh_token_enc,
              expires_at: refreshData.expires_in
                ? new Date(Date.now() + refreshData.expires_in * 1000).toISOString()
                : null,
            })
            .eq("connection_id", connectionId);

          // Also update pos_connections api_token
          await supabase
            .from("pos_connections")
            .update({ api_token: refreshData.access_token })
            .eq("id", connectionId);
        }

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // ── STATUS ──
      if (action === "status") {
        const { connectionId } = body;
        const { data: cred } = await supabase
          .from("provider_credentials")
          .select("merchant_id, status, scopes, expires_at, created_at, updated_at")
          .eq("connection_id", connectionId)
          .single();

        return new Response(
          JSON.stringify({ credential: cred || null }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── CALLBACK: Handle GET redirect from Clover ──
    if (req.method === "GET" && (action === "callback" || url.searchParams.has("code"))) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const merchantId = url.searchParams.get("merchant_id");

      if (!code || !state) {
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>Missing code or state parameter.</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      const parsed = parseState(state);
      if (!parsed) {
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>Invalid state parameter.</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      const { data: cred } = await supabase
        .from("provider_credentials")
        .select("*")
        .eq("connection_id", parsed.connectionId)
        .eq("oauth_state", state)
        .single();

      if (!cred) {
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>State not found or expired.</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      if (cred.oauth_state_expires_at && new Date(cred.oauth_state_expires_at) < new Date()) {
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>OAuth state expired.</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      // Get region from connection's base_url
      const { data: conn } = await supabase
        .from("pos_connections")
        .select("base_url")
        .eq("id", parsed.connectionId)
        .single();

      const regionKey = conn?.base_url || "https://api.clover.com";
      const apiBase = getApiBase(regionKey);

      // Exchange code for access token via API domain (NOT www)
      const tokenUrl = `${apiBase}/oauth/v2/token`;
      const tokenRes = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cloverAppId,
          client_secret: cloverAppSecret,
          code,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error("Token exchange failed:", tokenRes.status, errText);
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>Token exchange failed: ${tokenRes.status}</p></body></html>`,
          { status: 502, headers: { "Content-Type": "text/html" } }
        );
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;

      if (!accessToken) {
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>No access token received.</p></body></html>`,
          { status: 502, headers: { "Content-Type": "text/html" } }
        );
      }

      // Resolve merchant_id
      const resolvedMerchantId = merchantId || tokenData.merchant_id || "";
      if (!resolvedMerchantId) {
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>No merchant_id received. Cannot proceed.</p></body></html>`,
          { status: 502, headers: { "Content-Type": "text/html" } }
        );
      }

      // Fetch merchant name using /v3/merchants/{merchantId}
      let merchantName = "";
      try {
        const merchantRes = await fetch(`${apiBase}/v3/merchants/${resolvedMerchantId}`, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        });
        if (merchantRes.ok) {
          const merchantData = await merchantRes.json();
          merchantName = merchantData.name || "";
        }
      } catch (e) {
        console.error("Failed to fetch merchant info:", e);
      }

      // Store credentials
      await supabase
        .from("provider_credentials")
        .update({
          merchant_id: resolvedMerchantId,
          access_token_enc: accessToken,
          refresh_token_enc: tokenData.refresh_token || null,
          expires_at: tokenData.expires_in
            ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
            : null,
          scopes: cred.scopes || ["ORDERS_R", "INVENTORY_R", "MERCHANT_R", "PAYMENTS_R", "ITEMS_R"],
          status: "CONNECTED",
          oauth_state: null,
          oauth_state_expires_at: null,
        })
        .eq("connection_id", parsed.connectionId);

      // Update pos_connections: store REGION as base_url (not full path), api_token, merchant name
      await supabase
        .from("pos_connections")
        .update({
          base_url: regionKey, // Store region only, NOT /v3/merchants/...
          api_token: accessToken,
          location_name: merchantName || `Clover ${resolvedMerchantId}`,
          enabled: false,
        })
        .eq("id", parsed.connectionId);

      // Success page with postMessage
      const html = `<!DOCTYPE html>
<html>
<head><title>Clover Connected</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb;">
  <div style="text-align:center;max-width:400px;">
    <div style="font-size:48px;margin-bottom:16px;">✅</div>
    <h2 style="margin:0 0 8px;">Clover Connected!</h2>
    <p style="color:#6b7280;margin:0 0 16px;">Merchant: <strong>${merchantName || resolvedMerchantId}</strong></p>
    <p style="color:#9ca3af;font-size:14px;">You can close this window and return to the setup wizard.</p>
    <script>
      if (window.opener) {
        window.opener.postMessage({
          type: 'CLOVER_OAUTH_SUCCESS',
          connectionId: '${parsed.connectionId}',
          merchantId: '${resolvedMerchantId}',
          merchantName: '${merchantName.replace(/'/g, "\\'")}',
        }, '*');
        setTimeout(() => window.close(), 2000);
      }
    </script>
  </div>
</body>
</html>`;

      return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("clover-oauth error:", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
