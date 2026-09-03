import { useState, useEffect, useCallback } from "react";
import { CheckCircle2, XCircle, Loader2, ChevronDown, Upload, Wine, Tag, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";

interface WinerimWine {
  id: string;
  winerim_id: string;
  name: string;
  wine_type: string | null;
  bottle_sale_price: number | null;
  glass_sale_price: number | null;
  format: string | null;
  serve_by_glass: boolean;
  is_active: boolean;
}

interface RevoCategory {
  id: string;
  name: string;
  group_name?: string;
}

export default function RevoPushPanel({ connectionId }: { connectionId: string | null }) {
  const [wines, setWines] = useState<WinerimWine[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<RevoCategory[]>([]);
  const [categoryOverride, setCategoryOverride] = useState<string>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ queued: number } | null>(null);
  const [loadingCats, setLoadingCats] = useState(false);

  // Load wines
  useEffect(() => {
    if (!connectionId) return;
    setLoading(true);
    supabase
      .from("winerim_wines")
      .select("id, winerim_id, name, wine_type, bottle_sale_price, glass_sale_price, format, serve_by_glass, is_active")
      .eq("connection_id", connectionId)
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => {
        setWines((data as WinerimWine[]) || []);
        setLoading(false);
      });
  }, [connectionId]);

  // Load Revo categories for override
  useEffect(() => {
    if (!connectionId) return;
    setLoadingCats(true);
    supabase.functions.invoke("revo-proxy", {
      body: { action: "fetch-diagnostics-deps", connectionId, resource: "categories" },
    }).then(({ data }) => {
      const cats: RevoCategory[] = (data?.items || []).map((c: any) => ({
        id: String(c.id),
        name: String(c.name),
      }));
      // Also fetch groups to enrich
      supabase.functions.invoke("revo-proxy", {
        body: { action: "fetch-diagnostics-deps", connectionId, resource: "groups" },
      }).then(({ data: grpData }) => {
        const grpMap = new Map((grpData?.items || []).map((g: any) => [String(g.id), String(g.name)]));
        // Re-fetch categories to get group_id (the diagnostics endpoint returns it)
        cats.forEach((c: any) => {
          const raw = (data?.items || []).find((r: any) => String(r.id) === c.id);
          if (raw?.group_id) c.group_name = grpMap.get(String(raw.group_id));
        });
        setCategories(cats);
        setLoadingCats(false);
      });
    });
  }, [connectionId]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPushResult(null);
  };

  const selectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((w) => w.winerim_id)));
    }
  };

  const pushSelected = async () => {
    if (!connectionId || selectedIds.size === 0) return;
    setPushing(true);
    setPushResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: {
          action: "queue-outbound",
          connectionId,
          winerimWineIds: Array.from(selectedIds),
          categoryOverride: categoryOverride || undefined,
        },
      });
      if (error) throw error;
      setPushResult({ queued: data?.queued || 0 });
      setSelectedIds(new Set());
    } catch (e) {
      console.error("Failed to push:", e);
    } finally {
      setPushing(false);
    }
  };

  const filtered = wines.filter((w) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return w.name.toLowerCase().includes(s) || (w.wine_type || "").toLowerCase().includes(s);
  });

  // Group categories for the dropdown
  const groupedCats = new Map<string, RevoCategory[]>();
  const ungroupedCats: RevoCategory[] = [];
  for (const cat of categories) {
    if (cat.group_name) {
      if (!groupedCats.has(cat.group_name)) groupedCats.set(cat.group_name, []);
      groupedCats.get(cat.group_name)!.push(cat);
    } else {
      ungroupedCats.push(cat);
    }
  }

  if (!connectionId) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Upload className="h-4 w-4 text-primary" /> Push Wines to Revo
        </h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Select wines to queue for creation in Revo. Optionally override the target category per push.
        </p>
      </div>

      {/* Category Override */}
      {selectedIds.size > 0 && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Tag className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-foreground">Category Override</span>
            <Badge variant="outline" className="text-[10px] ml-auto">
              {selectedIds.size} wine{selectedIds.size > 1 ? "s" : ""} selected
            </Badge>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Force these wines into a specific Revo category instead of the default mapping. Leave empty to use saved mappings.
          </p>
          <div className="relative">
            <select
              value={categoryOverride}
              onChange={(e) => setCategoryOverride(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground appearance-none pr-7 cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">— Use default mapping —</option>
              {Array.from(groupedCats.entries()).map(([groupName, cats]) => (
                <optgroup key={groupName} label={groupName}>
                  {cats.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name} (ID: {cat.id})
                    </option>
                  ))}
                </optgroup>
              ))}
              {ungroupedCats.length > 0 && (
                <optgroup label="No Group">
                  {ungroupedCats.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name} (ID: {cat.id})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          </div>
          {categoryOverride && (
            <p className="text-[10px] text-primary flex items-center gap-1">
              <Tag className="h-2.5 w-2.5" />
              Override active — all selected wines will go to category {categories.find((c) => c.id === categoryOverride)?.name || categoryOverride}. This does not change saved mappings.
            </p>
          )}
        </div>
      )}

      {/* Search & select all */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            placeholder="Search wines…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-background text-xs pl-7 h-8"
          />
        </div>
        <Button size="sm" variant="ghost" onClick={selectAll} className="text-[10px] h-8">
          {selectedIds.size === filtered.length && filtered.length > 0 ? "Deselect all" : "Select all"}
        </Button>
      </div>

      {/* Wine list */}
      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : wines.length === 0 ? (
        <div className="text-center py-6 text-xs text-muted-foreground">
          No active Winerim wines found for this connection. Sync your Winerim catalog first.
        </div>
      ) : (
        <div className="max-h-[320px] overflow-y-auto space-y-1 pr-1">
          {filtered.map((wine) => {
            const selected = selectedIds.has(wine.winerim_id);
            return (
              <button
                key={wine.id}
                onClick={() => toggleSelect(wine.winerim_id)}
                className={`w-full flex items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-all ${
                  selected
                    ? "border-primary/40 bg-primary/5"
                    : "border-border bg-secondary/10 hover:border-primary/20"
                }`}
              >
                <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                  selected ? "bg-primary border-primary" : "border-muted-foreground/30"
                }`}>
                  {selected && <CheckCircle2 className="h-3 w-3 text-primary-foreground" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{wine.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {wine.wine_type && (
                      <Badge variant="outline" className="text-[9px] h-4">{wine.wine_type}</Badge>
                    )}
                    {wine.bottle_sale_price != null && wine.bottle_sale_price > 0 && (
                      <span className="text-[10px] text-muted-foreground">Bot: €{wine.bottle_sale_price}</span>
                    )}
                    {wine.serve_by_glass && wine.glass_sale_price != null && wine.glass_sale_price > 0 && (
                      <span className="text-[10px] text-muted-foreground">Copa: €{wine.glass_sale_price}</span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && search && (
            <p className="text-center text-xs text-muted-foreground py-4">No wines match "{search}"</p>
          )}
        </div>
      )}

      {/* Push button */}
      <div className="flex items-center gap-3">
        <Button
          onClick={pushSelected}
          disabled={pushing || selectedIds.size === 0}
          size="sm"
        >
          {pushing ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Upload className="mr-1.5 h-3 w-3" />}
          Push {selectedIds.size} Wine{selectedIds.size !== 1 ? "s" : ""} to Revo
        </Button>
        {pushResult && (
          <span className="text-xs text-success flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" /> {pushResult.queued} queued
          </span>
        )}
      </div>
    </div>
  );
}
