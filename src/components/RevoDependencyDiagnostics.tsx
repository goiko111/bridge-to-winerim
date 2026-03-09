import { useState, useCallback, useEffect } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Loader2, RefreshCw, Layers, Tag, DollarSign, ShoppingBag, MapPin, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

interface DepDiagnostics {
  groups: { id: string; name: string }[];
  categories: { id: string; name: string; group_id?: string; group_name?: string }[];
  taxes: { id?: string; percentage: number; name?: string }[];
  sellingFormats: { id?: string; name: string }[];
  rooms: { id: string; name: string }[];
  warnings: { area: string; message: string }[];
  fetchedAt: string;
}

type Status = "idle" | "loading" | "done" | "error";

export default function RevoDependencyDiagnostics({ connectionId }: { connectionId: string | null }) {
  const [status, setStatus] = useState<Status>("idle");
  const [diag, setDiag] = useState<DepDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastCatalogSync, setLastCatalogSync] = useState<string | null>(null);

  // Load last catalog sync time
  useEffect(() => {
    if (!connectionId) return;
    supabase.from("pos_connections").select("last_catalog_sync_at").eq("id", connectionId).single()
      .then(({ data }) => { if (data?.last_catalog_sync_at) setLastCatalogSync(data.last_catalog_sync_at); });
  }, [connectionId]);

  const fetchDiagnostics = useCallback(async () => {
    if (!connectionId) return;
    setStatus("loading");
    setError(null);

    try {
      // Fetch groups, categories, taxes, sellingFormats, rooms in parallel via the proxy
      const results = await Promise.allSettled([
        supabase.functions.invoke("revo-proxy", { body: { action: "fetch-diagnostics-deps", connectionId, resource: "groups" } }),
        supabase.functions.invoke("revo-proxy", { body: { action: "fetch-diagnostics-deps", connectionId, resource: "categories" } }),
        supabase.functions.invoke("revo-proxy", { body: { action: "fetch-diagnostics-deps", connectionId, resource: "taxes" } }),
        supabase.functions.invoke("revo-proxy", { body: { action: "fetch-diagnostics-deps", connectionId, resource: "sellingFormats" } }),
        supabase.functions.invoke("revo-proxy", { body: { action: "fetch-diagnostics-deps", connectionId, resource: "rooms" } }),
      ]);

      const extract = (r: PromiseSettledResult<any>) =>
        r.status === "fulfilled" && r.value?.data?.items ? r.value.data.items : [];

      const groups = extract(results[0]);
      const categories = extract(results[1]);
      const taxes = extract(results[2]);
      const sellingFormats = extract(results[3]);
      const rooms = extract(results[4]);

      const warnings: { area: string; message: string }[] = [];

      if (groups.length === 0) warnings.push({ area: "Groups", message: "No groups detected. Items need categories that belong to groups." });
      if (categories.length === 0) warnings.push({ area: "Categories", message: "No categories detected. Items cannot be created without a category." });
      if (taxes.length === 0) warnings.push({ area: "Taxes", message: "No tax rates detected. Items require a VAT/tax assignment for invoicing." });
      if (sellingFormats.length === 0) warnings.push({ area: "Selling Formats", message: "No selling formats detected. Items will use the default format." });

      // Check for orphaned categories (no group)
      const orphaned = categories.filter((c: any) => !c.group_id);
      if (orphaned.length > 0) {
        warnings.push({ area: "Categories", message: `${orphaned.length} categor${orphaned.length === 1 ? "y has" : "ies have"} no parent group — items in them won't appear in POS menus.` });
      }

      setDiag({ groups, categories, taxes, sellingFormats, rooms, warnings, fetchedAt: new Date().toISOString() });
      setStatus("done");
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }, [connectionId]);

  if (!connectionId) return null;

  const indicator = (count: number, required: boolean) => {
    if (count > 0) return <Badge variant="default" className="text-[10px] gap-1 bg-success/15 text-success border-success/30"><CheckCircle2 className="h-2.5 w-2.5" />{count}</Badge>;
    if (required) return <Badge variant="destructive" className="text-[10px] gap-1"><XCircle className="h-2.5 w-2.5" />Missing</Badge>;
    return <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/40 text-amber-600"><AlertTriangle className="h-2.5 w-2.5" />None</Badge>;
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Layers className="h-4 w-4 text-primary" /> Dependency Diagnostics
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Live view of catalog dependencies required before pushing products to Revo.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={fetchDiagnostics} disabled={status === "loading"}>
          {status === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <span className="ml-1.5 text-xs">{status === "idle" ? "Scan" : "Refresh"}</span>
        </Button>
      </div>

      {/* Last catalog sync */}
      {lastCatalogSync && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          Last catalog sync: {new Date(lastCatalogSync).toLocaleString()}
        </div>
      )}

      {status === "error" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
          <XCircle className="h-3.5 w-3.5 inline mr-1.5" />
          Failed to fetch diagnostics: {error}
        </div>
      )}

      {diag && (
        <>
          {/* Summary grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <DepCard icon={<Layers className="h-3.5 w-3.5" />} label="Groups" badge={indicator(diag.groups.length, true)} items={diag.groups.map(g => g.name)} />
            <DepCard icon={<Tag className="h-3.5 w-3.5" />} label="Categories" badge={indicator(diag.categories.length, true)} items={diag.categories.map(c => c.name)} />
            <DepCard icon={<DollarSign className="h-3.5 w-3.5" />} label="Tax Rates" badge={indicator(diag.taxes.length, true)} items={diag.taxes.map(t => `${t.percentage}%${t.name ? ` (${t.name})` : ""}`)} />
            <DepCard icon={<ShoppingBag className="h-3.5 w-3.5" />} label="Selling Formats" badge={indicator(diag.sellingFormats.length, false)} items={diag.sellingFormats.map(f => f.name)} />
            <DepCard icon={<MapPin className="h-3.5 w-3.5" />} label="Rooms" badge={indicator(diag.rooms.length, false)} items={diag.rooms.map(r => r.name)} />
          </div>

          {/* Warnings */}
          {diag.warnings.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-foreground flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-amber-500" /> {diag.warnings.length} warning{diag.warnings.length > 1 ? "s" : ""}
              </p>
              {diag.warnings.map((w, i) => (
                <div key={i} className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px]">
                  <span className="font-medium text-amber-600">[{w.area}]</span>{" "}
                  <span className="text-foreground">{w.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* All clear */}
          {diag.warnings.length === 0 && diag.groups.length > 0 && diag.categories.length > 0 && diag.taxes.length > 0 && (
            <div className="rounded-md border border-success/30 bg-success/5 p-2.5 text-xs text-success flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" />
              All required dependencies present — writes are safe to proceed.
            </div>
          )}

          <p className="text-[10px] text-muted-foreground text-right">
            Scanned at {new Date(diag.fetchedAt).toLocaleTimeString()}
          </p>
        </>
      )}

      {status === "idle" && (
        <div className="rounded-md border border-border bg-secondary/20 p-3 text-center text-xs text-muted-foreground">
          Click <strong>Scan</strong> to fetch live dependency data from Revo's Catalog API.
        </div>
      )}
    </div>
  );
}

function DepCard({ icon, label, badge, items }: { icon: React.ReactNode; label: string; badge: React.ReactNode; items: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const displayItems = expanded ? items : items.slice(0, 4);

  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-2.5 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-foreground flex items-center gap-1">{icon}{label}</span>
        {badge}
      </div>
      {items.length > 0 && (
        <div className="space-y-0.5">
          {displayItems.map((item, i) => (
            <p key={i} className="text-[10px] text-muted-foreground truncate" title={item}>{item}</p>
          ))}
          {items.length > 4 && (
            <button onClick={() => setExpanded(!expanded)} className="text-[10px] text-primary hover:underline">
              {expanded ? "Show less" : `+${items.length - 4} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
