import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Loader2, CheckCircle2, Globe, MapPin, SlidersHorizontal, Eye, Search,
  RefreshCw, Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

/* ── Types ── */
export interface GeographicFamilyConfig {
  family_naming_mode: "GEOGRAPHIC_FAMILIES";
  region_threshold: number;
  selected_regions: string[]; // manually selected regions that always get their own family
  excluded_regions: string[]; // manually excluded regions that never get their own family
  hierarchy_mode?: "FLAT" | "HIERARCHICAL"; // FLAT = all at root; HIERARCHICAL = Type > Country > Region
}

interface RegionStats {
  wine_type: string;
  country: string;
  region: string;
  count: number;
}

interface PreviewFamily {
  name: string;
  count: number;
  type: string;
  country: string;
  region: string | null;
  isGrouped: boolean;
}

interface Props {
  connectionId: string | null;
  config: GeographicFamilyConfig | null;
  onConfigChange: (config: GeographicFamilyConfig) => void;
}

/* ── Country code to name map ── */
const COUNTRY_NAMES: Record<string, string> = {
  ES: "España", FR: "Francia", IT: "Italia", PT: "Portugal", DE: "Alemania",
  AT: "Austria", CH: "Suiza", GR: "Grecia", US: "EEUU", AR: "Argentina",
  CL: "Chile", AU: "Australia", NZ: "Nueva Zelanda", ZA: "Sudáfrica",
  GB: "Reino Unido", HU: "Hungría", GE: "Georgia", LB: "Líbano",
  IL: "Israel", AM: "Armenia", RO: "Rumanía", SI: "Eslovenia",
  HR: "Croacia", MX: "México", UY: "Uruguay", BR: "Brasil",
  CN: "China", JP: "Japón",
};

const TYPE_LABELS: Record<string, string> = {
  tinto: "TINTO", blanco: "BLANCO", rosado: "ROSADO",
  espumoso: "ESPUMOSO", fortificado: "FORTIFICADO",
  postre: "DULCE", dulce: "DULCE",
};

function countryName(code: string): string {
  return COUNTRY_NAMES[code] || code;
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type?.toLowerCase()] || (type || "OTROS").toUpperCase();
}

export function buildGeographicFamilyName(wineType: string, country: string, region: string | null, isTopRegion: boolean): string {
  const tLabel = typeLabel(wineType);
  const cName = countryName(country);
  if (isTopRegion && region) {
    return `${tLabel} - ${region}`;
  }
  return `${tLabel} - ${cName} (Otras)`;
}

/* ══════════════════════════════════════════════
   Geographic Family Configuration Panel
   ══════════════════════════════════════════════ */
