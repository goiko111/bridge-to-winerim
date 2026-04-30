// Cron dispatcher for Agora connections
// Iterates all enabled Agora connections and invokes the appropriate proxy actions
// Triggered by pg_cron via HTTP every 5 min (catalog, sales/stock, outbound queue)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface DispatchBody {
  job: "catalog" | "sales-stock" | "outbound-queue" | "restore-stock";
  connectionId?: string; // optional: limit to one connection (testing)
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as DispatchBody;
    const job = body.job;
    if (job !== "catalog" && job !== "sales-stock" && job !== "outbound-queue" && job !== "restore-stock") {
      return new Response(JSON.stringify({ error: "job must be 'catalog', 'sales-stock', 'outbound-queue' or 'restore-stock'" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // Load enabled Agora connections
    let query = supabase
      .from("pos_connections")
      .select("id, location_name")
      .eq("provider", "agora")
      .eq("enabled", true);
    if (body.connectionId) query = query.eq("id", body.connectionId);

    const { data: connections, error: connErr } = await query;
    if (connErr) throw connErr;
    if (!connections || connections.length === 0) {
      return new Response(JSON.stringify({ ok: true, dispatched: 0, job }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    type DispatchRequest = {
      connection_id: string;
      name: string;
      functionName: "winerim-proxy" | "agora-proxy";
      body: Record<string, unknown>;
    };

    // Map job → one or more target function calls.
    // Catalog sync must refresh BOTH sides: Winerim wines and Agora master data.
    const buildRequests = (connection: { id: string; location_name: string }): DispatchRequest[] => {
      if (job === "catalog") {
        return [
          { connection_id: connection.id, name: connection.location_name, functionName: "winerim-proxy", body: { action: "fetch-catalog", connectionId: connection.id } },
          { connection_id: connection.id, name: connection.location_name, functionName: "agora-proxy", body: { action: "sync-master-data", connectionId: connection.id } },
        ];
      }
      if (job === "outbound-queue") {
        return [{ connection_id: connection.id, name: connection.location_name, functionName: "agora-proxy", body: { action: "process-xml-outbound-queue", connectionId: connection.id, serverLoop: true } }];
      }
      if (job === "restore-stock") {
        return [{ connection_id: connection.id, name: connection.location_name, functionName: "agora-proxy", body: { action: "restore-glass-overdiscount", connectionId: connection.id, apply: true } }];
      }
      return [{ connection_id: connection.id, name: connection.location_name, functionName: "agora-proxy", body: { action: "auto-sync-sales", connectionId: connection.id } }];
    };

    const dispatchRequests = connections.flatMap((c) => buildRequests(c));

    // Fire-and-forget invocations (parallel) so the cron returns quickly
    const results = await Promise.allSettled(
      dispatchRequests.map(async (dispatch) => {
        const url = `${SUPABASE_URL}/functions/v1/${dispatch.functionName}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify(dispatch.body),
        });
        const text = await resp.text();
        return {
          connection_id: dispatch.connection_id,
          name: dispatch.name,
          function: dispatch.functionName,
          action: dispatch.body.action,
          status: resp.status,
          ok: resp.ok,
          preview: text.slice(0, 200),
        };
      })
    );

    const summary = results.map((r) =>
      r.status === "fulfilled" ? r.value : { error: String(r.reason) }
    );
    const okCount = results.filter((r) => r.status === "fulfilled" && (r.value as { ok: boolean }).ok).length;

    return new Response(
      JSON.stringify({
        ok: true,
        job,
        connections: connections.length,
        dispatched: dispatchRequests.length,
        succeeded: okCount,
        results: summary,
        timestamp: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
