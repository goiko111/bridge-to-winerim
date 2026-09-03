import { useState, useEffect, useCallback } from "react";
import {
  Loader2, CheckCircle2, XCircle, AlertTriangle, Grape, RefreshCw, Plus, HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import type { AgoraMasterItem } from "@/hooks/useAgoraMasterData";

interface FamilyMapping {
  mapping_key: string;
  agora_family_id: string | null;
  agora_family_name: string | null;
}

const MAPPING_LABELS: Record<string, string> = {
  copa: "Copa (Glass)",
  botella_tinto: "Botella Tinto",
  botella_blanco: "Botella Blanco",
  botella_rosado: "Botella Rosado",
  botella_espumoso: "Botella Espumoso",
  botella_fortificado: "Botella Fortificado",
  botella_dulce: "Botella Dulce",
  magnum: "Magnum",
};

const MAPPING_KEYS = Object.keys(MAPPING_LABELS);

interface Props {
  connectionId: string | null;
  families: AgoraMasterItem[];
  onSyncMasterData: () => void | Promise<any>;
  syncing: boolean;
}

export default function PilotFamiliesPanel({ connectionId, families, onSyncMasterData, syncing }: Props) {
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<{
    created: { id: string; name: string; key: string }[];
    reused: { id: string; name: string; key: string }[];
    error: string | null;
  } | null>(null);
  const [mappings, setMappings] = useState<FamilyMapping[]>([]);
  const [loadingMappings, setLoadingMappings] = useState(false);

  const loadMappings = useCallback(async () => {
    if (!connectionId) return;
    setLoadingMappings(true);
    const { data } = await supabase
      .from("wine_type_family_mappings")
      .select("mapping_key, agora_family_id, agora_family_name")
      .eq("connection_id", connectionId);
    if (data) setMappings(data as FamilyMapping[]);
    setLoadingMappings(false);
  }, [connectionId]);

  useEffect(() => { loadMappings(); }, [loadMappings]);

  const createPilotFamilies = async () => {
    if (!connectionId) return;
    setCreating(true);
    setCreateResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "create-pilot-families", connectionId },
      });
      if (error) throw error;
      setCreateResult({
        created: data?.created || [],
        reused: data?.reused || [],
        error: data?.error || null,
      });
      if (data?.success) {
        toast({ title: "Pilot families created", description: `${data.created?.length || 0} created, ${data.reused?.length || 0} reused.` });
        // Refresh master data and mappings
        await onSyncMasterData();
        await loadMappings();
      } else {
        toast({ title: "Error creating families", description: data?.error || "Unknown error", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const updateMapping = async (mappingKey: string, familyId: string, familyName: string) => {
    if (!connectionId) return;
    await supabase.from("wine_type_family_mappings").upsert({
      connection_id: connectionId,
      mapping_key: mappingKey,
      agora_family_id: familyId || null,
      agora_family_name: familyName || null,
    }, { onConflict: "connection_id,mapping_key" } as any);
    setMappings(prev => {
      const existing = prev.find(m => m.mapping_key === mappingKey);
      if (existing) {
        return prev.map(m => m.mapping_key === mappingKey ? { ...m, agora_family_id: familyId, agora_family_name: familyName } : m);
      }
      return [...prev, { mapping_key: mappingKey, agora_family_id: familyId, agora_family_name: familyName }];
    });
  };

  const getMappingValue = (key: string) => {
    const m = mappings.find(m => m.mapping_key === key);
    return m?.agora_family_id || "";
  };

  const hasPilotFamilies = families.some(f => f.Name.includes("WINERIM"));
  const hasAnyMapping = mappings.some(m => m.agora_family_id);

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Grape className="h-4 w-4 text-primary" />
        <p className="text-xs font-medium text-foreground">Winerim Pilot Families</p>
      </div>

      {/* Info note */}
      <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50 border border-border">
        <HelpCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[11px] text-muted-foreground">
          These families are for pilot testing so new Winerim wines do not get mixed with the customer's existing POS products. 
          Click the button below to create dedicated families in Agora, then map wine types to them.
        </p>
      </div>

      {/* Create button */}
      <div className="flex gap-2 flex-wrap items-center">
        <Button
          variant="secondary"
          size="sm"
          onClick={createPilotFamilies}
          disabled={creating || syncing}
        >
          {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          {creating ? "Creating…" : "Create Winerim Test Families"}
        </Button>
        {hasPilotFamilies && (
          <Badge variant="default" className="text-[10px] bg-emerald-600">
            <CheckCircle2 className="mr-1 h-3 w-3" /> Pilot families exist
          </Badge>
        )}
      </div>

      {/* Creation result */}
      {createResult && (
        <div className={`rounded-lg border p-3 text-xs space-y-1 ${createResult.error ? "border-destructive/30 bg-destructive/5" : "border-success/30 bg-success/5"}`}>
          {createResult.error ? (
            <p className="font-medium text-destructive flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5" /> Error: {createResult.error}
            </p>
          ) : (
            <p className="font-medium text-foreground flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" /> Pilot families ready
            </p>
          )}
          {createResult.created.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-muted-foreground">Created:</span>
              {createResult.created.map(f => (
                <Badge key={f.key} variant="outline" className="text-[10px] font-mono">{f.id}: {f.name}</Badge>
              ))}
            </div>
          )}
          {createResult.reused.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-muted-foreground">Reused:</span>
              {createResult.reused.map(f => (
                <Badge key={f.key} variant="secondary" className="text-[10px] font-mono">{f.id}: {f.name}</Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Family mapping UI */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          Wine Type → Agora Family Mapping
        </p>
        {loadingMappings ? (
          <div className="flex items-center gap-2 py-3">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Loading mappings…</span>
          </div>
        ) : (
          <div className="grid gap-2">
            {MAPPING_KEYS.map(key => (
              <div key={key} className="flex items-center gap-3">
                <span className="text-xs font-medium text-foreground w-36 shrink-0">{MAPPING_LABELS[key]}</span>
                <span className="text-muted-foreground text-xs">→</span>
                <select
                  value={getMappingValue(key)}
                  onChange={(e) => {
                    const fam = families.find(f => f.Id === e.target.value);
                    updateMapping(key, e.target.value, fam?.Name || "");
                  }}
                  className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                >
                  <option value="">Auto / Default</option>
                  {families.map(f => (
                    <option key={f.Id} value={f.Id}>{f.Id}: {f.Name}</option>
                  ))}
                </select>
                {getMappingValue(key) && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status summary */}
      {hasAnyMapping && (
        <div className="flex items-start gap-2 p-2 rounded-md bg-success/10 border border-success/20">
          <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
          <p className="text-[11px] text-success">
            {mappings.filter(m => m.agora_family_id).length} of {MAPPING_KEYS.length} wine types mapped. 
            Wines pushed from Winerim Catalog will use these family assignments.
          </p>
        </div>
      )}
    </div>
  );
}