export default function AgoraGeographicFamilies({ connectionId, config, onConfigChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [regionStats, setRegionStats] = useState<RegionStats[]>([]);
  const [threshold, setThreshold] = useState(config?.region_threshold ?? 10);
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set(config?.selected_regions || []));
  const [excludedRegions, setExcludedRegions] = useState<Set<string>>(new Set(config?.excluded_regions || []));
  const [hierarchyMode, setHierarchyMode] = useState<"FLAT" | "HIERARCHICAL">(config?.hierarchy_mode || "FLAT");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // Load region stats from DB
  const loadRegionStats = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    try {
      // Fetch all wines with their type, country, region
      const PAGE_SIZE = 1000;
      const allWines: any[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("winerim_wines")
          .select("wine_type, raw_payload")
          .eq("connection_id", connectionId)
          .eq("is_active", true)
          .range(from, from + PAGE_SIZE - 1);
        if (error || !data || data.length === 0) break;
        allWines.push(...data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      // Aggregate by type + country + region
      const statsMap = new Map<string, RegionStats>();
      for (const w of allWines) {
        const raw = (w.raw_payload || {}) as Record<string, any>;
        const wineType = (w.wine_type || "otros").toLowerCase();
        const country = (raw.country || "XX") as string;
        const region = (raw.region || "Sin región") as string;
        const key = `${wineType}|${country}|${region}`;
        const existing = statsMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          statsMap.set(key, { wine_type: wineType, country, region, count: 1 });
        }
      }
      setRegionStats(Array.from(statsMap.values()).sort((a, b) => b.count - a.count));
    } catch (err) {
      console.error("Error loading region stats:", err);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { loadRegionStats(); }, [loadRegionStats]);

  // Compute unique regions with total count (across all types)
  const regionTotals = useMemo(() => {
    const map = new Map<string, { country: string; region: string; total: number }>();
    for (const s of regionStats) {
      const key = `${s.country}|${s.region}`;
      const existing = map.get(key);
      if (existing) {
        existing.total += s.count;
      } else {
        map.set(key, { country: s.country, region: s.region, total: s.count });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [regionStats]);

  // Determine which regions are "top" based on threshold + manual selections
  const topRegionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of regionTotals) {
      const key = `${r.country}|${r.region}`;
      if (excludedRegions.has(key)) continue;
      if (r.total >= threshold || selectedRegions.has(key)) {
        keys.add(key);
      }
    }
    return keys;
  }, [regionTotals, threshold, selectedRegions, excludedRegions]);

  // Preview families (flat or hierarchical)
  const previewFamilies = useMemo(() => {
    if (hierarchyMode === "HIERARCHICAL") {
      // Build 3-level tree: Type > Country > Region/Otras
      const tree = new Map<string, { count: number; countries: Map<string, { count: number; regions: Map<string, number> }> }>();
      for (const s of regionStats) {
        const regionKey = `${s.country}|${s.region}`;
        const isTop = topRegionKeys.has(regionKey);
        const tLabel = TYPE_LABELS[s.wine_type?.toLowerCase()] || (s.wine_type || "OTROS").toUpperCase();
        const typeName = `${tLabel} WINERIM`;
        const cName = countryName(s.country);

        if (!tree.has(typeName)) tree.set(typeName, { count: 0, countries: new Map() });
        const typeNode = tree.get(typeName)!;
        typeNode.count += s.count;

        const countryKey = `${tLabel} ${cName}`;
        if (!typeNode.countries.has(countryKey)) typeNode.countries.set(countryKey, { count: 0, regions: new Map() });
        const countryNode = typeNode.countries.get(countryKey)!;
        countryNode.count += s.count;

        const regionLabel = isTop ? s.region : "Otras";
        countryNode.regions.set(regionLabel, (countryNode.regions.get(regionLabel) || 0) + s.count);
      }
      return { mode: "HIERARCHICAL" as const, tree };
    }
    // FLAT mode
    const familyMap = new Map<string, PreviewFamily>();
    for (const s of regionStats) {
      const regionKey = `${s.country}|${s.region}`;
      const isTop = topRegionKeys.has(regionKey);
      const familyName = buildGeographicFamilyName(s.wine_type, s.country, s.region, isTop);
      const existing = familyMap.get(familyName);
      if (existing) {
        existing.count += s.count;
      } else {
        familyMap.set(familyName, {
          name: familyName,
          count: s.count,
          type: s.wine_type,
          country: s.country,
          region: isTop ? s.region : null,
          isGrouped: !isTop,
        });
      }
    }
    return { mode: "FLAT" as const, families: Array.from(familyMap.values()).sort((a, b) => a.name.localeCompare(b.name, "es")) };
  }, [regionStats, topRegionKeys, hierarchyMode]);

  // Save config
  const saveConfig = async () => {
    if (!connectionId) return;
    setSaving(true);
    try {
      const { data: conn } = await supabase
        .from("pos_connections")
        .select("provider_config")
        .eq("id", connectionId)
        .single();
      const currentConfig = (conn?.provider_config as Record<string, unknown>) || {};
      const geoConfig: GeographicFamilyConfig = {
        family_naming_mode: "GEOGRAPHIC_FAMILIES" as const,
        region_threshold: threshold,
        selected_regions: Array.from(selectedRegions),
        excluded_regions: Array.from(excludedRegions),
        hierarchy_mode: hierarchyMode,
      };
      await supabase
        .from("pos_connections")
        .update({
          provider_config: {
            ...currentConfig,
            family_structure_mode: "GEOGRAPHIC_FAMILIES",
            geographic_config: geoConfig as unknown as Record<string, unknown>,
          } as unknown as import("@/integrations/supabase/types").Json,
        })
        .eq("id", connectionId);
      onConfigChange(geoConfig);
      toast({ title: "Geographic config saved", description: `${previewFamilies.length} families configured.` });
    } catch (err: any) {
      toast({ title: "Error saving", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const toggleRegion = (key: string) => {
    const newSelected = new Set(selectedRegions);
    const newExcluded = new Set(excludedRegions);
    const regionTotal = regionTotals.find(r => `${r.country}|${r.region}` === key);
    const isAutoTop = (regionTotal?.total ?? 0) >= threshold;

    if (isAutoTop) {
      // If it's auto-top, clicking it excludes it
      if (newExcluded.has(key)) {
        newExcluded.delete(key);
      } else {
        newExcluded.add(key);
      }
    } else {
      // If it's below threshold, clicking it manually includes it
      if (newSelected.has(key)) {
        newSelected.delete(key);
      } else {
        newSelected.add(key);
      }
    }
    setSelectedRegions(newSelected);
    setExcludedRegions(newExcluded);
  };

  const filteredRegions = useMemo(() => {
    if (!search) return regionTotals;
    const q = search.toLowerCase();
    return regionTotals.filter(r =>
      r.region.toLowerCase().includes(q) ||
      countryName(r.country).toLowerCase().includes(q) ||
      r.country.toLowerCase().includes(q)
    );
  }, [regionTotals, search]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Loading geographic data…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Globe className="h-3.5 w-3.5 text-primary" />
        <p className="text-xs font-medium text-foreground">Geographic Family Configuration</p>
        <Badge variant="outline" className="text-[9px] ml-auto">
          {previewFamilies.length} familias · {topRegionKeys.size} regiones top
        </Badge>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Las familias se generan automáticamente como "TIPO - Región" para las regiones principales 
        y "TIPO - País (Otras)" para el resto. Ajusta el umbral mínimo o selecciona regiones manualmente.
      </p>

      {/* Threshold slider */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-3 w-3 text-muted-foreground" />
          <label className="text-[11px] font-medium text-foreground">Umbral mínimo de vinos por región</label>
          <span className="text-[11px] font-mono text-primary ml-auto">≥ {threshold}</span>
        </div>
        <div className="flex gap-1.5">
          {[3, 5, 8, 10, 15, 20].map(t => (
            <button
              key={t}
              onClick={() => setThreshold(t)}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-all ${
                threshold === t
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Region checklist */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <MapPin className="h-3 w-3 text-muted-foreground" />
          <label className="text-[11px] font-medium text-foreground">Regiones ({regionTotals.length})</label>
          <div className="ml-auto flex-1 max-w-[200px]">
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar región…"
              className="h-6 text-[10px]"
            />
          </div>
        </div>
        <div className="max-h-[280px] overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {filteredRegions.map(r => {
            const key = `${r.country}|${r.region}`;
            const isTop = topRegionKeys.has(key);
            const isAutoTop = r.total >= threshold && !excludedRegions.has(key);
            const isManual = selectedRegions.has(key);
            const isExcluded = excludedRegions.has(key);

            return (
              <button
                key={key}
                onClick={() => toggleRegion(key)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-all hover:bg-accent/50 ${
                  isTop ? "bg-primary/5" : ""
                } ${isExcluded ? "opacity-50" : ""}`}
              >
                <Switch
                  checked={isTop}
                  className="scale-75 pointer-events-none"
                />
                <span className="text-[11px] text-foreground flex-1 truncate">
                  {r.region}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {countryName(r.country)}
                </span>
                <Badge variant={isTop ? "default" : "secondary"} className="text-[9px] shrink-0">
                  {r.total}
                </Badge>
                {isManual && <Badge variant="outline" className="text-[8px]">manual</Badge>}
                {isExcluded && <Badge variant="destructive" className="text-[8px]">excl.</Badge>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Preview */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Eye className="h-3 w-3 text-muted-foreground" />
          <label className="text-[11px] font-medium text-foreground">
            Preview de familias ({previewFamilies.length})
          </label>
        </div>
        <div className="max-h-[200px] overflow-y-auto rounded-lg border border-border bg-card p-2 space-y-0.5">
          {previewFamilies.map(f => (
            <div key={f.name} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/30">
              <span className={`text-[11px] font-medium ${f.isGrouped ? "text-muted-foreground" : "text-foreground"}`}>
                {f.name}
              </span>
              <Badge variant="secondary" className="text-[9px] ml-auto">{f.count} vinos</Badge>
            </div>
          ))}
        </div>
      </div>

      {/* Full wine-level preview */}
      <details className="space-y-2">
        <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground flex items-center gap-1.5 hover:text-foreground transition-colors">
          <Search className="h-3 w-3" />
          Ver detalle completo: cada vino → familia asignada
        </summary>
        <div className="mt-2 max-h-[300px] overflow-y-auto rounded-lg border border-border bg-card divide-y divide-border">
          {previewFamilies.map(family => (
            <div key={family.name} className="p-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] font-semibold text-foreground">{family.name}</span>
                <Badge variant="outline" className="text-[9px]">{family.count}</Badge>
              </div>
              <div className="pl-3 space-y-0.5">
                {regionStats
                  .filter(s => {
                    const regionKey = `${s.country}|${s.region}`;
                    const isTop = topRegionKeys.has(regionKey);
                    const fName = buildGeographicFamilyName(s.wine_type, s.country, s.region, isTop);
                    return fName === family.name;
                  })
                  .map(s => (
                    <div key={`${s.wine_type}|${s.country}|${s.region}`} className="text-[10px] text-muted-foreground">
                      {countryName(s.country)} · {s.region} · <span className="capitalize">{s.wine_type}</span> ({s.count})
                    </div>
                  ))
                }
              </div>
            </div>
          ))}
        </div>
      </details>

      {/* Save button */}
      <div className="flex gap-2">
        <Button size="sm" onClick={saveConfig} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
          Guardar configuración geográfica
        </Button>
        <Button variant="outline" size="sm" onClick={loadRegionStats}>
          <RefreshCw className="mr-2 h-4 w-4" /> Recargar datos
        </Button>
      </div>
    </div>
  );
}
