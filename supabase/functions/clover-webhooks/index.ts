import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  // Respond to OPTIONS quickly
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Must respond 200 in < 1s per Clover requirements
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const cloverAppSecret = Deno.env.get("CLOVER_APP_SECRET") || "";
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // Clover webhook verification: if it sends a verification challenge
    const url = new URL(req.url);
    const verificationCode = url.searchParams.get("verificationCode");
    if (verificationCode) {
      // Clover handshake: respond with the verification code
      return new Response(verificationCode, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const body = await req.json();

    // Clover sends webhooks as:
    // { "merchants": { "MERCHANT_ID": [ { "type": "UPDATE", "objectId": "ORDER_ID", "ts": 12345, "appId": "..." } ] } }
    // Or newer format:
    // { "verificationCode": "...", "merchants": {...} }

    const merchants = body.merchants || {};

    let eventsProcessed = 0;

    for (const [merchantId, events] of Object.entries(merchants)) {
      if (!Array.isArray(events)) continue;

      // Find the connection for this merchant
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

        // Dedup: try to insert, skip if already exists
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
          // Likely duplicate (unique constraint on provider+event_id)
          if (insertErr.code === "23505") {
            console.log(`Duplicate webhook event skipped: ${eventId}`);
            continue;
          }
          console.error("Failed to insert webhook event:", insertErr);
          continue;
        }

        eventsProcessed++;

        // Enqueue async processing based on event type
        // For ORDER events, trigger a sales sync
        if (eventType.includes("ORDER") || eventType.includes("PAYMENT")) {
          // We could call clover-proxy here to fetch and store the order
          // For now, just mark it for processing
          console.log(`Queued ${eventType} event for connection ${cred.connection_id}: ${event.objectId}`);
        }
      }
    }

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
