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
  job: "catalog" | "sales-stock" | "outbound-queue";
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

    // Load enabled Agora connections, EXCLUDING those paused by circuit breaker
    const nowIso = new Date().toISOString();
    let query = supabase
      .from("pos_connections")
      .select("id, location_name, base_url, api_token, circuit_breaker_paused_until")
      .eq("provider", "agora")
      .eq("enabled", true);
    if (body.connectionId) query = query.eq("id", body.connectionId);

    const { data: allConnections, error: connErr } = await query;
    if (connErr) throw connErr;

    let connections = (allConnections || []).filter((c: any) =>
      !c.circuit_breaker_paused_until || c.circuit_breaker_paused_until < nowIso
    );
    const skippedByBreaker = (allConnections?.length || 0) - connections.length;

    // ── PRE-FLIGHT (Layer 4): for jobs that hit the customer POS (outbound-queue,
    // sales-stock, restore-stock), do a 5s reachability probe per connection BEFORE
    // dispatching. If unreachable, skip this round (the breaker will eventually
    // pause it on the natural call path; we just avoid filling the queue with FAILED).
    let skippedByPreflight = 0;
    if (connections.length > 0 && (job === "outbound-queue" || job === "sales-stock" || job === "restore-stock")) {
      const checks = await Promise.all(connections.map(async (c: any) => {
        const baseUrl = (c.base_url || "").trim().replace(/\/+$/, "");
        if (!baseUrl) return { id: c.id, ok: false };
        const url = `${(baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`)}/api/`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        try {
          const r = await fetch(url, { method: "GET", headers: { "Api-Token": (c.api_token || "").trim() }, signal: ctrl.signal });
          clearTimeout(t);
          // Any HTTP response means the POS is reachable.
          return { id: c.id, ok: true, status: r.status };
        } catch {
          clearTimeout(t);
          return { id: c.id, ok: false };
        }
      }));
      const reachableIds = new Set(checks.filter((x) => x.ok).map((x) => x.id));
      const before = connections.length;
      connections = connections.filter((c: any) => reachableIds.has(c.id));
      skippedByPreflight = before - connections.length;
    }

    if (!connections || connections.length === 0) {
      return new Response(JSON.stringify({ ok: true, dispatched: 0, job, skippedByBreaker, skippedByPreflight }), {
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

    // STAGGERED dispatch: process in chunks of CONCURRENCY with a small delay between chunks.
    // Goal: never have more than CONCURRENCY in-flight HTTP calls at once, to protect
    // both our edge function pool and downstream Agora SQL Server pools.
    const CONCURRENCY = 10;
    const CHUNK_DELAY_MS = 1500;

    const invokeOne = async (dispatch: DispatchRequest) => {
      const url = `${SUPABASE_URL}/functions/v1/${dispatch.functionName}`;
      try {
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
      } catch (e) {
        return { connection_id: dispatch.connection_id, name: dispatch.name, ok: false, error: String(e) };
      }
    };

    const allResults: unknown[] = [];
    let okCount = 0;
    for (let i = 0; i < dispatchRequests.length; i += CONCURRENCY) {
      const chunk = dispatchRequests.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.allSettled(chunk.map(invokeOne));
      for (const r of chunkResults) {
        if (r.status === "fulfilled") {
          allResults.push(r.value);
          if ((r.value as { ok: boolean }).ok) okCount++;
        } else {
          allResults.push({ error: String(r.reason) });
        }
      }
      // Pause between chunks to spread the load (skip on the last chunk)
      if (i + CONCURRENCY < dispatchRequests.length) {
        await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
      }
    }
    const summary = allResults;

    return new Response(
      JSON.stringify({
        ok: true,
        job,
        connections: connections.length,
        skippedByBreaker,
        skippedByPreflight,
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
