// READ-ONLY Agora catalog readback.
// Reads /api/export-master/?filter=Products once per invocation (in-memory cached
// for 15 min per connection) and stores one snapshot row per expected Winerim
// variant in catalog_readback_snapshots. It NEVER writes to Agora, never touches
// mappings, sales, stock, cursors or configuration.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { winerimFormatAgoraId } from "../_shared/winerimFormats.ts";

const READ_SOURCE = "AGORA_EXPORT_MASTER";
const CACHE_TTL_MS = 15 * 60 * 1000;
const xmlCache = new Map<string, { xml: string; fetchedAt: number }>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function decodeXml(v: string): string {
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

type AgoraProduct = {
  id: string;
  name: string | null;
  familyId: string | null;
  price: number | null;
  visible: boolean | null;
  saleable: boolean | null;
};

function parseProducts(xml: string): Map<string, AgoraProduct> {
  const out = new Map<string, AgoraProduct>();
  const re = /<Product\b([^>]*)(\/>|>([\s\S]*?)<\/Product>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const inner = m[3] ?? "";
    const id = attrs.match(/\bId="([^"]*)"/i)?.[1];
    if (!id) continue;
    const prices: number[] = [];
    const priceRe = /<Price\b[^>]*\bMainPrice="([^"]*)"/gi;
    let p: RegExpExecArray | null;
    while ((p = priceRe.exec(inner)) !== null) {
      const val = parseFloat(p[1]);
      if (Number.isFinite(val)) prices.push(val);
    }
    const boolAttr = (name: string): boolean | null => {
      const raw = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1];
      if (raw === undefined) return null; // unknown stays unknown
      return /^(true|1|yes)$/i.test(raw);
    };
    out.set(id, {
      id,
      name: attrs.match(/\bName="([^"]*)"/i)?.[1] ? decodeXml(attrs.match(/\bName="([^"]*)"/i)![1]) : null,
      familyId: attrs.match(/\bFamilyId="([^"]*)"/i)?.[1] ?? null,
      price: prices.length ? Math.max(...prices) : null,
      // Agora has no single "visible" flag: UseAsDirectSale is the main-screen key,
      // SaleableAsMain is whether it can be sold at all.
      visible: boolAttr("UseAsDirectSale"),
      saleable: boolAttr("SaleableAsMain"),
    });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "AUTH_REQUIRED", readOnly: true }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const connectionId = String((body as any).connectionId || "");
    const forceRefresh = Boolean((body as any).forceRefresh);
    if (!connectionId) return json({ error: "connectionId required", readOnly: true }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Caller must be an authenticated user of this app.
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } } as any,
    );
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return json({ error: "AUTH_REQUIRED", readOnly: true }, 401);

    const { data: conn, error: connErr } = await admin
      .from("pos_connections")
      .select("id, provider, base_url, api_token, location_name, circuit_breaker_paused_until")
      .eq("id", connectionId)
      .maybeSingle();

    if (connErr || !conn) return json({ error: "CONNECTION_NOT_FOUND", readOnly: true }, 404);
    if (conn.provider !== "agora") {
      return json({ error: "PROVIDER_NOT_SUPPORTED", provider: conn.provider, readOnly: true }, 400);
    }
    if (conn.circuit_breaker_paused_until && new Date(conn.circuit_breaker_paused_until) > new Date()) {
      return json({
        error: "CONNECTION_PAUSED",
        pausedUntil: conn.circuit_breaker_paused_until,
        readOnly: true,
      }, 409);
    }

    let baseUrl = String(conn.base_url || "").trim().replace(/\/+$/, "");
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = `http://${baseUrl}`;

    let xml = "";
    let fromCache = false;
    const cached = xmlCache.get(connectionId);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      xml = cached.xml;
      fromCache = true;
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/export-master/?filter=Products`, {
          headers: { "Api-Token": String(conn.api_token || ""), Accept: "application/xml" },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        return json({
          error: "AGORA_READ_FAILED",
          message: err instanceof Error ? err.message : String(err),
          readOnly: true,
        }, 502);
      }
      clearTimeout(timer);
      if (!res.ok) {
        return json({ error: "AGORA_READ_FAILED", httpStatus: res.status, readOnly: true }, 502);
      }
      xml = await res.text();
      xmlCache.set(connectionId, { xml, fetchedAt: Date.now() });
    }

    const agoraProducts = parseProducts(xml);

    // Expected variants come from the existing view; no duplication of catalogs.
    const { data: variants, error: varErr } = await admin
      .from("review_winerim_variants")
      .select("winerim_id, format_key, sale_price")
      .eq("connection_id", connectionId);
    if (varErr) return json({ error: "VARIANTS_READ_FAILED", message: varErr.message, readOnly: true }, 500);

    const { data: tracking } = await admin
      .from("winerim_push_tracking")
      .select("winerim_wine_id, format, agora_product_id, agora_family_id")
      .eq("connection_id", connectionId);

    const trackingIndex = new Map<string, { productId: string | null; familyId: string | null }>();
    for (const t of tracking ?? []) {
      trackingIndex.set(`${t.winerim_wine_id}::${t.format}`, {
        productId: t.agora_product_id ?? null,
        familyId: t.agora_family_id ?? null,
      });
    }

    const readAt = new Date().toISOString();
    const rows = (variants ?? []).map((v: any) => {
      const key = `${v.winerim_id}::${v.format_key}`;
      const tracked = trackingIndex.get(key);
      const productId = tracked?.productId || winerimFormatAgoraId(v.format_key, v.winerim_id);
      const product = productId ? agoraProducts.get(String(productId)) ?? null : null;
      const expectedPrice = v.sale_price === null || v.sale_price === undefined ? null : Number(v.sale_price);
      const differences: string[] = [];
      if (!product) {
        differences.push("MISSING_IN_AGORA");
      } else {
        if (expectedPrice !== null && product.price !== null && Math.abs(expectedPrice - product.price) > 0.005) {
          differences.push("PRICE_MISMATCH");
        }
        if (tracked?.familyId && product.familyId && tracked.familyId !== product.familyId) {
          differences.push("FAMILY_MISMATCH");
        }
        if (product.saleable === false) differences.push("NOT_SALEABLE");
      }
      return {
        connection_id: connectionId,
        winerim_wine_id: String(v.winerim_id),
        format_key: String(v.format_key),
        agora_product_id: productId ? String(productId) : null,
        found_in_agora: Boolean(product),
        agora_name: product?.name ?? null,
        agora_price: product?.price ?? null,
        agora_family_id: product?.familyId ?? null,
        agora_family_name: null, // family names are not in the Products export
        agora_visible: product ? product.visible : null,
        agora_saleable: product ? product.saleable : null,
        expected_price: expectedPrice,
        expected_family_id: tracked?.familyId ?? null,
        differences,
        read_at: readAt,
        read_source: READ_SOURCE,
      };
    });

    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error: upErr } = await admin
        .from("catalog_readback_snapshots")
        .upsert(batch, { onConflict: "connection_id,winerim_wine_id,format_key" });
      if (upErr) return json({ error: "SNAPSHOT_WRITE_FAILED", message: upErr.message, readOnly: true }, 500);
      written += batch.length;
    }

    return json({
      readOnly: true,
      connectionId,
      locationName: conn.location_name,
      readAt,
      fromCache,
      agoraProductsParsed: agoraProducts.size,
      expectedVariants: rows.length,
      snapshotsWritten: written,
      foundInAgora: rows.filter((r) => r.found_in_agora).length,
      missingInAgora: rows.filter((r) => !r.found_in_agora).length,
    });
  } catch (err) {
    return json({
      error: "UNEXPECTED",
      message: err instanceof Error ? err.message : String(err),
      readOnly: true,
    }, 500);
  }
});
