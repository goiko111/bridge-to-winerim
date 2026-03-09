import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { CheckCircle2, Loader2, Save, Wine, GlassWater, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";

/** The fixed set of wine type + format mapping keys */
const MAPPING_KEYS = [
  { key: "bottle_red", label: "Botella Tinto", icon: "🍷" },
  { key: "bottle_white", label: "Botella Blanco", icon: "🥂" },
  { key: "bottle_rose", label: "Botella Rosado", icon: "🌸" },
  { key: "bottle_sparkling", label: "Botella Espumoso", icon: "🍾" },
  { key: "bottle_fortified", label: "Botella Fortificado", icon: "🏺" },
  { key: "bottle_dessert", label: "Botella Postre", icon: "🍯" },
  { key: "glass", label: "Copa", icon: "🥃" },
  { key: "magnum", label: "Magnum", icon: "🍾" },
] as const;

interface BdpFamily {
  id: string;
  name: string;
}

interface MappingRow {
  key: string;
  bdpFamilyId: string;
  bdpFamilyName: string;
  saved: boolean;
}

export default function BdpFamilyMapping({
  connectionId,
  availableFamilies,
}: {
  connectionId: string | null;
  availableFamilies: BdpFamily[];
}) {
  const [mappings, setMappings] = useState<MappingRow[]>(
    MAPPING_KEYS.map((mk) => ({ key: mk.key, bdpFamilyId: "", bdpFamilyName: "", saved: false }))
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load existing mappings
  const loadMappings = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from("wine_type_family_mappings")
        .select("*")
        .eq("connection_id", connectionId);

      if (data && data.length > 0) {
        setMappings((prev) =>
          prev.map((m) => {
            const existing = data.find((d) => d.mapping_key === m.key);
            if (existing) {
              return {
                ...m,
                bdpFamilyId: existing.agora_family_id || "",
                bdpFamilyName: existing.agora_family_name || "",
                saved: true,
              };
            }
            return m;
          })
        );
      }
    } catch (e) {
      console.error("Failed to load BDP family mappings:", e);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    loadMappings();
  }, [loadMappings]);

  const handleFamilyChange = (key: string, familyId: string) => {
    const family = availableFamilies.find((f) => f.id === familyId);
    setMappings((prev) =>
      prev.map((m) =>
        m.key === key
          ? { ...m, bdpFamilyId: familyId, bdpFamilyName: family?.name || "", saved: false }
          : m
      )
    );
  };

  const handleSaveAll = async () => {
    if (!connectionId) return;
    setSaving(true);
    try {
      const dirtyMappings = mappings.filter((m) => m.bdpFamilyId);

      for (const m of dirtyMappings) {
        await supabase.from("wine_type_family_mappings").upsert(
          {
            connection_id: connectionId,
            mapping_key: m.key,
            agora_family_id: m.bdpFamilyId,
            agora_family_name: m.bdpFamilyName,
          } as any,
          { onConflict: "connection_id,mapping_key" }
        );
      }

      setMappings((prev) =>
        prev.map((m) => (m.bdpFamilyId ? { ...m, saved: true } : m))
      );

      toast({ title: "Mappings guardados", description: `${dirtyMappings.length} mapping(s) actualizados.` });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const unsavedCount = mappings.filter((m) => m.bdpFamilyId && !m.saved).length;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando mappings…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Wine className="h-3.5 w-3.5" /> Mapping de Familias por Tipo de Vino
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Asigna a qué familia/categoría de BDP va cada tipo y formato de vino. Cada restaurante puede tener categorías distintas.
        </p>
      </div>

      {availableFamilies.length === 0 && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-foreground flex items-center gap-2">
          <Sparkles className="h-3 w-3 text-amber-500 shrink-0" />
          Sincroniza el catálogo primero para obtener las familias disponibles en BDP.
        </div>
      )}

      <div className="space-y-1.5">
        {MAPPING_KEYS.map((mk) => {
          const mapping = mappings.find((m) => m.key === mk.key)!;
          return (
            <div
              key={mk.key}
              className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2"
            >
              <span className="text-base shrink-0">{mk.icon}</span>
              <span className="text-xs font-medium text-foreground w-36 shrink-0">
                {mk.label}
              </span>
              <select
                value={mapping.bdpFamilyId}
                onChange={(e) => handleFamilyChange(mk.key, e.target.value)}
                disabled={availableFamilies.length === 0}
                className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">— Sin asignar —</option>
                {availableFamilies.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name || f.id}
                  </option>
                ))}
              </select>
              <div className="w-16 flex justify-end">
                {mapping.saved && mapping.bdpFamilyId ? (
                  <Badge variant="outline" className="text-[9px] border-emerald-500/30 text-emerald-600 dark:text-emerald-400 gap-0.5">
                    <CheckCircle2 className="h-2.5 w-2.5" /> OK
                  </Badge>
                ) : mapping.bdpFamilyId ? (
                  <Badge variant="outline" className="text-[9px] border-amber-500/30 text-amber-600 dark:text-amber-400">
                    pendiente
                  </Badge>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          {mappings.filter((m) => m.bdpFamilyId).length}/{MAPPING_KEYS.length} asignados
          {unsavedCount > 0 && (
            <span className="text-amber-600 dark:text-amber-400 ml-1.5">
              · {unsavedCount} sin guardar
            </span>
          )}
        </p>
        <Button
          onClick={handleSaveAll}
          disabled={saving || unsavedCount === 0}
          size="sm"
        >
          {saving ? (
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
          ) : (
            <Save className="mr-1.5 h-3 w-3" />
          )}
          Guardar Mappings
        </Button>
      </div>
    </div>
  );
}

/**
 * Resolve the BDP family name for a given wine type + format.
 * Used by write logic to apply the correct family/department.
 */
export async function resolveBdpFamily(
  connectionId: string,
  wineType?: string,
  format?: string
): Promise<string | null> {
  // Build the mapping key from wine type + format
  let key = "";
  const fmt = (format || "").toLowerCase();
  const type = (wineType || "").toLowerCase();

  if (fmt === "glass" || fmt === "copa") {
    key = "glass";
  } else if (fmt === "magnum") {
    key = "magnum";
  } else {
    // Bottle by wine type
    if (type.includes("tinto") || type.includes("red")) key = "bottle_red";
    else if (type.includes("blanco") || type.includes("white")) key = "bottle_white";
    else if (type.includes("rosado") || type.includes("rosé") || type.includes("rose")) key = "bottle_rose";
    else if (type.includes("espumoso") || type.includes("sparkling") || type.includes("cava") || type.includes("champagne")) key = "bottle_sparkling";
    else if (type.includes("fortificado") || type.includes("fortified") || type.includes("jerez") || type.includes("sherry") || type.includes("porto") || type.includes("port")) key = "bottle_fortified";
    else if (type.includes("postre") || type.includes("dessert") || type.includes("dulce") || type.includes("sweet")) key = "bottle_dessert";
    else key = "bottle_red"; // fallback
  }

  if (!key) return null;

  const { data } = await supabase
    .from("wine_type_family_mappings")
    .select("agora_family_name")
    .eq("connection_id", connectionId)
    .eq("mapping_key", key)
    .single();

  return data?.agora_family_name || null;
}
