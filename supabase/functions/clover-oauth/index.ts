import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Clover OAuth endpoints per region
const CLOVER_AUTH_URLS: Record<string, string> = {
  "https://api.clover.com": "https://sandbox.dev.clover.com", // NA prod uses www.clover.com
  "https://api.eu.clover.com": "https://eu.clover.com",
  "https://api.la.clover.com": "https://la.clover.com",
};

// For sandbox/dev
const CLOVER_SANDBOX_AUTH = "https://sandbox.dev.clover.com";

function getCloverAuthBase(apiBase: string): string {
  // Map API base URL to auth base URL
  if (apiBase.includes("eu.clover.com")) return "https://eu.clover.com";
  if (apiBase.includes("la.clover.com")) return "https://la.clover.com";
  if (apiBase.includes("sandbox")) return CLOVER_SANDBOX_AUTH;
  return "https://www.clover.com"; // NA production
}

function generateState(connectionId: string, nonce: string): string {
  const payload = JSON.stringify({
    connectionId,
    nonce,
    ts: Date.now(),
  });
  // Base64url encode
  return btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parseState(state: string): { connectionId: string; nonce: string; ts: number } | null {
  try {
    const padded = state.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    return JSON.parse(json);
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
    // Support both GET (redirects from Clover) and POST (from frontend)
    const url = new URL(req.url);
    let action = url.searchParams.get("action") || "";

    // If POST, read from body
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

        // Get connection to determine region
        const { data: conn } = await supabase
          .from("pos_connections")
          .select("base_url")
          .eq("id", connectionId)
          .single();

        const apiBase = region || conn?.base_url?.match(/^(https:\/\/api[^/]*clover\.com)/)?.[1] || "https://api.clover.com";
        const authBase = getCloverAuthBase(apiBase);

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
              oauth_state_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min
              status: "PENDING",
              scopes: ["ORDERS_R", "INVENTORY_R", "MERCHANT_R", "PAYMENTS_R", "ITEMS_R"],
            },
            { onConflict: "connection_id" }
          );

        // Build Clover authorize URL
        // Redirect URI = this edge function's callback endpoint
        const redirectUri = `${supabaseUrl}/functions/v1/clover-oauth?action=callback`;
        const scopes = "ORDERS_R,INVENTORY_R,MERCHANT_R,PAYMENTS_R,ITEMS_R";

        const authorizeUrl =
          `${authBase}/oauth/authorize?client_id=${cloverAppId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&response_type=code`;

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

        // Note: Clover access tokens don't expire and don't have refresh tokens in most setups
        // But we implement the flow for future-proofing
        return new Response(
          JSON.stringify({ success: true, message: "Clover tokens do not expire; no refresh needed" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // ── STATUS: Check OAuth status ──
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
      const merchantId = url.searchParams.get("merchant_id"); // Clover includes this

      if (!code || !state) {
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>Missing code or state parameter.</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      // Validate state (CSRF)
      const parsed = parseState(state);
      if (!parsed) {
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>Invalid state parameter.</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      // Check state exists in DB and hasn't expired
      const { data: cred } = await supabase
        .from("provider_credentials")
        .select("*")
        .eq("connection_id", parsed.connectionId)
        .eq("oauth_state", state)
        .single();

      if (!cred) {
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>State not found or expired. Please try connecting again.</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      if (cred.oauth_state_expires_at && new Date(cred.oauth_state_expires_at) < new Date()) {
        return new Response(
          `<html><body><h2>OAuth Error</h2><p>OAuth state expired. Please try connecting again.</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      // Get connection to determine region for token exchange
      const { data: conn } = await supabase
        .from("pos_connections")
        .select("base_url")
        .eq("id", parsed.connectionId)
        .single();

      const apiBase = conn?.base_url?.match(/^(https:\/\/api[^/]*clover\.com)/)?.[1] || "https://api.clover.com";
      const authBase = getCloverAuthBase(apiBase);

      // Exchange code for access token
      const tokenUrl = `${authBase}/oauth/token?client_id=${cloverAppId}&client_secret=${cloverAppSecret}&code=${code}`;
      const tokenRes = await fetch(tokenUrl);

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

      // Get merchant info
      const resolvedMerchantId = merchantId || tokenData.merchant_id || "unknown";
      let merchantName = "";

      try {
        // Construct merchant API URL
        const merchantApiUrl = `${apiBase}/v3/merchants/${resolvedMerchantId}`;
        const merchantRes = await fetch(merchantApiUrl, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        });
        if (merchantRes.ok) {
          const merchantData = await merchantRes.json();
          merchantName = merchantData.name || "";
        }
      } catch (e) {
        console.error("Failed to fetch merchant info:", e);
      }

      // Store credentials (access_token stored as-is; in production use app-level encryption)
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

      // Update pos_connections with the correct base_url including merchant path and api_token
      const fullBaseUrl = `${apiBase}/v3/merchants/${resolvedMerchantId}`;
      await supabase
        .from("pos_connections")
        .update({
          base_url: fullBaseUrl,
          api_token: accessToken,
          location_name: merchantName || conn?.base_url || "Clover Merchant",
          enabled: false,
        })
        .eq("id", parsed.connectionId);

      // Redirect user back to the wizard
      // Use a generic redirect that works with any published URL
      const appRedirect = `${supabaseUrl.replace('.supabase.co', '')}/integrations/clover?connection=${parsed.connectionId}&oauth=success`;

      // Redirect to the app's published URL
      // We'll use a self-closing HTML page that posts a message and redirects
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
      // Notify opener window
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

      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("clover-oauth error:", e);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
