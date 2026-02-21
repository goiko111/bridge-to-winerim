import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // ── A) Clover webhook verification handshake (GET with verificationCode) ──
    const url = new URL(req.url);
    const verificationCode = url.searchParams.get("verificationCode");
    if (verificationCode) {
      return new Response(verificationCode, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // ── B) Validate X-Clover-Auth header ──
    // Clover sends this header with the "Auth Token" configured in app settings.
    // We store the expected value as CLOVER_APP_SECRET (or a dedicated secret).
    const cloverAuthHeader = req.headers.get("X-Clover-Auth") || "";
    const expectedAuthCode = Deno.env.get("CLOVER_APP_SECRET") || "";

    // If the auth code is configured, validate it
    if (expectedAuthCode && cloverAuthHeader !== expectedAuthCode) {
      console.warn("X-Clover-Auth mismatch. Rejecting webhook.");
      // Still return 200 to avoid Clover retries, but don't process
      return new Response(
        JSON.stringify({ success: false, error: "Invalid X-Clover-Auth" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── C) Handle POST verification (verificationCode in body) ──
    const body = await req.json();

    if (body.verificationCode) {
      return new Response(body.verificationCode, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // ── D) Process webhook events ──
    const merchants = body.merchants || {};
    let eventsProcessed = 0;

    for (const [merchantId, events] of Object.entries(merchants)) {
      if (!Array.isArray(events)) continue;

      // Find connection for this merchant
      const { data: cred } = await supabase
        .from("provider_credentials")
        .select("connection_id")
        .eq("merchant_id", merchantId)
        .eq("status", "CONNECTED")
        .single();

      if (!cred) {
        console.warn(`No connection found for merchant ${merchantId}`);
        continue;
      }

      for (const event of events as any[]) {
        const eventId = `${merchantId}_${event.objectId || ""}_${event.ts || Date.now()}`;
        const eventType = String(event.type || "UNKNOWN").toUpperCase();

        // Dedupe: try to insert, skip if already exists
        const { error: insertErr } = await supabase
          .from("webhook_events")
          .insert({
            connection_id: cred.connection_id,
            provider: "CLOVER",
            event_id: eventId,
            event_type: eventType,
            payload: event,
            status: "PENDING",
          });

        if (insertErr) {
          if (insertErr.code === "23505") {
            console.log(`Duplicate webhook event skipped: ${eventId}`);
            continue;
          }
          console.error("Failed to insert webhook event:", insertErr);
          continue;
        }

        eventsProcessed++;

        // Queue async processing for ORDER/PAYMENT events
        if (eventType.includes("ORDER") || eventType.includes("PAYMENT")) {
          console.log(`Queued ${eventType} event for connection ${cred.connection_id}: ${event.objectId}`);
        }
      }
    }

    // Must respond 200 in < 1s per Clover requirements
    return new Response(
      JSON.stringify({ success: true, eventsProcessed }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("clover-webhooks error:", e);
    // Still return 200 to avoid Clover retries
    return new Response(
      JSON.stringify({ success: false, error: e.message }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
