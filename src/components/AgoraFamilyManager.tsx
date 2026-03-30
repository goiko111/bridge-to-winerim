import { useState, useEffect, useCallback } from "react";
import {
  Loader2, CheckCircle2, XCircle, Grape, Plus, HelpCircle, Palette, Hash, Eye, EyeOff,
  RefreshCw, ShieldCheck, ArrowRight, Globe,
} from "lucide-react";
import AgoraGeographicFamilies, { type GeographicFamilyConfig } from "@/components/AgoraGeographicFamilies";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import type { AgoraMasterItem } from "@/hooks/useAgoraMasterData";

/* ── Types ── */
interface FamilyMapping {
  mapping_key: string;
  agora_family_id: string | null;
  agora_family_name: string | null;
}

export type FamilyStructureMode = "WINERIM_SEPARATE_FAMILIES" | "EXISTING_CUSTOMER_FAMILIES" | "GEOGRAPHIC_FAMILIES";

/* ── Constants ── */
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

const WINERIM_FAMILIES = [
  "COPAS WINERIM", "TINTOS WINERIM", "BLANCOS WINERIM", "ESPUMOSOS WINERIM",
  "FORTIFICADOS WINERIM", "DULCE WINERIM", "ROSADOS WINERIM", "MAGNUM WINERIM",
];

/* ── Props ── */
interface Props {
  connectionId: string | null;
  families: AgoraMasterItem[];
  onSyncMasterData: () => void | Promise<any>;
  syncing: boolean;
}

/* ══════════════════════════════════════════════
   Mode Selector
   ══════════════════════════════════════════════ */
