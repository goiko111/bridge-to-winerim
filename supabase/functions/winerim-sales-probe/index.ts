// TEMPORARY read-only probe against the Winerim certified sales read endpoints.
// Remove after the audit is finished. Never returns the API token.
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

const WINERIM_BASE = 'https://app.winerim.com/api/v2';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const connectionId = String(body.connectionId || '');
    const path = String(body.path || '/sales/history');
    const query = (body.query ?? {}) as Record<string, string | number>;

    if (!connectionId) {
      return new Response(JSON.stringify({ error: 'connectionId required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: conn, error } = await supabase
      .from('pos_connections')
      .select('winerim_api_token, location_name')
      .eq('id', connectionId)
      .maybeSingle();

    if (error || !conn?.winerim_api_token) {
      return new Response(JSON.stringify({ error: 'no winerim token for connection' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(`${WINERIM_BASE}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    const method = String(body.method || 'GET').toUpperCase();
    const payload = body.payload ?? null;
    const res = await fetch(url.toString(), {
      method,
      headers: {
        'WINERIM-API-TOKEN': conn.winerim_api_token,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const text = await res.text();

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch (_e) {
      parsed = text.slice(0, 2000);
    }

    return new Response(
      JSON.stringify({ location: conn.location_name, requestUrl: url.toString(), status: res.status, body: parsed }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
