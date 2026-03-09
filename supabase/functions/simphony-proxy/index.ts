import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// ── Wine detection constants ──
const DEFAULT_WINE_FAMILIES = [
  "wine","wines","red wine","white wine","rosé","sparkling",
  "champagne","prosecco","pinot","cabernet","merlot","chardonnay",
  "sauvignon","zinfandel","syrah","shiraz","riesling","malbec",
  "tempranillo","sangiovese","nebbiolo","moscato",
  "bottle","glass","by the glass","btg",
  "vino","tinto","blanco","rosado","cava","bodega",
];
const NON_WINE_FAMILIES = [
  "water","beer","cocktail","cocktails","spirit","spirits",
  "coffee","tea","juice","soda","soft drink","non-alcoholic",
  "appetizer","entree","main","dessert","side",
  "pizza","pasta","salad","bread","soup",
  "gin","whiskey","vodka","rum","tequila","bourbon",
  "snack","ice cream","fruit","birra","acqua","caffè","bibita",
];
const WINE_PRODUCT_KEYWORDS = [
  "reserve","reserva","riserva","gran","estate",
  "red","white","rosé","sparkling","brut","sec","demi-sec",
  "cabernet","merlot","pinot","chardonnay","sauvignon","zinfandel",
  "syrah","shiraz","malbec","tempranillo","sangiovese","nebbiolo",
  "champagne","prosecco","cava","franciacorta",
  "bottle","glass","btg","75cl","375ml","magnum",
  "napa","sonoma","bordeaux","burgundy","tuscany","rioja",
  "vintage","blend","varietal",
];
const NON_WINE_PRODUCT_KEYWORDS = [
  "water","mineral","coke","pepsi","sprite","tonic",
  "coffee","espresso","latte","cappuccino","beer","ipa","lager",
  "pizza","pasta","burger","fries","salad","bread",
  "gin tonic","whiskey","vodka","rum","mojito","margarita",
  "cake","ice cream","dessert","cheesecake",
];
const WINE_FORMAT_KEYWORDS = ["bottle","glass","btg","magnum","75cl","375ml","150cl","by the glass","half bottle"];

function computeWineScore(family: string | undefined, name: string | undefined, format: string | undefined, unitPrice: number, wineFamilies: string[], nonWineFamilies: string[]) {
  const f = (family || "").toLowerCase();
  const n = (name || "").toLowerCase();
  const fmt = (format || "").toLowerCase();
  let score = 0;
  const reasons: string[] = [];
  for (const wf of nonWineFamilies) { if (f.includes(wf)) { score -= 50; reasons.push(`family_non_wine:${wf}`); break; } }
  if (score >= 0) { for (const wf of wineFamilies) { if (f.includes(wf)) { score += 50; reasons.push(`family_wine:${wf}`); break; } } }
  for (const kw of NON_WINE_PRODUCT_KEYWORDS) { if (n.includes(kw)) { score -= 30; reasons.push(`name_non_wine:${kw}`); break; } }
  for (const kw of WINE_PRODUCT_KEYWORDS) { if (n.includes(kw)) { score += 30; reasons.push(`name_wine:${kw}`); break; } }
  for (const kw of WINE_FORMAT_KEYWORDS) { if (fmt.includes(kw) || n.includes(kw)) { score += 15; reasons.push(`format_wine:${kw}`); break; } }
  if (unitPrice > 0) {
    if (unitPrice >= 5 && unitPrice <= 500) { score += 10; reasons.push(`price_range:${unitPrice}`); }
    else if (unitPrice < 5) { score -= 10; reasons.push(`price_too_low:${unitPrice}`); }
  }
  if (!f && score === 0) { score += 5; reasons.push("no_family_fallback"); }
  return { score: Math.max(-100, Math.min(100, score)), reasons };
}

function isWineCandidate(family: string | undefined, name: string | undefined, format: string | undefined, unitPrice: number, wineFamilies: string[], nonWineFamilies: string[]) {
  const { score, reasons } = computeWineScore(family, name, format, unitPrice, wineFamilies, nonWineFamilies);
  return { candidate: score > 0, score, reasons };
}

function suggestFamilyClassification(familyName: string) {
  const f = familyName.toLowerCase();
  for (const kw of NON_WINE_FAMILIES) { if (f.includes(kw)) return { suggestedWine: false, confidence: "high" as const }; }
  for (const kw of DEFAULT_WINE_FAMILIES) { if (f.includes(kw)) return { suggestedWine: true, confidence: "high" as const }; }
  if (f.includes("beverage") || f.includes("drink") || f.includes("bar")) return { suggestedWine: false, confidence: "medium" as const };
  return { suggestedWine: false, confidence: "low" as const };
}

// deno-lint-ignore no-explicit-any
function mapSimphonyMenuItem(item: any) {
  return {
    provider_product_id: String(item.menuItemId || item.objectNum || ""),
    name: String(item.name || item.longDescriptor || ""),
    format: "",
    family: String(item.familyGroupName || item.majorGroupName || ""),
    quantity: Number(item.quantity || 1),
    unit_price: Number(item.price || 0),
    total_amount: Number(item.total || item.price || 0) * Number(item.quantity || 1),
    vat_rate: 0,
  };
}

// ── Helper: get connection ──
async function getConnection(connId: string) {
  const { data, error } = await sb().from("pos_connections").select("*").eq("id", connId).single();
  if (error || !data) throw new Error("Connection not found");
  return data;
}

