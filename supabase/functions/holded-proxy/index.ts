import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHoldedClient, HoldedHttpError } from "../_shared/holded/client.ts";
import { getHoldedConfig } from "../_shared/providerConfig.ts";
import {
  applyCircuitBreaker,
  classifyPosError,
  createResilientFetch,
  isConnectionPaused,
  resetFailureCounter,
} from "../_shared/resilience.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function listParams(payload: Record<string, unknown>) {
  return {
    cursor: typeof payload.cursor === "string" ? payload.cursor : undefined,
    limit: typeof payload.limit === "number" ? payload.limit : undefined,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  let connectionId = "";

  try {
    const payload = await req.json() as Record<string, unknown>;
    connectionId = typeof payload.connectionId === "string" ? payload.connectionId : "";
    const action = typeof payload.action === "string" ? payload.action : "";
    if (!connectionId || !action) return json({ success: false, error: "connectionId and action are required" }, 400);

    const breaker = await isConnectionPaused(supabase, connectionId);
    if (breaker.paused) {
      return json({ success: false, code: "CIRCUIT_BREAKER_OPEN", until: breaker.until, reason: breaker.reason }, 503);
    }

    const { data: connection, error } = await supabase
      .from("pos_connections")
      .select("id, provider, base_url, api_token, provider_config")
      .eq("id", connectionId)
      .single();
    if (error || !connection) return json({ success: false, error: "Connection not found" }, 404);
    if (String(connection.provider).toUpperCase() !== "HOLDED") {
      return json({ success: false, error: "Connection provider must be HOLDED" }, 409);
    }
    if (!connection.api_token) return json({ success: false, error: "Holded API token is required" }, 422);

    const config = getHoldedConfig(connection.provider_config);
    const client = createHoldedClient({
      baseUrl: connection.base_url || "https://api.holded.com/api/v2",
      apiToken: connection.api_token,
      timeoutMs: config.timeout_ms,
      fetchImpl: createResilientFetch(connectionId),
    });

    let data: unknown;
    switch (action) {
      case "test":
      case "list-products":
        data = await client.listProducts({ ...listParams(payload), limit: listParams(payload).limit ?? 1 });
        break;
      case "list-invoices":
        data = await client.listInvoices(listParams(payload));
        break;
      case "list-contacts":
        data = await client.listContacts(listParams(payload));
        break;
      case "list-warehouses":
        data = await client.listWarehouses(listParams(payload));
        break;
      default:
        return json({ success: false, error: `Unknown read-only action: ${action}` }, 400);
    }

    await resetFailureCounter(supabase, connectionId);
    return json({ success: true, readOnly: true, action, data });
  } catch (error) {
    const status = error instanceof HoldedHttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (connectionId) {
      await applyCircuitBreaker(supabase, connectionId, classifyPosError(message, status));
    }
    return json({ success: false, error: message }, status >= 400 && status < 600 ? status : 500);
  }
});
