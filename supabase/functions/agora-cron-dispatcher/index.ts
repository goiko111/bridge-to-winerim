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

interface AgoraConnection {
  id: string;
  location_name: string;
  base_url: string | null;
  api_token: string | null;
  provider_config?: Record<string, unknown> | null;
  circuit_breaker_paused_until: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as DispatchBody;
    const job = body.job;
    if (job !== "catalog" && job !== "sales-stock" && job !== "outbound-queue") {
      return new Response(JSON.stringify({ error: "job must be 'catalog', 'sales-stock' or 'outbound-queue'" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // Load enabled Agora connections, EXCLUDING those paused by circuit breaker
    const nowIso = new Date().toISOString();
    let query = supabase
      .from("pos_connections")
      .select("id, location_name, base_url, api_token, provider_config, circuit_breaker_paused_until")
      .eq("provider", "agora")
      .eq("enabled", true);
    if (body.connectionId) query = query.eq("id", body.connectionId);

    const { data: allConnections, error: connErr } = await query;
    if (connErr) throw connErr;

    let connections = ((allConnections || []) as AgoraConnection[]).filter((c) =>
      !c.circuit_breaker_paused_until || c.circuit_breaker_paused_until < nowIso
    );
    const skippedByBreaker = (allConnections?.length || 0) - connections.length;

    // ── PRE-FLIGHT (Layer 4): for jobs that hit the customer POS (outbound-queue,
    // sales-stock), do a 5s reachability probe per connection BEFORE
    // dispatching. If unreachable, skip this round (the breaker will eventually
    // pause it on the natural call path; we just avoid filling the queue with FAILED).
    let skippedByPreflight = 0;
    if (connections.length > 0 && (job === "outbound-queue" || job === "sales-stock")) {
      const checks = await Promise.all(connections.map(async (c) => {
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
      connections = connections.filter((c) => reachableIds.has(c.id));
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
    // ORDER IS PART OF THE CONTRACT: the Agora master/products read (sync-master-data)
    // must finish BEFORE fetch-catalog triggers evaluate-auto-push, otherwise the
    // evaluator can compare against a stale Agora snapshot. Requests for one
    // connection are executed strictly sequentially (see invokeConnection) and the
    // catalog walk is skipped (fail-closed) if the master read did not succeed.
    const buildRequests = (connection: AgoraConnection): DispatchRequest[] => {
      if (job === "catalog") {
        return [
          { connection_id: connection.id, name: connection.location_name, functionName: "agora-proxy", body: { action: "sync-master-data", connectionId: connection.id } },
          { connection_id: connection.id, name: connection.location_name, functionName: "winerim-proxy", body: { action: "fetch-catalog", connectionId: connection.id } },
        ];
      }
      if (job === "outbound-queue") {
        return [{ connection_id: connection.id, name: connection.location_name, functionName: "agora-proxy", body: { action: "process-xml-outbound-queue", connectionId: connection.id, serverLoop: true } }];
      }
      // Prioritize the latency-sensitive paths. Closed-day catch-up can scan a
      // wider date range and must not prevent open tickets from reaching
      // Winerim when the dispatcher approaches its runtime limit.
      const requests: DispatchRequest[] = [];
      if (connection.provider_config?.open_tickets_sync_enabled === true) {
        requests.push({
          connection_id: connection.id,
          name: connection.location_name,
          functionName: "agora-proxy",
          body: { action: "sync-open-tickets", connectionId: connection.id },
        });
      }
      if (connection.provider_config?.intraday_sales_sync_enabled === true) {
        requests.push({
          connection_id: connection.id,
          name: connection.location_name,
          functionName: "agora-proxy",
          body: { action: "sync-intraday-sales", connectionId: connection.id },
        });
      }
      requests.push({
        connection_id: connection.id,
        name: connection.location_name,
        functionName: "agora-proxy",
        body: { action: "auto-sync-sales", connectionId: connection.id },
      });
      return requests;
    };

    // Process different connections in parallel, but serialize all actions for the
    // same connection. A database lease prevents overlapping cron invocations from
    // racing catalog cursors, open tickets, invoices, stock or outbound tasks.
    const CONCURRENCY = 6;
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

    const invokeConnection = async (connection: AgoraConnection) => {
      const lockToken = crypto.randomUUID();
      let lockHeartbeat: ReturnType<typeof setInterval> | null = null;
      let lockHeartbeatInFlight: Promise<void> | null = null;
      let lockHeartbeatStopped = false;
      let lockHeartbeatError: Error | null = null;
      const { data: acquired, error: lockError } = await supabase.rpc("acquire_agora_dispatch_lock", {
        p_connection_id: connection.id,
        p_job: job,
        p_lock_token: lockToken,
        p_ttl_seconds: 900,
      });
      if (lockError) {
        return [{
          connection_id: connection.id,
          name: connection.location_name,
          ok: false,
          skipped: true,
          reason: `LOCK_ERROR: ${lockError.message}`,
        }];
      }
      if (acquired !== true) {
        return [{
          connection_id: connection.id,
          name: connection.location_name,
          ok: true,
          skipped: true,
          reason: "DISPATCH_ALREADY_RUNNING",
        }];
      }

      const results: unknown[] = [];
      try {
        lockHeartbeat = setInterval(async () => {
          if (lockHeartbeatStopped || lockHeartbeatInFlight) return;
          lockHeartbeatInFlight = (async () => {
            try {
              const { data: renewed, error: renewError } = await supabase.rpc("acquire_agora_dispatch_lock", {
                p_connection_id: connection.id,
                p_job: job,
                p_lock_token: lockToken,
                p_ttl_seconds: 900,
              });
              if (renewError || renewed !== true) {
                lockHeartbeatError = new Error(renewError?.message || "Agora dispatch lock could not be renewed");
              }
            } catch (error) {
              lockHeartbeatError = error instanceof Error ? error : new Error(String(error));
            } finally {
              lockHeartbeatInFlight = null;
            }
          })();
          await lockHeartbeatInFlight;
        }, 240_000);

        for (const dispatch of buildRequests(connection)) {
          if (lockHeartbeatError) throw lockHeartbeatError;
          const result = await invokeOne(dispatch);
          results.push(result);
          // Fail-closed sequencing for the catalog job: never evaluate auto-push
          // against a stale Agora snapshot.
          if (job === "catalog" && dispatch.body.action === "sync-master-data" && !result.ok) {
            results.push({
              connection_id: connection.id,
              name: connection.location_name,
              ok: false,
              skipped: true,
              reason: "SKIPPED_FETCH_CATALOG_STALE_AGORA_MASTER",
            });
            break;
          }
        }
      } finally {
        lockHeartbeatStopped = true;
        if (lockHeartbeat) clearInterval(lockHeartbeat);
        if (lockHeartbeatInFlight) await lockHeartbeatInFlight;
        await supabase.rpc("release_agora_dispatch_lock", {
          p_connection_id: connection.id,
          p_job: job,
          p_lock_token: lockToken,
        });
      }
      return results;
    };

    const allResults: unknown[] = [];
    let okCount = 0;
    let lockedCount = 0;
    for (let i = 0; i < connections.length; i += CONCURRENCY) {
      const chunk = connections.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.allSettled(chunk.map(invokeConnection));
      for (const r of chunkResults) {
        if (r.status === "fulfilled") {
          for (const result of r.value as Array<{ ok?: boolean; reason?: string }>) {
            allResults.push(result);
            if (result.ok && result.reason !== "DISPATCH_ALREADY_RUNNING") okCount++;
            if (result.reason === "DISPATCH_ALREADY_RUNNING") lockedCount++;
          }
        } else {
          allResults.push({ error: String(r.reason) });
        }
      }
      // Pause between chunks to spread the load (skip on the last chunk)
      if (i + CONCURRENCY < connections.length) {
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
        skippedByLock: lockedCount,
        dispatched: allResults.length - lockedCount,
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