function ModeSelector({ connectionId, mode, onModeChange }: { connectionId: string | null; mode: FamilyStructureMode; onModeChange: (m: FamilyStructureMode) => void }) {
  const [saving, setSaving] = useState(false);

  const handleChange = async (newMode: FamilyStructureMode) => {
    if (!connectionId || newMode === mode) return;
    setSaving(true);
    try {
      // Load current provider_config, merge mode
      const { data: conn } = await supabase
        .from("pos_connections")
        .select("provider_config")
        .eq("id", connectionId)
        .single();
      const currentConfig = (conn?.provider_config as Record<string, unknown>) || {};
      await supabase
        .from("pos_connections")
        .update({ provider_config: { ...currentConfig, family_structure_mode: newMode } })
        .eq("id", connectionId);
      onModeChange(newMode);
      toast({ title: "Family mode updated", description: newMode === "WINERIM_SEPARATE_FAMILIES" ? "Using dedicated WINERIM families" : "Using existing customer families" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-foreground">Family Structure Mode</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          onClick={() => handleChange("WINERIM_SEPARATE_FAMILIES")}
          disabled={saving}
          className={`rounded-lg border p-3 text-left transition-all ${
            mode === "WINERIM_SEPARATE_FAMILIES"
              ? "border-primary bg-primary/10 ring-1 ring-primary/30"
              : "border-border bg-background hover:border-primary/40"
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-foreground">Separate WINERIM Families</span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Safe rollout. Products go into dedicated "… WINERIM" families, keeping customer's existing families untouched.
          </p>
        </button>
        <button
          onClick={() => handleChange("EXISTING_CUSTOMER_FAMILIES")}
          disabled={saving}
          className={`rounded-lg border p-3 text-left transition-all ${
            mode === "EXISTING_CUSTOMER_FAMILIES"
              ? "border-primary bg-primary/10 ring-1 ring-primary/30"
              : "border-border bg-background hover:border-primary/40"
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <ArrowRight className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-foreground">Existing Customer Families</span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Map wine types directly to the customer's own Agora families (TINTOS, BLANCOS, etc.).
          </p>
        </button>
        <button
          onClick={() => handleChange("GEOGRAPHIC_FAMILIES")}
          disabled={saving}
          className={`rounded-lg border p-3 text-left transition-all ${
            mode === "GEOGRAPHIC_FAMILIES"
              ? "border-primary bg-primary/10 ring-1 ring-primary/30"
              : "border-border bg-background hover:border-primary/40"
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <Globe className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-foreground">Geographic Families</span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Auto-generate families by Type + Country/Region (e.g. "TINTO - Rioja", "BLANCO - Francia (Otras)").
          </p>
        </button>
      </div>
      {saving && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Saving…
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   Section 1: Auto Pilot Families
   ══════════════════════════════════════════════ */
function AutoPilotSection({ connectionId, families, syncing, onSyncMasterData, onMappingsChanged }: Props & { onMappingsChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<{
    created: { id: string; name: string; key: string }[];
    reused: { id: string; name: string; key: string }[];
    error: string | null;
  } | null>(null);

  const hasPilotFamilies = families.some(f => f.Name.includes("WINERIM"));
  const allPilotExist = WINERIM_FAMILIES.every(wf =>
    families.some(f => f.Name.toUpperCase() === wf.toUpperCase())
  );

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
        await onSyncMasterData();
        onMappingsChanged();
      } else {
        toast({ title: "Error creating families", description: data?.error || "Unknown error", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Grape className="h-3.5 w-3.5 text-primary" />
        <p className="text-xs font-medium text-foreground">WINERIM Families Setup</p>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Create dedicated WINERIM families in Agora (COPAS WINERIM, TINTOS WINERIM, etc.) and auto-map all wine types to them.
        Customer's existing families remain untouched.
      </p>

      {/* Status badges */}
      <div className="flex flex-wrap gap-1.5">
        {WINERIM_FAMILIES.map(wf => {
          const exists = families.some(f => f.Name.toUpperCase() === wf.toUpperCase());
          return (
            <Badge key={wf} variant={exists ? "default" : "outline"} className={`text-[10px] ${exists ? "bg-emerald-600" : ""}`}>
              {exists ? <CheckCircle2 className="mr-1 h-2.5 w-2.5" /> : null}
              {wf}
            </Badge>
          );
        })}
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <Button variant="secondary" size="sm" onClick={createPilotFamilies} disabled={creating || syncing}>
          {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          {allPilotExist ? "Re-sync Mappings" : creating ? "Creating…" : "Create WINERIM Families"}
        </Button>
        {allPilotExist && (
          <Badge variant="default" className="text-[10px] bg-emerald-600">
            <CheckCircle2 className="mr-1 h-3 w-3" /> All WINERIM families ready
          </Badge>
        )}
      </div>
      {createResult && (
        <div className={`rounded-lg border p-3 text-xs space-y-1 ${createResult.error ? "border-destructive/30 bg-destructive/5" : "border-success/30 bg-success/5"}`}>
          {createResult.error ? (
            <p className="font-medium text-destructive flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5" /> Error: {createResult.error}</p>
          ) : (
            <p className="font-medium text-foreground flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> WINERIM families ready</p>
          )}
          {createResult.created.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-muted-foreground">Created:</span>
              {createResult.created.map(f => <Badge key={f.key} variant="outline" className="text-[10px] font-mono">{f.id}: {f.name}</Badge>)}
            </div>
          )}
          {createResult.reused.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-muted-foreground">Reused:</span>
              {createResult.reused.map(f => <Badge key={f.key} variant="secondary" className="text-[10px] font-mono">{f.id}: {f.name}</Badge>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   Section 2: Manual Family Creator
   ══════════════════════════════════════════════ */
function ManualFamilyCreator({ connectionId, syncing, onSyncMasterData }: Pick<Props, "connectionId" | "syncing" | "onSyncMasterData">) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [buttonText, setButtonText] = useState("");
  const [color, setColor] = useState("#8B0000");
  const [order, setOrder] = useState("100");
  const [showInPos, setShowInPos] = useState(true);
  const [parentFamilyId, setParentFamilyId] = useState("");
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ success: boolean; error?: string; familyId?: string } | null>(null);

  const handleCreate = async () => {
    if (!connectionId || !name.trim()) return;
    setCreating(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: {
          action: "create-family",
          connectionId,
          familyName: name.trim(),
          familyButtonText: (buttonText || name).trim().substring(0, 20),
          familyColor: color,
          familyOrder: parseInt(order) || 100,
          familyShowInPos: showInPos,
          familyParentId: parentFamilyId || null,
        },
      });
      if (error) throw error;
      if (data?.success) {
        toast({ title: "Family created", description: `${name} (ID: ${data.familyId})` });
        setResult({ success: true, familyId: data.familyId });
        setName("");
        setButtonText("");
        await onSyncMasterData();
      } else {
        setResult({ success: false, error: data?.error || "Unknown error" });
        toast({ title: "Error", description: data?.error, variant: "destructive" });
      }
    } catch (e: any) {
      setResult({ success: false, error: e.message });
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-3">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-xs font-medium text-foreground hover:text-primary transition-colors">
        <Plus className="h-3.5 w-3.5" />
        Create Custom Family in Agora
        {expanded ? <EyeOff className="h-3 w-3 text-muted-foreground" /> : <Eye className="h-3 w-3 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Name *</label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. VINOS TINTOS" className="text-xs h-8" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">ButtonText</label>
              <Input value={buttonText} onChange={e => setButtonText(e.target.value)} placeholder={name.substring(0, 20) || "Auto from name"} className="text-xs h-8" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block flex items-center gap-1"><Palette className="h-3 w-3" /> Color</label>
              <div className="flex gap-2 items-center">
                <input type="color" value={color} onChange={e => setColor(e.target.value)} className="h-8 w-10 rounded border border-border cursor-pointer" />
                <Input value={color} onChange={e => setColor(e.target.value)} className="text-xs h-8 font-mono flex-1" />
              </div>
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block flex items-center gap-1"><Hash className="h-3 w-3" /> Order</label>
              <Input type="number" value={order} onChange={e => setOrder(e.target.value)} className="text-xs h-8 font-mono" />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={showInPos} onCheckedChange={setShowInPos} /> Show in POS
            </label>
            <div className="flex-1">
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Parent Family ID (optional)</label>
              <Input value={parentFamilyId} onChange={e => setParentFamilyId(e.target.value)} placeholder="Leave empty for root" className="text-xs h-8 font-mono" />
            </div>
          </div>
          <div className="flex gap-2 items-center">
            <Button size="sm" onClick={handleCreate} disabled={creating || !name.trim() || syncing}>
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Create Family
            </Button>
            {result && (
              result.success ? (
                <Badge variant="default" className="text-[10px] bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" /> Created (ID: {result.familyId})</Badge>
              ) : (
                <Badge variant="destructive" className="text-[10px]"><XCircle className="mr-1 h-3 w-3" /> {result.error}</Badge>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   Section 3: Family Mapping UI (editable)
   ══════════════════════════════════════════════ */
function FamilyMappingSection({ connectionId, families, mappingsVersion, mode }: { connectionId: string | null; families: AgoraMasterItem[]; mappingsVersion: number; mode: FamilyStructureMode }) {
  const [mappings, setMappings] = useState<FamilyMapping[]>([]);
  const [loadingMappings, setLoadingMappings] = useState(false);
  const [reassigning, setReassigning] = useState(false);

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

  useEffect(() => { loadMappings(); }, [loadMappings, mappingsVersion]);

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

  const handleReassign = async () => {
    if (!connectionId) return;
    setReassigning(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "reassign-families", connectionId },
      });
      if (error) throw error;
      toast({
        title: "Reassign queued",
        description: `${data?.queued || 0} UPDATE tasks queued to reassign products to mapped families. Process them in Outbound Sync (Step 11).`,
      });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setReassigning(false);
    }
  };

  const getMappingValue = (key: string) => mappings.find(m => m.mapping_key === key)?.agora_family_id || "";
  const hasAnyMapping = mappings.some(m => m.agora_family_id);

  // In WINERIM_SEPARATE mode, highlight WINERIM families
  const isWinerimFamily = (f: AgoraMasterItem) => f.Name.toUpperCase().includes("WINERIM");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">Wine Type → Agora Family Mapping</p>
        <p className="text-[10px] text-muted-foreground">
          {mode === "WINERIM_SEPARATE_FAMILIES"
            ? "Mapped to dedicated WINERIM families"
            : "Select any existing Agora family"}
        </p>
      </div>
      {loadingMappings ? (
        <div className="flex items-center gap-2 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Loading mappings…</span>
        </div>
      ) : (
        <div className="grid gap-2">
          {MAPPING_KEYS.map(key => {
            const currentValue = getMappingValue(key);
            const currentFamily = families.find(f => f.Id === currentValue);
            const isWinerimMapped = currentFamily ? isWinerimFamily(currentFamily) : false;
            return (
              <div key={key} className="flex items-center gap-3">
                <span className="text-xs font-medium text-foreground w-36 shrink-0">{MAPPING_LABELS[key]}</span>
                <span className="text-muted-foreground text-xs">→</span>
                <select
                  value={currentValue}
                  onChange={(e) => {
                    const fam = families.find(f => f.Id === e.target.value);
                    updateMapping(key, e.target.value, fam?.Name || "");
                  }}
                  className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                >
                  <option value="">Auto / Default</option>
                  {/* In WINERIM_SEPARATE mode, show WINERIM families first */}
                  {mode === "WINERIM_SEPARATE_FAMILIES" && (
                    <optgroup label="── WINERIM Families ──">
                      {families.filter(isWinerimFamily).map(f => (
                        <option key={f.Id} value={f.Id}>🍷 {f.Id}: {f.Name}</option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label={mode === "WINERIM_SEPARATE_FAMILIES" ? "── Other Families ──" : "── All Families ──"}>
                    {families.filter(f => mode !== "WINERIM_SEPARATE_FAMILIES" || !isWinerimFamily(f)).map(f => (
                      <option key={f.Id} value={f.Id}>{f.Id}: {f.Name}</option>
                    ))}
                  </optgroup>
                </select>
                {currentValue && (
                  isWinerimMapped
                    ? <Badge variant="default" className="text-[9px] bg-primary shrink-0">WINERIM</Badge>
                    : <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                )}
              </div>
            );
          })
          }
        </div>
      )}
      {hasAnyMapping && (
        <div className="flex items-start gap-2 p-2 rounded-md bg-success/10 border border-success/20">
          <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
          <p className="text-[11px] text-success">
            {mappings.filter(m => m.agora_family_id).length} of {MAPPING_KEYS.length} wine types mapped.
            {mode === "WINERIM_SEPARATE_FAMILIES" && " Products will be isolated in WINERIM families."}
            {mode === "EXISTING_CUSTOMER_FAMILIES" && " Wines pushed from Winerim will use these family assignments."}
          </p>
        </div>
      )}
      {hasAnyMapping && (
        <Button variant="outline" size="sm" className="h-7 text-[11px]"
          onClick={handleReassign} disabled={reassigning}>
          {reassigning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
          Reassign existing pushed products to mapping
        </Button>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   Section 4: Existing Families List + Hide WINERIM
   ══════════════════════════════════════════════ */
function ExistingFamiliesList({ connectionId, families, mode, onSyncMasterData, syncing }: { connectionId: string | null; families: AgoraMasterItem[]; mode: FamilyStructureMode; onSyncMasterData: () => void | Promise<any>; syncing: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [hidingSingle, setHidingSingle] = useState<string | null>(null);
  if (families.length === 0) return null;
  const shown = showAll ? families : families.slice(0, 12);
  const winerimFamilies = families.filter(f => f.Name.toUpperCase().includes("WINERIM"));

  const hideWinerimFamilies = async () => {
    if (!connectionId || winerimFamilies.length === 0) return;
    setHiding(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "hide-families", connectionId, familyIds: winerimFamilies.map(f => f.Id) },
      });
      if (error) throw error;
      if (data?.success) {
        toast({ title: "Familias ocultadas", description: `${data.hidden?.length || 0} familias WINERIM ocultadas del TPV. Haz Sync Master Data para verificar.` });
        await onSyncMasterData();
      } else {
        toast({ title: "Error", description: data?.error || "Error desconocido", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setHiding(false);
    }
  };

  const hideSingleFamily = async (familyId: string, familyName: string) => {
    if (!connectionId) return;
    setHidingSingle(familyId);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "hide-families", connectionId, familyIds: [familyId] },
      });
      if (error) throw error;
      if (data?.success) {
        toast({ title: "Familia ocultada", description: `"${familyName}" ocultada del TPV.` });
        await onSyncMasterData();
      } else {
        toast({ title: "Error", description: data?.error || "Error desconocido", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setHidingSingle(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          Existing Agora Families ({families.length})
          {mode === "WINERIM_SEPARATE_FAMILIES" && (
            <span className="ml-2 text-[10px] text-amber-600">← Customer's families (will not be modified)</span>
          )}
        </p>
        {winerimFamilies.length > 0 && (
          <Button variant="destructive" size="sm" className="h-6 text-[10px]" onClick={hideWinerimFamilies} disabled={hiding || syncing}>
            {hiding ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <EyeOff className="mr-1 h-3 w-3" />}
            Ocultar {winerimFamilies.length} familias WINERIM del TPV
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map(f => {
          const isWinerim = f.Name.toUpperCase().includes("WINERIM");
          return (
            <div key={f.Id} className="group relative inline-flex">
              <Badge
                variant={isWinerim ? "default" : "outline"}
                className={`text-[10px] font-mono ${isWinerim ? "bg-primary pr-6" : ""}`}
              >
                {isWinerim && <Grape className="mr-1 h-2.5 w-2.5" />}
                {f.Id}: {f.Name}
              </Badge>
              {isWinerim && (
                <button
                  onClick={() => hideSingleFamily(f.Id, f.Name)}
                  disabled={hidingSingle === f.Id}
                  className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 hover:bg-destructive/20 transition-colors"
                  title={`Ocultar "${f.Name}" del TPV`}
                >
                  {hidingSingle === f.Id ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin text-primary-foreground" />
                  ) : (
                    <EyeOff className="h-2.5 w-2.5 text-primary-foreground opacity-60 hover:opacity-100" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {families.length > 12 && (
        <button onClick={() => setShowAll(!showAll)} className="text-[10px] text-primary hover:underline">
          {showAll ? "Show less" : `Show all ${families.length}`}
        </button>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   Migration Notice
   ══════════════════════════════════════════════ */
function MigrationNotice({ mode }: { mode: FamilyStructureMode }) {
  if (mode !== "WINERIM_SEPARATE_FAMILIES") return null;
  return (
    <div className="flex items-start gap-2 p-2.5 rounded-md bg-accent/50 border border-accent">
      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
      <div className="text-[11px] text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">Progressive rollout mode active</p>
        <p>Products are pushed to dedicated "… WINERIM" families to avoid mixing with the customer's existing categories.
        When ready, switch to "Existing Customer Families" mode and use the reassign action to migrate products.</p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   Main Component
   ══════════════════════════════════════════════ */
export default function AgoraFamilyManager({ connectionId, families, onSyncMasterData, syncing }: Props) {
  const [mappingsVersion, setMappingsVersion] = useState(0);
  const [mode, setMode] = useState<FamilyStructureMode>("WINERIM_SEPARATE_FAMILIES");
  const [loadingMode, setLoadingMode] = useState(true);
  const [geoConfig, setGeoConfig] = useState<GeographicFamilyConfig | null>(null);

  // Load mode from provider_config
  useEffect(() => {
    if (!connectionId) { setLoadingMode(false); return; }
    (async () => {
      const { data } = await supabase
        .from("pos_connections")
        .select("provider_config")
        .eq("id", connectionId)
        .single();
      const config = (data?.provider_config as Record<string, unknown>) || {};
      const savedMode = config.family_structure_mode as FamilyStructureMode | undefined;
      if (savedMode === "EXISTING_CUSTOMER_FAMILIES" || savedMode === "WINERIM_SEPARATE_FAMILIES" || savedMode === "GEOGRAPHIC_FAMILIES") {
        setMode(savedMode);
      }
      if (config.geographic_config) {
        setGeoConfig(config.geographic_config as unknown as GeographicFamilyConfig);
      }
      setLoadingMode(false);
    })();
  }, [connectionId]);

  if (loadingMode) {
    return (
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">Loading family configuration…</span>
      </div>
    );
  }

  const modeLabel = mode === "WINERIM_SEPARATE_FAMILIES" ? "🔒 Separate mode"
    : mode === "GEOGRAPHIC_FAMILIES" ? "🌍 Geographic mode"
    : "🔗 Customer families";

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-5">
      <div className="flex items-center gap-2">
        <Grape className="h-4 w-4 text-primary" />
        <p className="text-xs font-medium text-foreground">Agora Family Manager</p>
        <Badge variant="outline" className="text-[9px] ml-auto">
          {modeLabel}
        </Badge>
      </div>

      {/* Mode selector */}
      <ModeSelector connectionId={connectionId} mode={mode} onModeChange={setMode} />

      {/* Geographic families config */}
      {mode === "GEOGRAPHIC_FAMILIES" && (
        <div className="border-t border-border pt-4">
          <AgoraGeographicFamilies
            connectionId={connectionId}
            config={geoConfig}
            onConfigChange={setGeoConfig}
          />
        </div>
      )}

      {/* Migration notice */}
      <MigrationNotice mode={mode} />

      {/* Existing families */}
      <ExistingFamiliesList connectionId={connectionId} families={families} mode={mode} onSyncMasterData={onSyncMasterData} syncing={syncing} />

      {/* WINERIM family setup — prominent in SEPARATE mode */}
      {mode === "WINERIM_SEPARATE_FAMILIES" && (
        <div className="border-t border-border pt-4">
          <AutoPilotSection
            connectionId={connectionId}
            families={families}
            onSyncMasterData={onSyncMasterData}
            syncing={syncing}
            onMappingsChanged={() => setMappingsVersion(v => v + 1)}
          />
        </div>
      )}

      {/* Manual family creator — always available (not in geographic mode) */}
      {mode !== "GEOGRAPHIC_FAMILIES" && (
        <div className="border-t border-border pt-4">
          <ManualFamilyCreator connectionId={connectionId} syncing={syncing} onSyncMasterData={onSyncMasterData} />
        </div>
      )}

      {/* Mapping editor (not in geographic mode — families are auto-determined) */}
      {mode !== "GEOGRAPHIC_FAMILIES" && (
        <div className="border-t border-border pt-4">
          <FamilyMappingSection connectionId={connectionId} families={families} mappingsVersion={mappingsVersion} mode={mode} />
        </div>
      )}

      {/* In EXISTING mode, show the quick setup as collapsed secondary option */}
      {mode === "EXISTING_CUSTOMER_FAMILIES" && (
        <div className="border-t border-border pt-4 opacity-70 hover:opacity-100 transition-opacity">
          <details className="text-[11px]">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Grape className="h-3 w-3" /> Quick Setup: WINERIM Test Families (optional)
            </summary>
            <div className="mt-3">
              <AutoPilotSection
                connectionId={connectionId}
                families={families}
                onSyncMasterData={onSyncMasterData}
                syncing={syncing}
                onMappingsChanged={() => setMappingsVersion(v => v + 1)}
              />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
