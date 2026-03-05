import { useState, useEffect, useCallback } from "react";
import {
  Loader2, CheckCircle2, XCircle, Grape, Plus, HelpCircle, Palette, Hash, Eye, EyeOff,
} from "lucide-react";
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

/* ── Constants ── */
const MAPPING_LABELS: Record<string, string> = {
  copa: "Copa (Glass)",
  botella_tinto: "Botella Tinto",
  botella_blanco: "Botella Blanco",
  botella_rosado: "Botella Rosado",
  botella_espumoso: "Botella Espumoso",
  botella_fortificado: "Botella Fortificado",
  botella_postre: "Botella Postre",
  magnum: "Magnum",
};
const MAPPING_KEYS = Object.keys(MAPPING_LABELS);

/* ── Props ── */
interface Props {
  connectionId: string | null;
  families: AgoraMasterItem[];
  onSyncMasterData: () => void | Promise<any>;
  syncing: boolean;
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
        <p className="text-xs font-medium text-foreground">Quick Setup: WINERIM Test Families</p>
      </div>
      <p className="text-[11px] text-muted-foreground">
        One-click to create dedicated pilot families in Agora (COPAS WINERIM, TINTOS WINERIM, etc.) and auto-map all wine types.
      </p>
      <div className="flex gap-2 flex-wrap items-center">
        <Button variant="secondary" size="sm" onClick={createPilotFamilies} disabled={creating || syncing}>
          {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          {creating ? "Creating…" : "Create Winerim Test Families"}
        </Button>
        {hasPilotFamilies && (
          <Badge variant="default" className="text-[10px] bg-emerald-600">
            <CheckCircle2 className="mr-1 h-3 w-3" /> Pilot families exist
          </Badge>
        )}
      </div>
      {createResult && (
        <div className={`rounded-lg border p-3 text-xs space-y-1 ${createResult.error ? "border-destructive/30 bg-destructive/5" : "border-success/30 bg-success/5"}`}>
          {createResult.error ? (
            <p className="font-medium text-destructive flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5" /> Error: {createResult.error}</p>
          ) : (
            <p className="font-medium text-foreground flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> Pilot families ready</p>
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
function FamilyMappingSection({ connectionId, families, mappingsVersion }: { connectionId: string | null; families: AgoraMasterItem[]; mappingsVersion: number }) {
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

  const getMappingValue = (key: string) => mappings.find(m => m.mapping_key === key)?.agora_family_id || "";
  const hasAnyMapping = mappings.some(m => m.agora_family_id);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">Wine Type → Agora Family Mapping</p>
        <p className="text-[10px] text-muted-foreground">
          Select any existing Agora family — not limited to WINERIM families
        </p>
      </div>
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
              {getMappingValue(key) && <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />}
            </div>
          ))
          }
        </div>
      )}
      {hasAnyMapping && (
        <div className="flex items-start gap-2 p-2 rounded-md bg-success/10 border border-success/20">
          <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
          <p className="text-[11px] text-success">
            {mappings.filter(m => m.agora_family_id).length} of {MAPPING_KEYS.length} wine types mapped.
            Wines pushed from Winerim will use these family assignments.
          </p>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   Section 4: Existing Families List
   ══════════════════════════════════════════════ */
function ExistingFamiliesList({ families }: { families: AgoraMasterItem[] }) {
  const [showAll, setShowAll] = useState(false);
  if (families.length === 0) return null;
  const shown = showAll ? families : families.slice(0, 12);

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        Existing Agora Families ({families.length})
      </p>
      <div className="flex flex-wrap gap-1.5">
        {shown.map(f => (
          <Badge key={f.Id} variant="outline" className="text-[10px] font-mono">
            {f.Id}: {f.Name}
          </Badge>
        ))}
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
   Main Component
   ══════════════════════════════════════════════ */
export default function AgoraFamilyManager({ connectionId, families, onSyncMasterData, syncing }: Props) {
  const [mappingsVersion, setMappingsVersion] = useState(0);

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-5">
      <div className="flex items-center gap-2">
        <Grape className="h-4 w-4 text-primary" />
        <p className="text-xs font-medium text-foreground">Agora Family Manager</p>
      </div>

      <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50 border border-border">
        <HelpCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[11px] text-muted-foreground">
          Manage Agora families and control which family each wine type maps to when pushing products.
          Use the quick setup for pilot testing, or create custom families for any restaurant.
        </p>
      </div>

      {/* Existing families */}
      <ExistingFamiliesList families={families} />

      {/* Auto pilot */}
      <div className="border-t border-border pt-4">
        <AutoPilotSection
          connectionId={connectionId}
          families={families}
          onSyncMasterData={onSyncMasterData}
          syncing={syncing}
          onMappingsChanged={() => setMappingsVersion(v => v + 1)}
        />
      </div>

      {/* Manual family creator */}
      <div className="border-t border-border pt-4">
        <ManualFamilyCreator connectionId={connectionId} syncing={syncing} onSyncMasterData={onSyncMasterData} />
      </div>

      {/* Mapping editor */}
      <div className="border-t border-border pt-4">
        <FamilyMappingSection connectionId={connectionId} families={families} mappingsVersion={mappingsVersion} />
      </div>
    </div>
  );
}
