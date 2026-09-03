import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Eye, EyeOff, RefreshCw, Search, Filter, AlertTriangle, Loader2, CheckCircle2, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface ProductRow {
  Id: string;
  Name: string;
  FamilyId?: string;
  UseAsDirectSale?: string | boolean;
  SaleableAsMain?: string | boolean;
}
interface FamilyRow { Id: string; Name: string; ShowInPos?: string | boolean; DeletionDate?: string; }

interface Props { connectionId: string; }

const ARCHIVE_FAMILY_ID = "999999";

function asBool(v: unknown, defaultTrue = true): boolean {
  if (v === undefined || v === null || v === "") return defaultTrue;
  const s = String(v).toLowerCase();
  return s === "true" || s === "1";
}

export default function AgoraProductVisibilityPanel({ connectionId }: Props) {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [families, setFamilies] = useState<FamilyRow[]>([]);
  const [winerimAgoraIds, setWinerimAgoraIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [familyFilter, setFamilyFilter] = useState<string>("all");
  const [originFilter, setOriginFilter] = useState<"all" | "winerim" | "legacy">("all");
  const [visibilityFilter, setVisibilityFilter] = useState<"all" | "visible" | "hidden">("all");
  const [pendingChanges, setPendingChanges] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [{ data: master, error: mErr }, { data: pushRows, error: pErr }] = await Promise.all([
        supabase.from("agora_master_data")
          .select("families_json, products_summary_json")
          .eq("connection_id", connectionId).maybeSingle(),
        supabase.from("winerim_push_tracking")
          .select("agora_product_id")
          .eq("connection_id", connectionId)
          .not("agora_product_id", "is", null),
      ]);
      if (mErr) throw mErr;
      if (pErr) throw pErr;
      const prods = ((master?.products_summary_json as unknown as ProductRow[]) || []);
      const fams = ((master?.families_json as unknown as FamilyRow[]) || []);
      setProducts(prods);
      setFamilies(fams);
      setWinerimAgoraIds(new Set(((pushRows || []) as { agora_product_id: string | number | null }[]).map((r) => String(r.agora_product_id))));
      setPendingChanges({});
    } catch (e) {
      toast({ title: "Error cargando productos", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [connectionId]);

  const familyName = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of families) m.set(String(f.Id), f.Name);
    return m;
  }, [families]);

  const familyVisible = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const f of families) {
      const show = asBool(f.ShowInPos, true) && !f.DeletionDate;
      m.set(String(f.Id), show);
    }
    return m;
  }, [families]);

  const enriched = useMemo(() => {
    return products.map(p => {
      const id = String(p.Id);
      const famId = String(p.FamilyId || "");
      const productLevelVisible = asBool(p.UseAsDirectSale, true) && asBool(p.SaleableAsMain, true);
      const famVisible = familyVisible.has(famId) ? familyVisible.get(famId)! : true;
      const originallyVisible = productLevelVisible && famVisible;
      const visible = pendingChanges[id] !== undefined ? pendingChanges[id] : originallyVisible;
      const isWinerim = winerimAgoraIds.has(id);
      return {
        ...p,
        _id: id,
        _name: p.Name || "(sin nombre)",
        _famId: famId,
        _famName: familyName.get(famId) || "—",
        _famHidden: !famVisible,
        _visible: visible,
        _origVisible: originallyVisible,
        _winerim: isWinerim,
        _dirty: pendingChanges[id] !== undefined,
        _archived: famId === ARCHIVE_FAMILY_ID,
      };
    });
  }, [products, pendingChanges, winerimAgoraIds, familyName, familyVisible]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched
      .filter(p => {
        if (q && !p._name.toLowerCase().includes(q) && !p._id.includes(q)) return false;
        if (familyFilter !== "all" && p._famId !== familyFilter) return false;
        if (originFilter === "winerim" && !p._winerim) return false;
        if (originFilter === "legacy" && p._winerim) return false;
        if (visibilityFilter === "visible" && !p._visible) return false;
        if (visibilityFilter === "hidden" && p._visible) return false;
        return true;
      })
      .sort((a, b) => {
        if (a._dirty !== b._dirty) return a._dirty ? -1 : 1;
        return a._name.localeCompare(b._name);
      })
      .slice(0, 500);
  }, [enriched, search, familyFilter, originFilter, visibilityFilter]);

  const dirtyCount = Object.keys(pendingChanges).length;

  const totals = useMemo(() => ({
    total: enriched.length,
    winerim: enriched.filter(p => p._winerim).length,
    legacy: enriched.filter(p => !p._winerim).length,
    visible: enriched.filter(p => p._visible).length,
    hidden: enriched.filter(p => !p._visible).length,
  }), [enriched]);

  const familyOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of enriched) counts.set(p._famId, (counts.get(p._famId) || 0) + 1);
    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, name: familyName.get(id) || `(familia ${id || "?"})`, count }))
      .sort((a, b) => b.count - a.count);
  }, [enriched, familyName]);

  const toggleOne = (id: string, value: boolean, originalVisible: boolean, familyHidden: boolean) => {
    if (value && familyHidden) {
      toast({
        title: "Familia oculta",
        description: "Para mostrar este producto, primero muestra su familia en Agora.",
      });
      return;
    }
    setPendingChanges(prev => {
      const next = { ...prev };
      if (value === originalVisible) delete next[id]; else next[id] = value;
      return next;
    });
  };

  const bulkHideFiltered = () => {
    setPendingChanges(prev => {
      const next = { ...prev };
      for (const p of filtered) {
        if (p._origVisible) next[p._id] = false;
        else delete next[p._id];
      }
      return next;
    });
  };

  const applyChanges = async () => {
    if (dirtyCount === 0) return;
    setSaving(true);
    try {
      const updates = Object.entries(pendingChanges).map(([productId, visible]) => ({ productId, visible }));
      // Send in chunks of 200 to avoid huge XML payloads
      const CHUNK = 200;
      let allApplied = 0;
      let lastError: string | null = null;
      for (let i = 0; i < updates.length; i += CHUNK) {
        const slice = updates.slice(i, i + CHUNK);
        const { data, error } = await supabase.functions.invoke("agora-proxy", {
          body: { action: "set-product-visibility", connectionId, updates: slice },
        });
        if (error) throw error;
        if (!data?.success) { lastError = data?.error || "Falló la importación"; break; }
        allApplied += (data.applied?.length || 0);
      }
      if (lastError) throw new Error(lastError);
      toast({ title: "Cambios aplicados", description: `${allApplied} producto(s) actualizados en Agora.` });
      setPendingChanges({});
      await supabase.functions.invoke("agora-proxy", { body: { action: "sync-master-data", connectionId } });
      await loadData();
    } catch (e) {
      toast({ title: "Error aplicando cambios", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border bg-card p-5 shadow-card space-y-4"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Package className="h-4 w-4 text-primary" /> Visibilidad de productos en Agora
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Oculta productos individuales del TPV (botones y buscador) marcándolos como no vendibles
            (<code className="text-[10px]">UseAsDirectSale=false</code>, <code className="text-[10px]">SaleableAsMain=false</code>).
            No se borran — el histórico de ventas se conserva.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
          <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Recargar
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        <div className="rounded-md border border-border bg-background/50 p-2">
          <div className="text-muted-foreground">Total</div>
          <div className="text-base font-semibold text-foreground">{totals.total}</div>
        </div>
        <div className="rounded-md border border-border bg-background/50 p-2">
          <div className="text-muted-foreground">Winerim</div>
          <div className="text-base font-semibold text-foreground">{totals.winerim}</div>
        </div>
        <div className="rounded-md border border-border bg-background/50 p-2">
          <div className="text-muted-foreground">Legacy</div>
          <div className="text-base font-semibold text-foreground">{totals.legacy}</div>
        </div>
        <div className="rounded-md border border-border bg-background/50 p-2">
          <div className="text-muted-foreground">Visibles</div>
          <div className="text-base font-semibold text-foreground">{totals.visible}</div>
        </div>
        <div className="rounded-md border border-border bg-background/50 p-2">
          <div className="text-muted-foreground">Ocultos</div>
          <div className="text-base font-semibold text-foreground">{totals.hidden}</div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre o ID..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-7 bg-background text-xs h-8"
          />
        </div>
        <select
          value={familyFilter}
          onChange={e => setFamilyFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-background text-xs px-2 max-w-[200px]"
        >
          <option value="all">Todas las familias</option>
          {familyOptions.map(f => (
            <option key={f.id} value={f.id}>{f.name} ({f.count})</option>
          ))}
        </select>
        <div className="flex gap-1 flex-wrap">
          {(["all", "winerim", "legacy"] as const).map(f => (
            <Button key={f} variant={originFilter === f ? "default" : "outline"} size="sm"
              className="h-8 text-xs px-2" onClick={() => setOriginFilter(f)}>
              <Filter className="mr-1 h-3 w-3" />{f === "all" ? "Origen" : f}
            </Button>
          ))}
          {(["all", "visible", "hidden"] as const).map(f => (
            <Button key={f} variant={visibilityFilter === f ? "default" : "outline"} size="sm"
              className="h-8 text-xs px-2" onClick={() => setVisibilityFilter(f)}>
              {f === "all" ? "Estado" : f}
            </Button>
          ))}
        </div>
      </div>

      {dirtyCount > 0 && (
        <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
          <span className="text-foreground">
            <strong>{dirtyCount}</strong> cambio(s) pendiente(s) sin aplicar.
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setPendingChanges({})}>Descartar</Button>
            <Button size="sm" className="h-7" onClick={applyChanges} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
              Aplicar en Agora
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
        <span className="text-muted-foreground">
          Mostrando <strong>{filtered.length}</strong> producto(s) (máx 500). Usa los filtros para acotar.
        </span>
        <Button size="sm" variant="outline" className="h-7" onClick={bulkHideFiltered} disabled={filtered.length === 0}>
          <EyeOff className="mr-1 h-3 w-3" /> Ocultar todos los visibles del filtro
        </Button>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-muted/40 text-[10px] font-medium uppercase text-muted-foreground">
          <div className="col-span-5">Producto</div>
          <div className="col-span-3">Familia</div>
          <div className="col-span-2">ID</div>
          <div className="col-span-2 text-right">Visible TPV</div>
        </div>
        <div className="max-h-[520px] overflow-y-auto divide-y divide-border">
          {loading && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              <Loader2 className="inline h-4 w-4 animate-spin mr-2" /> Cargando productos...
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="p-6 text-center text-xs text-muted-foreground">No hay productos que coincidan.</div>
          )}
          {filtered.map(p => (
            <div key={p._id}
              className={`grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center hover:bg-muted/30 ${p._dirty ? "bg-primary/5" : ""}`}>
              <div className="col-span-5 truncate">
                <span className="text-foreground font-medium">{p._name}</span>
                {p._winerim ? (
                  <Badge variant="secondary" className="ml-2 text-[9px] bg-primary/10 text-primary border-primary/20">Winerim</Badge>
                ) : (
                  <Badge variant="outline" className="ml-2 text-[9px]">Legacy</Badge>
                )}
                {p._archived && (
                  <Badge variant="outline" className="ml-2 text-[9px] border-amber-500/40 text-amber-500">Archivado</Badge>
                )}
              </div>
              <div className="col-span-3 truncate text-muted-foreground">
                {p._famName}
                {p._famHidden && (
                  <Badge variant="outline" className="ml-1 text-[9px] border-amber-500/40 text-amber-500">familia oculta</Badge>
                )}
              </div>
              <div className="col-span-2 font-mono text-[10px] text-muted-foreground">{p._id}</div>
              <div className="col-span-2 flex items-center justify-end gap-2">
                {p._dirty && (
                  <Badge variant="outline" className="text-[9px] border-primary/40 text-primary">
                    {p._origVisible ? "→ ocultar" : "→ mostrar"}
                  </Badge>
                )}
                <Switch
                  checked={p._visible}
                  disabled={p._famHidden}
                  onCheckedChange={(v) => toggleOne(p._id, v, p._origVisible, p._famHidden)}
                />
                {p._visible ? <Eye className="h-3 w-3 text-emerald-500" /> : <EyeOff className="h-3 w-3 text-muted-foreground" />}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-border bg-background/40 p-3 text-[11px] text-muted-foreground space-y-1">
        <p className="flex items-start gap-1.5">
          <AlertTriangle className="h-3 w-3 mt-0.5 text-amber-500 flex-shrink-0" />
          <span>El estado actual (Visible/Oculto) sólo es fiable tras una <strong>Sincronización de master data</strong>.
          Si acabas de tocar productos en Agora, pulsa <strong>Recargar</strong>.</span>
        </p>
        <p className="flex items-start gap-1.5">
          <Package className="h-3 w-3 mt-0.5 text-primary flex-shrink-0" />
          <span><strong>Origen Winerim</strong> = producto creado por este middleware (existe en <code className="text-[10px]">winerim_push_tracking</code>).
          <strong> Legacy</strong> = producto del catálogo previo del cliente.</span>
        </p>
      </div>
    </motion.div>
  );
}