// ── Helper: STS headers (supports multi-RVC via override) ──
// deno-lint-ignore no-explicit-any
function stsHeaders(conn: any, rvcOverride?: string) {
  const parts = (conn.location_name || "").split("|");
  return {
    "Authorization": `Bearer ${conn.api_token}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Simphony-OrgShortName": parts[1] || "",
    "Simphony-LocRef": parts[2] || "",
    "Simphony-RvcRef": rvcOverride || parts[3] || "",
  };
}

// deno-lint-ignore no-explicit-any
function baseUrl(conn: any) {
  return (conn.base_url || "").replace(/\/+$/, "");
}

// deno-lint-ignore no-explicit-any
function ccBaseUrl(conn: any): string | null {
  const cfg = conn.provider_config as Record<string, string> | null;
  return cfg?.cc_base_url || null;
}

// deno-lint-ignore no-explicit-any
function getSelectedRvcs(conn: any): string[] {
  const cfg = conn.provider_config as Record<string, any> | null;
  const rvcs = cfg?.selected_rvcs;
  if (Array.isArray(rvcs) && rvcs.length > 0) return rvcs;
  const parts = (conn.location_name || "").split("|");
  return parts[3] ? [parts[3]] : [];
}

async function getWineFamilies(connectionId: string) {
  const { data: familyRules } = await sb()
    .from("wine_family_rules")
    .select("family_name, is_wine")
    .eq("connection_id", connectionId);
  const custom = familyRules?.filter((r: { is_wine: boolean }) => r.is_wine).map((r: { family_name: string }) => r.family_name.toLowerCase()) || [];
  return [...DEFAULT_WINE_FAMILIES, ...custom];
}

// ════════════════════════════════════════════════════════
// ACTION: test
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleTest(conn: any) {
  const url = `${baseUrl(conn)}/api/v1/checks?includeClosed=true&limit=1`;
  const res = await fetch(url, { headers: stsHeaders(conn) });
  if (res.ok) {
    const body = await res.json();
    const parts = (conn.location_name || "").split("|");
    return json({ success: true, merchantName: `${parts[1] || ""} / ${parts[2] || ""}`, checkCount: Array.isArray(body) ? body.length : (body.items?.length || 0) });
  }
  const errBody = await res.text();
  return json({ success: false, status: res.status, message: `Simphony responded ${res.status}: ${errBody.slice(0, 200)}` });
}

// ════════════════════════════════════════════════════════
// ACTION: oidc-acquire (S2)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleOidcAcquire(conn: any) {
  const cfg = conn.provider_config as Record<string, string> | null;
  const oidcBase = cfg?.oidc_base_url;
  const clientId = cfg?.client_id;
  const clientSecret = cfg?.client_secret;

  if (!oidcBase || !clientId || !clientSecret) {
    return json({ success: false, message: "OIDC base URL, Client ID, and Client Secret are required" });
  }

  const tokenUrl = `${oidcBase.replace(/\/+$/, "")}/oidc-provider/v1/oauth2/token`;

  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "openid",
    });

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      return json({ success: false, message: `OIDC token endpoint returned ${res.status}: ${errText.slice(0, 300)}` });
    }

    const tokenData = await res.json();
    const idToken = tokenData.id_token || tokenData.access_token;
    const expiresIn = tokenData.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    if (!idToken) {
      return json({ success: false, message: "Token response did not contain id_token or access_token" });
    }

    // Store the new token on the connection
    await sb().from("pos_connections").update({
      api_token: idToken,
      provider_config: {
        ...(cfg || {}),
        oidc_token_expires_at: expiresAt,
        oidc_refresh_token: tokenData.refresh_token || null,
      },
    }).eq("id", conn.id);

    return json({ success: true, message: `Token acquired, expires ${expiresAt}`, expiresAt });
  } catch (e: any) {
    return json({ success: false, message: `OIDC request failed: ${e.message}` });
  }
}

// ════════════════════════════════════════════════════════
// ACTION: discover-locations (S3)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleDiscoverLocations(conn: any) {
  const parts = (conn.location_name || "").split("|");
  const orgShortName = parts[1] || "";

  // Try STS Gen2 Organizations API
  const locations: { locRef: string; name: string; revenueCenters: { rvcRef: string; name: string }[] }[] = [];

  // Path 1: STS Organizations API
  try {
    const url = `${baseUrl(conn)}/api/v1/organizations/${orgShortName}/locations`;
    const res = await fetch(url, { headers: stsHeaders(conn) });
    if (res.ok) {
      const body = await res.json();
      const locs = Array.isArray(body) ? body : (body.items || body.locations || []);
      for (const loc of locs) {
        const locRef = String(loc.locRef || loc.locationRef || loc.id || "");
        const locName = String(loc.name || loc.locationName || locRef);
        const rvcs: { rvcRef: string; name: string }[] = [];

        // Try to fetch RVCs for this location
        try {
          const rvcUrl = `${baseUrl(conn)}/api/v1/organizations/${orgShortName}/locations/${locRef}/revenueCenters`;
          const rvcRes = await fetch(rvcUrl, { headers: stsHeaders(conn) });
          if (rvcRes.ok) {
            const rvcBody = await rvcRes.json();
            const rvcList = Array.isArray(rvcBody) ? rvcBody : (rvcBody.items || rvcBody.revenueCenters || []);
            for (const rvc of rvcList) {
              rvcs.push({
                rvcRef: String(rvc.rvcRef || rvc.revenueCenterRef || rvc.id || ""),
                name: String(rvc.name || rvc.revenueCenterName || ""),
              });
            }
          }
        } catch { /* skip */ }

        locations.push({ locRef, name: locName, revenueCenters: rvcs });
      }
    }
  } catch { /* skip */ }

  // Path 2: If STS didn't work, try C&C API
  if (locations.length === 0) {
    const cc = ccBaseUrl(conn);
    if (cc) {
      try {
        const res = await fetch(`${cc}/config/sim/v2/organizations/${orgShortName}/locations`, {
          headers: { "Authorization": `Bearer ${conn.api_token}`, "Accept": "application/json" },
        });
        if (res.ok) {
          const body = await res.json();
          const locs = Array.isArray(body) ? body : (body.items || body.locations || []);
          for (const loc of locs) {
            const locRef = String(loc.locRef || loc.objectNum || loc.id || "");
            const locName = String(loc.name || loc.longDescriptor || locRef);
            locations.push({ locRef, name: locName, revenueCenters: [] });
          }
        }
      } catch { /* skip */ }
    }
  }

  return json({
    locations,
    message: locations.length > 0
      ? `Found ${locations.length} locations with ${locations.reduce((s, l) => s + l.revenueCenters.length, 0)} revenue centers`
      : "No locations found. Verify org short name and API permissions.",
  });
}

// ════════════════════════════════════════════════════════
// ACTION: preflight (S2+S3+S8 enhanced)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handlePreflight(conn: any) {
  const checks: { id: string; label: string; status: string; detail?: string }[] = [];

  // 1) STS reachable
  let stsOk = false;
  try {
    const url = `${baseUrl(conn)}/api/v1/checks?includeClosed=true&limit=1`;
    const res = await fetch(url, { headers: stsHeaders(conn) });
    if (res.ok) {
      stsOk = true;
      checks.push({ id: "sts", label: "STS Gen2 reachable", status: "pass" });
    } else if (res.status === 403) {
      checks.push({ id: "sts", label: "STS Gen2 reachable", status: "fail", detail: "403 Forbidden — ensure RVC Option 74 is enabled: EMC → RVC Parameters → Options → 74 Enable STS Gen2" });
    } else if (res.status === 401) {
      checks.push({ id: "sts", label: "STS Gen2 reachable", status: "fail", detail: "401 Unauthorized — token expired or invalid. Use 'Acquire Token' to refresh." });
    } else {
      checks.push({ id: "sts", label: "STS Gen2 reachable", status: "warn", detail: `Status ${res.status}` });
    }
  } catch (e: any) {
    checks.push({ id: "sts", label: "STS Gen2 reachable", status: "fail", detail: e.message });
  }

  // 2) RVC Option 74 inference
  const stsCheck = checks[0];
  if (stsOk) {
    checks.push({ id: "rvc74", label: "RVC Option 74 (STS Gen2 enabled)", status: "pass", detail: "STS responding — option is enabled" });
  } else if (stsCheck?.detail?.includes("403")) {
    checks.push({
      id: "rvc74", label: "RVC Option 74 (STS Gen2 enabled)", status: "fail",
      detail: "Likely disabled. Steps: EMC → Setup → RVC Parameters → Options tab → Enable #74 (Enable STS Gen2). Also verify a POS API Client workstation exists for this RVC.",
    });
  } else {
    checks.push({ id: "rvc74", label: "RVC Option 74 (STS Gen2 enabled)", status: "warn", detail: "Unable to determine — verify manually in EMC" });
  }

  // 3) OIDC token validity
  const cfg = conn.provider_config as Record<string, string> | null;
  const tokenExpiry = cfg?.oidc_token_expires_at;
  if (stsOk) {
    checks.push({ id: "oidc", label: "OIDC token valid", status: "pass", detail: tokenExpiry ? `Expires: ${tokenExpiry}` : "Token accepted by STS" });
  } else if (stsCheck?.detail?.includes("401")) {
    checks.push({ id: "oidc", label: "OIDC token valid", status: "fail", detail: "Token rejected. Acquire a new token via OIDC client_credentials flow." });
  } else {
    checks.push({ id: "oidc", label: "OIDC token valid", status: "warn", detail: tokenExpiry ? `Expires: ${tokenExpiry}` : "Token may be expired or invalid" });
  }

  // 4) POS API Client workstation (S8)
  if (stsOk) {
    checks.push({ id: "workstation", label: "POS API Client workstation", status: "pass", detail: "STS Gen2 responding implies workstation exists" });
  } else {
    checks.push({
      id: "workstation", label: "POS API Client workstation", status: "warn",
      detail: "Ensure a workstation of type 'POS API Client' exists: EMC → Setup → Workstations → New → Type: POS API Client, CAPS Service Host configured",
    });
  }

  // 5) C&C API (optional)
  const cc = ccBaseUrl(conn);
  if (cc) {
    try {
      const parts = (conn.location_name || "").split("|");
      const res = await fetch(`${cc}/config/sim/v2/organizations/${parts[1]}/locations`, {
        headers: { "Authorization": `Bearer ${conn.api_token}`, "Accept": "application/json" },
      });
      if (res.ok) {
        checks.push({ id: "cc", label: "Config & Content API (optional)", status: "pass", detail: "C&C API responding" });
      } else {
        checks.push({ id: "cc", label: "Config & Content API (optional)", status: "warn", detail: `Status ${res.status}. Verify CCAPI URL from EMC → Enterprise Parameters → Applications` });
      }
    } catch {
      checks.push({ id: "cc", label: "Config & Content API (optional)", status: "warn", detail: "Not reachable" });
    }
  } else {
    checks.push({ id: "cc", label: "Config & Content API (optional)", status: "warn", detail: "Not configured — catalog write disabled" });
  }

  // 6) Notifications API (optional)
  if (stsOk) {
    try {
      const url = `${baseUrl(conn)}/api/v1/notifications/subscriptions`;
      const res = await fetch(url, { headers: stsHeaders(conn) });
      if (res.ok || res.status === 404) {
        checks.push({ id: "notifications", label: "Notifications API (optional)", status: res.ok ? "pass" : "warn", detail: res.ok ? "Notifications endpoint available" : "Endpoint returned 404 — may not be enabled" });
      } else {
        checks.push({ id: "notifications", label: "Notifications API (optional)", status: "warn", detail: `Status ${res.status}` });
      }
    } catch {
      checks.push({ id: "notifications", label: "Notifications API (optional)", status: "warn", detail: "Not reachable" });
    }
  } else {
    checks.push({ id: "notifications", label: "Notifications API (optional)", status: "warn", detail: "Skipped (STS not reachable)" });
  }

  return json({ checks });
}

// ════════════════════════════════════════════════════════
// ACTION: find-last-business-day (S4 — multi-RVC aware, per-RVC diagnostics)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleFindDays(conn: any, daysBack: number) {
  const scanDays = daysBack || 60;
  const rvcs = getSelectedRvcs(conn);
  const globalDays = new Set<string>();
  let totalScanned = 0;
  let totalInvoicesFound = 0;
  const perRvc: Record<string, { invoices: number; days: string[] }> = {};

  for (const rvc of rvcs) {
    const rvcDays = new Set<string>();
    let rvcInvoices = 0;
    for (let i = 0; i < scanDays; i += 7) {
      const sinceDate = new Date(Date.now() - Math.min(i + 7, scanDays) * 86400000);
      try {
        const url = `${baseUrl(conn)}/api/v1/checks?includeClosed=true&sinceTime=${sinceDate.toISOString()}&limit=500`;
        const res = await fetch(url, { headers: stsHeaders(conn, rvc) });
        if (res.ok) {
          const body = await res.json();
          const checks = Array.isArray(body) ? body : (body.items || body.checks || []);
          rvcInvoices += checks.length;
          totalInvoicesFound += checks.length;
          for (const check of checks) {
            const openTime = check.openTime || check.closedTime || check.createdAt;
            if (openTime) {
              const day = new Date(openTime).toISOString().split("T")[0];
              rvcDays.add(day);
              globalDays.add(day);
            }
          }
        } else { await res.text(); }
      } catch { /* skip */ }
      totalScanned += Math.min(7, scanDays - i);
    }
    perRvc[rvc] = { invoices: rvcInvoices, days: Array.from(rvcDays).sort((a, b) => b.localeCompare(a)) };
  }

  const daysWithSales = Array.from(globalDays).sort((a, b) => b.localeCompare(a));
  return json({
    daysWithSales: daysWithSales.slice(0, 30),
    totalScanned,
    totalInvoicesFound,
    // Per-RVC diagnostics (omitted for single-RVC to keep backward compat)
    ...(rvcs.length > 1 ? { perRvc } : {}),
  });
}

// ════════════════════════════════════════════════════════
// ACTION: fetch-day (S4 — multi-RVC, global dedup by checkId, per-RVC diagnostics)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleFetchDay(conn: any, connectionId: string, businessDay: string) {
  if (!businessDay) return json({ error: "businessDay is required" }, 400);
  const rvcs = getSelectedRvcs(conn);
  const sinceTime = `${businessDay}T00:00:00Z`;
  const wineFamilies = await getWineFamilies(connectionId);
  const allFamilies = new Set<string>();
  // Global dedup: prevent same check from appearing across RVC queries
  const seenDocIds = new Set<string>();
  // deno-lint-ignore no-explicit-any
  const salesEvents: any[] = [];
  const perRvc: Record<string, { invoices: number; lineItems: number; wineItems: number; duplicatesSkipped: number }> = {};

  for (const rvc of rvcs) {
    let rvcInvoices = 0;
    let rvcLines = 0;
    let rvcWine = 0;
    let rvcDuplicates = 0;

    const url = `${baseUrl(conn)}/api/v1/checks?includeClosed=true&sinceTime=${sinceTime}&limit=1000`;
    try {
      const res = await fetch(url, { headers: stsHeaders(conn, rvc) });
      if (!res.ok) { await res.text(); continue; }
      const body = await res.json();
      // deno-lint-ignore no-explicit-any
      let allChecks: any[] = Array.isArray(body) ? body : (body.items || body.checks || []);
      // deno-lint-ignore no-explicit-any
      allChecks = allChecks.filter((c: any) => (c.openTime || c.closedTime || "").startsWith(businessDay));

      for (const check of allChecks) {
        const docId = String(check.checkId || check.id || "");
        // Global dedup: if this checkId was already processed from another RVC, skip
        if (seenDocIds.has(docId)) {
          rvcDuplicates++;
          continue;
        }
        seenDocIds.add(docId);
        rvcInvoices++;

        const menuItems = check.menuItems || check.detailLines || [];
        // deno-lint-ignore no-explicit-any
        const lines: any[] = [];
        for (const item of menuItems) {
          const mapped = mapSimphonyMenuItem(item);
          if (mapped.family) allFamilies.add(mapped.family);
          const wr = isWineCandidate(mapped.family, mapped.name, mapped.format, mapped.unit_price, wineFamilies, NON_WINE_FAMILIES);
          lines.push({ ...mapped, is_wine_candidate: wr.candidate, wine_score: wr.score, wine_reasons: wr.reasons });
          rvcLines++;
          if (wr.candidate) rvcWine++;
        }
        const totals = check.totals || {};
        const totalAmount = Number(totals.subtotal || totals.total || check.total || 0);
        const totalTax = Number(totals.tax || check.taxTotal || 0);
        salesEvents.push({
          provider_doc_id: `${docId}${rvcs.length > 1 ? `_${rvc}` : ""}`,
          business_day: businessDay, doc_type: check.checkType || "Check",
          total_amount: totalAmount, total_tax: totalTax, total_net: totalAmount - totalTax,
          line_count: lines.length, lines, rvc_ref: rvc,
        });
      }
    } catch { /* skip */ }

    perRvc[rvc] = { invoices: rvcInvoices, lineItems: rvcLines, wineItems: rvcWine, duplicatesSkipped: rvcDuplicates };
  }

  const detectedFamilies = Array.from(allFamilies).map((f) => {
    const suggestion = suggestFamilyClassification(f);
    // deno-lint-ignore no-explicit-any
    const itemCount = salesEvents.reduce((c: number, ev: any) => c + ev.lines.filter((l: any) => l.family === f).length, 0);
    return { name: f, ...suggestion, itemCount };
  });

  return json({
    businessDay, invoiceCount: salesEvents.length, salesEvents, detectedFamilies,
    ...(rvcs.length > 1 ? { perRvc, totalDuplicatesSkipped: Object.values(perRvc).reduce((s, r) => s + r.duplicatesSkipped, 0) } : {}),
  });
}

// ════════════════════════════════════════════════════════
// ACTION: save-sales (multi-RVC aware, global dedup, per-RVC cursor & diagnostics)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleSaveSales(conn: any, connectionId: string, businessDay: string) {
  if (!businessDay) return json({ error: "businessDay required" }, 400);
  const rvcs = getSelectedRvcs(conn);
  const sinceTime = `${businessDay}T00:00:00Z`;
  const wineFamilies = await getWineFamilies(connectionId);
  const supabaseClient = sb();
  let savedEvents = 0;
  let savedLines = 0;
  // Global dedup by checkId to prevent cross-RVC duplicates
  const seenDocIds = new Set<string>();
  const perRvc: Record<string, { saved: number; lines: number; wineItems: number; duplicatesSkipped: number; errors: string[] }> = {};

  for (const rvc of rvcs) {
    let rvcSaved = 0;
    let rvcLines = 0;
    let rvcWine = 0;
    let rvcDuplicates = 0;
    const rvcErrors: string[] = [];

    // deno-lint-ignore no-explicit-any
    let allChecks: any[] = [];
    try {
      const url = `${baseUrl(conn)}/api/v1/checks?includeClosed=true&sinceTime=${sinceTime}&limit=1000`;
      const res = await fetch(url, { headers: stsHeaders(conn, rvc) });
      if (res.ok) {
        const body = await res.json();
        allChecks = Array.isArray(body) ? body : (body.items || body.checks || []);
      } else {
        rvcErrors.push(`Fetch failed: ${res.status}`);
      }
    } catch (e: any) {
      rvcErrors.push(`Fetch error: ${e.message}`);
    }
    // deno-lint-ignore no-explicit-any
    allChecks = allChecks.filter((c: any) => (c.openTime || c.closedTime || "").startsWith(businessDay));

    for (const check of allChecks) {
      const docId = String(check.checkId || check.id || "");
      // Global dedup: skip if already processed from another RVC
      if (seenDocIds.has(docId)) {
        rvcDuplicates++;
        continue;
      }
      seenDocIds.add(docId);

      const menuItems = check.menuItems || check.detailLines || [];
      // deno-lint-ignore no-explicit-any
      const lineData: any[] = [];
      for (const item of menuItems) {
        const mapped = mapSimphonyMenuItem(item);
        const wr = isWineCandidate(mapped.family, mapped.name, mapped.format, mapped.unit_price, wineFamilies, NON_WINE_FAMILIES);
        lineData.push({ ...mapped, is_wine_candidate: wr.candidate });
        if (wr.candidate) rvcWine++;
      }
      const totals = check.totals || {};
      const totalAmount = Number(totals.subtotal || totals.total || check.total || 0);
      const totalTax = Number(totals.tax || check.taxTotal || 0);
      const providerDocId = `${docId}${rvcs.length > 1 ? `_${rvc}` : ""}`;

      const { data: eventRow, error: eventErr } = await supabaseClient
        .from("sales_events")
        .upsert({
          connection_id: connectionId, provider_doc_id: providerDocId, business_day: businessDay,
          doc_type: check.checkType || "Check", total_amount: totalAmount, total_tax: totalTax,
          total_net: totalAmount - totalTax, line_count: lineData.length, raw_json: check,
        }, { onConflict: "connection_id,provider_doc_id" })
        .select("id").single();

      if (eventErr || !eventRow) {
        if (eventErr) rvcErrors.push(`Upsert ${docId}: ${eventErr.message}`);
        continue;
      }
      rvcSaved++;
      savedEvents++;
      await supabaseClient.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);
      // deno-lint-ignore no-explicit-any
      const linesToInsert = lineData.map((l: any) => ({ ...l, sales_event_id: eventRow.id, connection_id: connectionId }));
      if (linesToInsert.length > 0) {
        const { error: lineErr } = await supabaseClient.from("sales_line_items").insert(linesToInsert);
        if (!lineErr) { savedLines += linesToInsert.length; rvcLines += linesToInsert.length; }
      }
    }

    perRvc[rvc] = { saved: rvcSaved, lines: rvcLines, wineItems: rvcWine, duplicatesSkipped: rvcDuplicates, errors: rvcErrors };
  }

  // Update global cursor
  await supabaseClient.from("pos_connections").update({
    last_business_day_synced: businessDay,
    last_sync_at: new Date().toISOString(),
    // Store per-RVC cursors in provider_config for multi-RVC tracking
    ...(rvcs.length > 1 ? {
      provider_config: {
        ...(conn.provider_config || {}),
        rvc_cursors: {
          ...((conn.provider_config as Record<string, any>)?.rvc_cursors || {}),
          ...Object.fromEntries(rvcs.map(rvc => [rvc, { last_business_day: businessDay, synced_at: new Date().toISOString() }])),
        },
      },
    } : {}),
  }).eq("id", connectionId);

  return json({
    success: true, savedEvents, savedLines, businessDay,
    ...(rvcs.length > 1 ? {
      perRvc,
      totalDuplicatesSkipped: Object.values(perRvc).reduce((s, r) => s + r.duplicatesSkipped, 0),
    } : {}),
  });
}

// ════════════════════════════════════════════════════════
// ACTION: cc-read-catalog (S5)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleCcReadCatalog(conn: any) {
  const cc = ccBaseUrl(conn);
  if (!cc) return json({ items: [], message: "Config & Content API URL not configured" });

  const parts = (conn.location_name || "").split("|");
  const orgShortName = parts[1] || "";
  try {
    const res = await fetch(`${cc}/config/sim/v2/organizations/${orgShortName}/menuItems?limit=500`, {
      headers: { "Authorization": `Bearer ${conn.api_token}`, "Accept": "application/json" },
    });
    if (!res.ok) {
      const t = await res.text();
      return json({ items: [], message: `C&C API responded ${res.status}: ${t.slice(0, 200)}` });
    }
    const body = await res.json();
    // deno-lint-ignore no-explicit-any
    const rawItems = Array.isArray(body) ? body : (body.items || body.menuItems || []);
    // deno-lint-ignore no-explicit-any
    const items = rawItems.map((it: any) => ({
      menuItemId: String(it.menuItemId || it.objectNum || it.id || ""),
      name: String(it.name || it.longDescriptor || ""),
      familyGroup: String(it.familyGroupName || it.majorGroupName || ""),
      price: Number(it.price || it.defaultPrice || 0),
      active: it.active !== false,
    }));
    return json({ items });
  } catch (e: any) {
    return json({ items: [], message: e.message });
  }
}

// ════════════════════════════════════════════════════════
// ACTION: cc-write-preview (S7)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleCcWritePreview(conn: any, connectionId: string) {
  const supabaseClient = sb();
  const { data: wines } = await supabaseClient
    .from("winerim_wines").select("*")
    .eq("connection_id", connectionId).eq("pricing_status", "READY").eq("is_active", true);

  if (!wines || wines.length === 0) return json({ preview: [], message: "No wines with pricing_status=READY" });

  const { data: existingMappings } = await supabaseClient
    .from("product_mappings").select("winerim_wine_id, provider_product_id, format_type")
    .eq("connection_id", connectionId);

  const mappingMap = new Map<string, string>();
  for (const m of existingMappings || []) {
    if (m.winerim_wine_id) mappingMap.set(`${m.winerim_wine_id}_${m.format_type}`, m.provider_product_id);
  }

  // deno-lint-ignore no-explicit-any
  const preview: any[] = [];
  for (const w of wines) {
    if (w.bottle_sale_price) {
      const key = `${w.winerim_id}_BOT`;
      preview.push({ action: mappingMap.has(key) ? "update" : "create", winerimId: w.winerim_id, wineName: w.name, menuItemName: `${w.name} (Botella)`, price: w.bottle_sale_price, format: "BOT" });
    }
    if (w.serve_by_glass && w.glass_sale_price) {
      const key = `${w.winerim_id}_COPA`;
      preview.push({ action: mappingMap.has(key) ? "update" : "create", winerimId: w.winerim_id, wineName: w.name, menuItemName: `${w.name} (Copa)`, price: w.glass_sale_price, format: "COPA" });
    }
    if (w.magnum_sale_price) {
      const key = `${w.winerim_id}_MAG`;
      preview.push({ action: mappingMap.has(key) ? "update" : "create", winerimId: w.winerim_id, wineName: w.name, menuItemName: `${w.name} (Magnum)`, price: w.magnum_sale_price, format: "MAG" });
    }
  }
  return json({ preview });
}

// ════════════════════════════════════════════════════════
// ACTION: cc-write-execute (S7 — with post-write verification)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleCcWriteExecute(conn: any, connectionId: string, dryRun: boolean) {
  const cc = ccBaseUrl(conn);
  if (!cc) return json({ created: 0, updated: 0, message: "C&C API URL not configured" });

  const supabaseClient = sb();
  const { data: wines } = await supabaseClient
    .from("winerim_wines").select("*")
    .eq("connection_id", connectionId).eq("pricing_status", "READY").eq("is_active", true);

  if (!wines || wines.length === 0) return json({ created: 0, updated: 0, message: "No wines ready" });

  const parts = (conn.location_name || "").split("|");
  const orgShortName = parts[1] || "";
  let created = 0;
  let updated = 0;
  const errors: string[] = [];

  for (const w of wines) {
    const formats = [];
    if (w.bottle_sale_price) formats.push({ format: "BOT", name: `${w.name} (Botella)`, price: w.bottle_sale_price });
    if (w.serve_by_glass && w.glass_sale_price) formats.push({ format: "COPA", name: `${w.name} (Copa)`, price: w.glass_sale_price });
    if (w.magnum_sale_price) formats.push({ format: "MAG", name: `${w.name} (Magnum)`, price: w.magnum_sale_price });

    for (const fmt of formats) {
      if (dryRun) { created++; continue; }

      const { error: taskErr } = await supabaseClient.from("outbound_tasks").insert({
        connection_id: connectionId,
        task_type: "SIMPHONY_CC_WRITE",
        status: "PENDING_APPROVAL",
        payload_json: {
          winerim_id: w.winerim_id, wine_name: w.name,
          menu_item_name: fmt.name, price: fmt.price, format: fmt.format,
          cc_base_url: cc, org_short_name: orgShortName,
          verify_after_write: true,
        },
      });
      if (taskErr) { errors.push(`${fmt.name}: ${taskErr.message}`); } else { created++; }
    }
  }

  return json({ created, updated, dryRun, errors: errors.length > 0 ? errors : undefined, message: dryRun ? `Dry-run: ${created} items would be created/updated` : `${created} tasks enqueued for approval` });
}

// ════════════════════════════════════════════════════════
// ACTION: generate-import-export (S6 bulk fallback)
// ════════════════════════════════════════════════════════
async function handleGenerateImportExport(connectionId: string, format: string) {
  const supabaseClient = sb();
  const { data: wines } = await supabaseClient
    .from("winerim_wines").select("*")
    .eq("connection_id", connectionId).eq("pricing_status", "READY").eq("is_active", true);

  if (!wines || wines.length === 0) return json({ success: false, message: "No wines with READY status" });

  // deno-lint-ignore no-explicit-any
  const items: any[] = [];
  for (const w of wines) {
    if (w.bottle_sale_price) items.push({ objectNum: `WINERIM_${w.winerim_id}_BOT`, name: `${w.name} (Botella)`, familyGroup: w.wine_type || "Vinos", price: w.bottle_sale_price, format: "BOT" });
    if (w.serve_by_glass && w.glass_sale_price) items.push({ objectNum: `WINERIM_${w.winerim_id}_COPA`, name: `${w.name} (Copa)`, familyGroup: w.wine_type || "Vinos", price: w.glass_sale_price, format: "COPA" });
    if (w.magnum_sale_price) items.push({ objectNum: `WINERIM_${w.winerim_id}_MAG`, name: `${w.name} (Magnum)`, familyGroup: w.wine_type || "Vinos", price: w.magnum_sale_price, format: "MAGNUM" });
  }

  let content: string;
  const fileName = `simphony_import_${Date.now()}.${format === "csv" ? "csv" : "json"}`;
  if (format === "csv") {
    const header = "ObjectNum,Name,FamilyGroup,Price,Format";
    const lines = items.map((i) => `${i.objectNum},"${i.name}",${i.familyGroup},${i.price},${i.format}`);
    content = [header, ...lines].join("\n");
  } else {
    content = JSON.stringify({ menuItems: items }, null, 2);
  }
  return json({ success: true, content, fileName, itemCount: items.length, message: `Generated ${items.length} menu items for import` });
}

// ════════════════════════════════════════════════════════
// ACTION: register-webhook (S6 Notifications API)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleRegisterWebhook(conn: any, connectionId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const callbackUrl = `${supabaseUrl}/functions/v1/simphony-proxy`;

  // Try to register a notification subscription
  try {
    const url = `${baseUrl(conn)}/api/v1/notifications/subscriptions`;
    const subscriptionBody = {
      callbackUrl: callbackUrl,
      eventTypes: ["CHECK_CLOSED", "CHECK_OPENED", "CHECK_UPDATED"],
      description: `Winerim Bridge webhook for connection ${connectionId}`,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: stsHeaders(conn),
      body: JSON.stringify(subscriptionBody),
    });

    if (res.ok) {
      const body = await res.json();
      return json({
        webhookStatus: {
          registered: true,
          callbackUrl,
          subscriptionId: body.subscriptionId || body.id || null,
          lastEventAt: null,
          eventCount: 0,
        },
        message: "Webhook subscription registered successfully",
      });
    } else {
      const errText = await res.text();
      return json({
        webhookStatus: {
          registered: false,
          callbackUrl,
          lastEventAt: null,
          eventCount: 0,
        },
        message: `Notifications API returned ${res.status}: ${errText.slice(0, 200)}. This API may require partner enablement or a specific STS version.`,
      });
    }
  } catch (e: any) {
    return json({
      webhookStatus: { registered: false, callbackUrl, lastEventAt: null, eventCount: 0 },
      message: `Webhook registration failed: ${e.message}`,
    });
  }
}

// ════════════════════════════════════════════════════════
// ACTION: webhook-status (S6)
// ════════════════════════════════════════════════════════
async function handleWebhookStatus(connectionId: string) {
  const supabaseClient = sb();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

  const { data: events, error } = await supabaseClient
    .from("webhook_events")
    .select("created_at")
    .eq("connection_id", connectionId)
    .eq("provider", "SIMPHONY")
    .order("created_at", { ascending: false })
    .limit(1);

  const { count } = await supabaseClient
    .from("webhook_events")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", connectionId)
    .eq("provider", "SIMPHONY");

  return json({
    webhookStatus: {
      registered: true,
      callbackUrl: `${supabaseUrl}/functions/v1/simphony-proxy`,
      lastEventAt: events?.[0]?.created_at || null,
      eventCount: count || 0,
    },
  });
}

// ════════════════════════════════════════════════════════
// ACTION: webhook-ingest (S6 — callback handler)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleWebhookIngest(payload: any) {
  const supabaseClient = sb();
  const eventType = payload.eventType || payload.type || "UNKNOWN";
  const eventId = payload.eventId || payload.id || `simphony_${Date.now()}`;

  // Store the raw event
  await supabaseClient.from("webhook_events").insert({
    provider: "SIMPHONY",
    event_id: eventId,
    event_type: eventType,
    payload: payload,
    connection_id: payload.connectionId || null,
    status: "PENDING",
  });

  return json({ received: true, eventId });
}

// ════════════════════════════════════════════════════════
// ACTION: pilot-run (S7 enhanced)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handlePilotRun(conn: any, connectionId: string) {
  const steps: { id: string; label: string; status: string; detail?: string }[] = [];

  // Step 1: Verify connection
  try {
    const url = `${baseUrl(conn)}/api/v1/checks?includeClosed=true&limit=1`;
    const res = await fetch(url, { headers: stsHeaders(conn) });
    steps.push({ id: "connect", label: "Connection verified", status: res.ok ? "done" : "error", detail: res.ok ? "STS Gen2 responding" : `Status ${res.status}` });
    if (!res.ok) { await res.text(); return json({ steps }); }
  } catch (e: any) {
    steps.push({ id: "connect", label: "Connection verified", status: "error", detail: e.message });
    return json({ steps });
  }

  // Step 2: Read master data
  const cc = ccBaseUrl(conn);
  if (cc) {
    try {
      const parts = (conn.location_name || "").split("|");
      const res = await fetch(`${cc}/config/sim/v2/organizations/${parts[1]}/menuItems?limit=10`, {
        headers: { "Authorization": `Bearer ${conn.api_token}`, "Accept": "application/json" },
      });
      if (res.ok) {
        const body = await res.json();
        const count = Array.isArray(body) ? body.length : (body.items?.length || 0);
        steps.push({ id: "master", label: "Read master data", status: "done", detail: `${count} menu items sampled` });
      } else {
        steps.push({ id: "master", label: "Read master data", status: "warn", detail: `C&C returned ${res.status}` });
      }
    } catch {
      steps.push({ id: "master", label: "Read master data", status: "warn", detail: "C&C not reachable" });
    }
  } else {
    steps.push({ id: "master", label: "Read master data", status: "warn", detail: "C&C not configured — skipped" });
  }

  // Step 3: Push test item
  const supabaseClient = sb();
  const { error: pushErr } = await supabaseClient.from("outbound_tasks").insert({
    connection_id: connectionId,
    task_type: "SIMPHONY_PILOT_TEST_ITEM",
    status: "PENDING_APPROVAL",
    payload_json: {
      menu_item_name: "Winerim Test Wine (Botella)", price: 25.00, format: "BOT",
      note: "Pilot test item — please approve to push to Simphony",
    },
  });
  steps.push({
    id: "push-test", label: "Push 1 test menu item", status: pushErr ? "error" : "done",
    detail: pushErr ? pushErr.message : "Test item enqueued for approval",
  });

  // Step 4+5: Manual
  steps.push({ id: "wait-sales", label: "Awaiting 2 test sales (manual)", status: "pending", detail: "Ring 1 bottle + 1 glass sale, then return here" });
  steps.push({ id: "pull-sales", label: "Pull & verify BOT/COPA separation", status: "pending", detail: "Will verify once test sales are rung" });

  return json({ steps });
}

// ════════════════════════════════════════════════════════
// ACTION: rvc-diagnostics (per-RVC health & cursor report)
// ════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
async function handleRvcDiagnostics(conn: any, connectionId: string) {
  const rvcs = getSelectedRvcs(conn);
  if (rvcs.length <= 1) {
    return json({ singleRvc: true, message: "Single-RVC mode — no multi-RVC diagnostics needed", rvc: rvcs[0] || "none" });
  }

  const cfg = conn.provider_config as Record<string, any> | null;
  const rvcCursors = cfg?.rvc_cursors || {};

  const diagnostics: {
    rvc: string; reachable: boolean; status: number | null;
    sampleChecks: number; cursor: { last_business_day: string | null; synced_at: string | null };
    error?: string;
  }[] = [];

  for (const rvc of rvcs) {
    const cursor = rvcCursors[rvc] || { last_business_day: null, synced_at: null };
    try {
      const url = `${baseUrl(conn)}/api/v1/checks?includeClosed=true&limit=3`;
      const res = await fetch(url, { headers: stsHeaders(conn, rvc) });
      if (res.ok) {
        const body = await res.json();
        const checks = Array.isArray(body) ? body : (body.items || body.checks || []);
        diagnostics.push({ rvc, reachable: true, status: res.status, sampleChecks: checks.length, cursor });
      } else {
        const errText = await res.text();
        diagnostics.push({ rvc, reachable: false, status: res.status, sampleChecks: 0, cursor, error: errText.slice(0, 200) });
      }
    } catch (e: any) {
      diagnostics.push({ rvc, reachable: false, status: null, sampleChecks: 0, cursor, error: e.message });
    }
  }

  // Per-RVC saved event counts from DB
  const supabaseClient = sb();
  const perRvcDbCounts: Record<string, number> = {};
  for (const rvc of rvcs) {
    const { count } = await supabaseClient
      .from("sales_events")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", connectionId)
      .like("provider_doc_id", `%_${rvc}`);
    perRvcDbCounts[rvc] = count || 0;
  }

  return json({
    singleRvc: false,
    rvcCount: rvcs.length,
    diagnostics,
    savedEventsByRvc: perRvcDbCounts,
    globalCursor: conn.last_business_day_synced,
  });
}

// ════════════════════════════════════════════════════════
// ROUTER
// ════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const payload = await req.json();
    const { action, connectionId, businessDay, daysBack, dryRun, format } = payload;

    // Webhook ingest doesn't need a connectionId
    if (action === "webhook-ingest") return await handleWebhookIngest(payload);

    const conn = await getConnection(connectionId);

    switch (action) {
      case "test": return await handleTest(conn);
      case "oidc-acquire": return await handleOidcAcquire(conn);
      case "discover-locations": return await handleDiscoverLocations(conn);
      case "preflight": return await handlePreflight(conn);
      case "find-last-business-day": return await handleFindDays(conn, daysBack || 60);
      case "fetch-day": return await handleFetchDay(conn, connectionId, businessDay);
      case "save-sales": return await handleSaveSales(conn, connectionId, businessDay);
      case "cc-read-catalog": return await handleCcReadCatalog(conn);
      case "cc-write-preview": return await handleCcWritePreview(conn, connectionId);
      case "cc-write-execute": return await handleCcWriteExecute(conn, connectionId, dryRun !== false);
      case "generate-import-export": return await handleGenerateImportExport(connectionId, format || "json");
      case "register-webhook": return await handleRegisterWebhook(conn, connectionId);
      case "webhook-status": return await handleWebhookStatus(connectionId);
      case "pilot-run": return await handlePilotRun(conn, connectionId);
      case "rvc-diagnostics": return await handleRvcDiagnostics(conn, connectionId);
      default: return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e: any) {
    console.error("simphony-proxy error:", e);
    return json({ error: e.message }, 500);
  }
});
