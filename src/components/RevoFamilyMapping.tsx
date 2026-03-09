import { useState, useEffect, useCallback } from "react";
import { CheckCircle2, XCircle, Loader2, Wine, GlassWater, Sparkles, Grape, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

const MAPPING_KEYS = [
  { key: "bottle_red", label: "Bottle – Red", icon: "🍷" },
  { key: "bottle_white", label: "Bottle – White", icon: "🥂" },
  { key: "bottle_rose", label: "Bottle – Rosé", icon: "🌸" },
  { key: "bottle_sparkling", label: "Bottle – Sparkling", icon: "✨" },
  { key: "bottle_fortified", label: "Bottle – Fortified", icon: "🏺" },
  { key: "bottle_dessert", label: "Bottle – Dessert", icon: "🍯" },
  { key: "glass", label: "Glass (Copa)", icon: "🍷" },
  { key: "magnum", label: "Magnum", icon: "🍾" },
] as const;

interface RevoCategory {
  id: string;
  name: string;
  group_id?: string;
  group_name?: string;
}

interface MappingRow {
  mapping_key: string;
  revo_category_id: string | null;
  revo_category_name: string | null;
  revo_group_name: string | null;
}

export default function RevoFamilyMapping({ connectionId }: { connectionId: string | null }) {
  const [categories, setCategories] = useState<RevoCategory[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fetchingCatalog, setFetchingCatalog] = useState(false);

  // Load existing mappings from DB
  useEffect(() => {
    if (!connectionId) return;
    supabase
      .from("wine_type_family_mappings")
      .select("*")
      .eq("connection_id", connectionId)
      .then(({ data }) => {
        if (data && data.length > 0) {
          setMappings(
            MAPPING_KEYS.map((mk) => {
              const existing = data.find((d) => d.mapping_key === mk.key);
              return {
                mapping_key: mk.key,
                revo_category_id: existing?.agora_family_id || null,
                revo_category_name: existing?.agora_family_name || null,
                revo_group_name: null,
              };
            })
          );
        } else {
          setMappings(MAPPING_KEYS.map((mk) => ({
            mapping_key: mk.key,
            revo_category_id: null,
            revo_category_name: null,
            revo_group_name: null,
          })));
        }
      });
  }, [connectionId]);

  // Fetch Revo categories & groups
  const fetchCatalogDeps = useCallback(async () => {
    if (!connectionId) return;
    setFetchingCatalog(true);
    try {
      const [catResult, grpResult] = await Promise.all([
        supabase.functions.invoke("revo-proxy", {
          body: { action: "fetch-diagnostics-deps", connectionId, resource: "categories" },
        }),
        supabase.functions.invoke("revo-proxy", {
          body: { action: "fetch-diagnostics-deps", connectionId, resource: "groups" },
        }),
      ]);

      const cats: RevoCategory[] = (catResult.data?.items || []).map((c: any) => ({
        id: String(c.id),
        name: String(c.name),
        group_id: c.group_id ? String(c.group_id) : undefined,
      }));
      const grps: { id: string; name: string }[] = (grpResult.data?.items || []).map((g: any) => ({
        id: String(g.id),
        name: String(g.name),
      }));

      // Enrich categories with group names
      const grpMap = new Map(grps.map((g) => [g.id, g.name]));
      cats.forEach((c) => {
        if (c.group_id) c.group_name = grpMap.get(c.group_id);
      });

      setCategories(cats);
      setGroups(grps);
    } catch (e) {
      console.error("Failed to fetch Revo catalog deps:", e);
    } finally {
      setFetchingCatalog(false);
    }
  }, [connectionId]);

  // Auto-fetch on mount if no categories loaded
  useEffect(() => {
    if (connectionId && categories.length === 0) fetchCatalogDeps();
  }, [connectionId]);

  const updateMapping = (key: string, categoryId: string | null) => {
    const cat = categories.find((c) => c.id === categoryId);
    setMappings((prev) =>
      prev.map((m) =>
        m.mapping_key === key
          ? {
              ...m,
              revo_category_id: categoryId,
              revo_category_name: cat?.name || null,
              revo_group_name: cat?.group_name || null,
            }
          : m
      )
    );
    setSaved(false);
  };

  const saveMappings = async () => {
    if (!connectionId) return;
    setSaving(true);
    setSaved(false);

    try {
      // Delete existing mappings for this connection
      await supabase
        .from("wine_type_family_mappings")
        .delete()
        .eq("connection_id", connectionId);

      // Insert new mappings (only those with a selection)
      const rows = mappings
        .filter((m) => m.revo_category_id)
        .map((m) => ({
          connection_id: connectionId,
          mapping_key: m.mapping_key,
          agora_family_id: m.revo_category_id,
          agora_family_name: m.revo_category_name,
        }));

      if (rows.length > 0) {
        const { error } = await supabase.from("wine_type_family_mappings").insert(rows);
        if (error) throw error;
      }

      setSaved(true);
    } catch (e) {
      console.error("Failed to save mappings:", e);
    } finally {
      setSaving(false);
    }
  };

  const mappedCount = mappings.filter((m) => m.revo_category_id).length;

  if (!connectionId) return null;

  // Group categories by their group for the dropdown
  const groupedCategories = new Map<string, RevoCategory[]>();
  const ungrouped: RevoCategory[] = [];
  for (const cat of categories) {
    const groupLabel = cat.group_name || (cat.group_id ? `Group ${cat.group_id}` : "");
    if (groupLabel) {
      if (!groupedCategories.has(groupLabel)) groupedCategories.set(groupLabel, []);
      groupedCategories.get(groupLabel)!.push(cat);
    } else {
      ungrouped.push(cat);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Wine className="h-4 w-4 text-primary" /> Wine Type → Revo Category Mapping
          </h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Map each Winerim product type to a Revo category. This determines where items are created in the POS.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {mappedCount}/{MAPPING_KEYS.length} mapped
          </Badge>
          <Button size="sm" variant="outline" onClick={fetchCatalogDeps} disabled={fetchingCatalog}>
            {fetchingCatalog ? <Loader2 className="h-3 w-3 animate-spin" /> : "Reload"}
          </Button>
        </div>
      </div>

      {categories.length === 0 && !fetchingCatalog && (
        <div className="rounded-md border border-border bg-secondary/20 p-3 text-center text-xs text-muted-foreground">
          No Revo categories loaded. Click <strong>Reload</strong> or run a Catalog Sync first.
        </div>
      )}

      {fetchingCatalog && (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading Revo categories…
        </div>
      )}

      {categories.length > 0 && (
        <div className="space-y-1.5">
          {MAPPING_KEYS.map((mk) => {
            const mapping = mappings.find((m) => m.mapping_key === mk.key);
            const hasMapping = !!mapping?.revo_category_id;

            return (
              <div
                key={mk.key}
                className={`flex items-center gap-3 rounded-lg border p-2.5 transition-colors ${
                  hasMapping
                    ? "border-success/30 bg-success/5"
                    : "border-border bg-secondary/10"
                }`}
              >
                {/* Wine type label */}
                <div className="flex items-center gap-2 min-w-[170px]">
                  <span className="text-base">{mk.icon}</span>
                  <span className="text-xs font-medium text-foreground">{mk.label}</span>
                </div>

                {/* Arrow */}
                <span className="text-muted-foreground text-xs">→</span>

                {/* Category selector */}
                <div className="flex-1 relative">
                  <select
                    value={mapping?.revo_category_id || ""}
                    onChange={(e) => updateMapping(mk.key, e.target.value || null)}
                    className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground appearance-none pr-7 cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="">— Not mapped —</option>
                    {Array.from(groupedCategories.entries()).map(([groupName, cats]) => (
                      <optgroup key={groupName} label={groupName}>
                        {cats.map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.name} (ID: {cat.id})
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    {ungrouped.length > 0 && (
                      <optgroup label="No Group">
                        {ungrouped.map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.name} (ID: {cat.id})
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                </div>

                {/* Status indicator */}
                <div className="w-5 flex justify-center">
                  {hasMapping ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-muted-foreground/40" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Save */}
      {categories.length > 0 && (
        <div className="flex items-center gap-3">
          <Button onClick={saveMappings} disabled={saving} size="sm">
            {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3 w-3" />}
            Save Mappings
          </Button>
          {saved && (
            <span className="text-xs text-success flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Saved
            </span>
          )}
          {mappedCount < MAPPING_KEYS.length && (
            <span className="text-[10px] text-muted-foreground">
              Unmapped types will use the connection's default category.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
