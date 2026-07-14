import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getYurestConfig } from "../_shared/providerConfig.ts";
import { createYurestClient, YurestHttpError } from "../_shared/yurest/client.ts";
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

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function listParams(payload: Record<string, unknown>) {
  return {
    page: positiveInteger(payload.page),
    per_page: positiveInteger(payload.perPage),
  };
}

function readSecret(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing Yurest secret: ${name}`);
  return value;
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
      .select("id, provider, base_url, provider_config")
      .eq("id", connectionId)
      .single();
    if (error || !connection) return json({ success: false, error: "Connection not found" }, 404);
    if (String(connection.provider).toUpperCase() !== "YUREST") {
      return json({ success: false, error: "Connection provider must be YUREST" }, 409);
    }

    const config = getYurestConfig(connection.provider_config);
    if (!config.store_id) return json({ success: false, error: "Yurest store_id is required" }, 422);

    const client = createYurestClient({
      baseUrl: connection.base_url || "https://cliente.yurest.com/ws",
      email: readSecret(config.email_secret_name),
      password: readSecret(config.password_secret_name),
      providerToken: readSecret(config.provider_token_secret_name),
      storeId: config.store_id,
      timeoutMs: config.timeout_ms,
      fetchImpl: createResilientFetch(connectionId),
    });

    let data: unknown;
    switch (action) {
      case "test":
      case "list-warehouse-locations":
        data = await client.listWarehouseLocations({ ...listParams(payload), per_page: listParams(payload).per_page ?? 200 });
        break;
      case "list-store-product-costs":
        data = await client.listAllProductCostsForStore(positiveInteger(payload.maxPages) ?? 50);
        break;
      case "list-products":
        if (!config.allow_customer_scope_reads) {
          return json({ success: false, error: "Customer-wide Yurest reads are disabled for this connection" }, 403);
        }
        data = await client.listProducts({ ...listParams(payload), active: payload.active === false ? false : true });
        break;
      case "list-stock": {
        const locationId = positiveInteger(payload.locationId) ?? config.warehouse_location_id;
        if (!locationId) return json({ success: false, error: "locationId is required" }, 400);
        data = await client.listStock(locationId, listParams(payload));
        break;
      }
      case "list-stock-movements":
        data = await client.listStockMovements({
          ...listParams(payload),
          date_from: typeof payload.dateFrom === "string" ? payload.dateFrom : undefined,
          date_to: typeof payload.dateTo === "string" ? payload.dateTo : undefined,
          location_id: positiveInteger(payload.locationId) ?? config.warehouse_location_id,
        });
        break;
      case "list-inventories":
        data = await client.listInventories(listParams(payload));
        break;
      case "get-inventory": {
        const id = positiveInteger(payload.id);
        if (!id) return json({ success: false, error: "id is required" }, 400);
        data = await client.getInventory(id);
        break;
      }
      case "list-providers":
        if (!config.allow_customer_scope_reads) {
          return json({ success: false, error: "Customer-wide Yurest reads are disabled for this connection" }, 403);
        }
        data = await client.listProviders(listParams(payload));
        break;
      case "list-provider-products":
        if (!config.allow_customer_scope_reads) {
          return json({ success: false, error: "Customer-wide Yurest reads are disabled for this connection" }, 403);
        }
        data = await client.listProviderProducts({
          ...listParams(payload),
          provider_id: positiveInteger(payload.providerId),
        });
        break;
      default:
        return json({ success: false, error: `Unknown read-only action: ${action}` }, 400);
    }

    await resetFailureCounter(supabase, connectionId);
    return json({ success: true, readOnly: true, storeId: config.store_id, action, data });
  } catch (error) {
    const status = error instanceof YurestHttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (connectionId) {
      await applyCircuitBreaker(supabase, connectionId, classifyPosError(message, status));
    }
    return json(
      {
        success: false,
        error: message,
        providerMessage: error instanceof YurestHttpError ? error.responseMessage : undefined,
      },
      status >= 400 && status < 600 ? status : 500,
    );
  }
});
