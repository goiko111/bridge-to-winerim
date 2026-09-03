import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createTspoonlabClient, TspoonlabHttpError } from "../_shared/tspoonlab/client.ts";
import { getTspoonlabConfig } from "../_shared/providerConfig.ts";
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

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  let connectionId = "";

  try {
    const payload = await req.json();
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
    if (String(connection.provider).toUpperCase() !== "TSPOONLAB") {
      return json({ success: false, error: "Connection provider must be TSPOONLAB" }, 409);
    }

    const config = getTspoonlabConfig(connection.provider_config);
    if (!config.username || !connection.api_token) {
      return json({ success: false, error: "tSpoonLab username and password are required" }, 422);
    }

    const client = createTspoonlabClient({
      baseUrl: connection.base_url || "https://app.tspoonlab.com/recipes/api",
      username: config.username,
      password: connection.api_token,
      orderCenterId: config.order_center_id,
      recipeCenterId: config.recipe_center_id,
      timeoutMs: config.timeout_ms,
      fetchImpl: createResilientFetch(connectionId),
    });

    let data: unknown;
    switch (action) {
      case "test":
      case "list-order-centers":
        data = await client.listOrderCenters();
        break;
      case "list-menus":
        data = await client.listMenus({ start: payload.start, rows: payload.rows, filter: payload.filter });
        break;
      case "get-menu":
        if (!payload.id) return json({ success: false, error: "id is required" }, 400);
        data = await client.getMenu(String(payload.id));
        break;
      case "list-recipes":
        data = await client.listRecipes({
          start: payload.start,
          rows: payload.rows,
          filter: payload.filter,
          withTypes: payload.withTypes,
          withDetail: payload.withDetail,
          hidden: payload.hidden,
        });
        break;
      case "get-recipe":
        if (!payload.id) return json({ success: false, error: "id is required" }, 400);
        data = await client.getRecipe(String(payload.id));
        break;
      case "list-dishes":
        data = await client.listDishes({
          start: payload.start,
          rows: payload.rows,
          filter: payload.filter,
          withTypes: payload.withTypes,
          withDetail: payload.withDetail,
          hidden: payload.hidden,
        });
        break;
      case "get-dish":
        if (!payload.id) return json({ success: false, error: "id is required" }, 400);
        data = await client.getDish(String(payload.id));
        break;
      case "list-sales-deliveries":
      case "list-pending-sales-deliveries": {
        if (!isIsoDate(payload.startDate) || !isIsoDate(payload.endDate)) {
          return json({ success: false, error: "startDate and endDate must use YYYY-MM-DD" }, 400);
        }
        data = action === "list-sales-deliveries"
          ? await client.listSalesDeliveries(payload.startDate, payload.endDate, payload.includeInternal !== false)
          : await client.listPendingSalesDeliveries(payload.startDate, payload.endDate, payload.includeInternal !== false);
        break;
      }
      default:
        return json({ success: false, error: `Unknown read-only action: ${action}` }, 400);
    }

    await resetFailureCounter(supabase, connectionId);
    return json({ success: true, readOnly: true, action, data });
  } catch (error) {
    const status = error instanceof TspoonlabHttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (connectionId) {
      await applyCircuitBreaker(supabase, connectionId, classifyPosError(message, status));
    }
    return json({ success: false, error: message }, status >= 400 && status < 600 ? status : 500);
  }
});
