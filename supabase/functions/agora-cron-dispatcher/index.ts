// Cron dispatcher for Agora connections
// Iterates all enabled Agora connections and invokes the appropriate proxy actions
// Triggered by pg_cron via HTTP every 5 min (catalog) and 15 min (sales/stock)
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
    if (job !== "catalog" && job !== "sales-stock" && job !== "outbound-queue") {
      return new Response(JSON.stringify({ error: "job must be 'catalog', 'sales-stock' or 'outbound-queue'" }), {
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

    // Map job → target function + body factory
    const targetFn = job === "catalog" ? "winerim-proxy" : "agora-proxy";
    const buildBody = (connectionId: string) =>
      job === "catalog"
        ? { action: "fetch-catalog", connectionId }
        : { action: "auto-sync-sales", connectionId };

    // Fire-and-forget invocations (parallel) so the cron returns quickly
    const results = await Promise.allSettled(
      connections.map(async (c) => {
        const url = `${SUPABASE_URL}/functions/v1/${targetFn}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify(buildBody(c.id)),
        });
        const text = await resp.text();
        return {
          connection_id: c.id,
          name: c.location_name,
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
        dispatched: connections.length,
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
