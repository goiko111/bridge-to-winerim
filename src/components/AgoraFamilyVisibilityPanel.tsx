import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Eye, EyeOff, RefreshCw, Archive, Search, Filter, AlertTriangle, Loader2, CheckCircle2, ChevronRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface FamilyRow {
  Id: string;
  Name: string;
  ShowInPos?: string | boolean;
  Color?: string;
  Order?: string;
  ButtonText?: string;
}

interface ProductRow {
  Id: string;
  Name?: string;
  FamilyId?: string;
  UseAsDirectSale?: string | boolean;
  SaleableAsMain?: string | boolean;
}

interface Props {
  connectionId: string;
}

// Heuristic: families with numeric ID >= 900000 are Winerim-created (stable hashed IDs).
// Families with low IDs (< 1000) are legacy from the customer's previous menu.
function isWinerimFamily(id: string, name: string): boolean {
  const n = Number(id);
  if (!Number.isNaN(n) && n >= 900000) return true;
  if (/winerim/i.test(name)) return true;
  return false;
}

export default function AgoraFamilyVisibilityPanel({ connectionId }: Props) {
  const [loading, setLoading] = useState(true);
  const [families, setFamilies] = useState<FamilyRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "winerim" | "legacy" | "visible" | "hidden" | "with-products">("all");
  const [pendingChanges, setPendingChanges] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("agora_master_data")
        .select("families_json, products_summary_json")
        .eq("connection_id", connectionId)
        .maybeSingle();
      if (error) throw error;
      const fams = ((data?.families_json as any[]) || []) as FamilyRow[];
      const prods = ((data?.products_summary_json as any[]) || []) as ProductRow[];
      setFamilies(fams);
      setProducts(prods);
      setPendingChanges({});
      setBulkSelected(new Set());
    } catch (e) {
      toast({ title: "Error cargando familias", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [connectionId]);

  const productCountByFamily = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) {
      const k = String(p.FamilyId || "");
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [products]);

  const productsByFamily = useMemo(() => {
    const m = new Map<string, ProductRow[]>();
    for (const p of products) {
      const k = String(p.FamilyId || "");
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.Name || "").localeCompare(b.Name || ""));
    }
    return m;
  }, [products]);

  const enriched = useMemo(() => {
    return families.map(f => {
      const id = String(f.Id);
      const visible = pendingChanges[id] !== undefined
        ? pendingChanges[id]
        : (String(f.ShowInPos).toLowerCase() === "true");
      return {
        ...f,
        _id: id,
        _visible: visible,
        _winerim: isWinerimFamily(id, f.Name),
        _productCount: productCountByFamily.get(id) || 0,
        _dirty: pendingChanges[id] !== undefined,
      };
    });
  }, [families, pendingChanges, productCountByFamily]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched
      .filter(f => {
        if (q && !f.Name.toLowerCase().includes(q) && !f._id.includes(q)) return false;
        if (filter === "winerim" && !f._winerim) return false;
        if (filter === "legacy" && f._winerim) return false;
        if (filter === "visible" && !f._visible) return false;
        if (filter === "hidden" && f._visible) return false;
        if (filter === "with-products" && f._productCount === 0) return false;
        return true;
      })
      .sort((a, b) => {
        if (a._dirty !== b._dirty) return a._dirty ? -1 : 1;
        if (b._productCount !== a._productCount) return b._productCount - a._productCount;
        return a.Name.localeCompare(b.Name);
      });
  }, [enriched, search, filter]);

  const dirtyCount = Object.keys(pendingChanges).length;
  const totals = useMemo(() => ({
    total: enriched.length,
    winerim: enriched.filter(f => f._winerim).length,
    legacy: enriched.filter(f => !f._winerim).length,
    visible: enriched.filter(f => f._visible).length,
    hidden: enriched.filter(f => !f._visible).length,
  }), [enriched]);

  const toggleOne = (id: string, value: boolean, originalShowInPos: boolean) => {
    setPendingChanges(prev => {
      const next = { ...prev };
      if (value === originalShowInPos) {
        delete next[id];
      } else {
        next[id] = value;
      }
      return next;
    });
  };

  const applyChanges = async () => {
    if (dirtyCount === 0) return;
    setSaving(true);
    try {
      const updates = Object.entries(pendingChanges).map(([familyId, showInPos]) => ({ familyId, showInPos }));
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "set-family-visibility", connectionId, updates },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Falló la importación XML");
      toast({ title: "Cambios aplicados", description: `${updates.length} familia(s) actualizadas en Agora.` });
      setPendingChanges({});
      // Re-sync master data so we see fresh ShowInPos values
      await supabase.functions.invoke("agora-proxy", { body: { action: "sync-master-data", connectionId } });
      await loadData();
    } catch (e) {
      toast({ title: "Error aplicando cambios", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // Reversible archive: hides all products in a family (UseAsDirectSale/SaleableAsMain=false)
  // AND hides the family itself (ShowInPos=false). To recover, run with restore=true.
  const archiveFamilies = async (familyIds: string[], restore = false) => {
    if (familyIds.length === 0) return;
    setArchiving(true);
    try {
      const productUpdates: { productId: string; visible: boolean }[] = [];
      for (const fId of familyIds) {
        const prods = productsByFamily.get(fId) || [];
        for (const p of prods) productUpdates.push({ productId: String(p.Id), visible: restore });
      }
      // Batches of 200 to keep XML manageable
      for (let i = 0; i < productUpdates.length; i += 200) {
        const slice = productUpdates.slice(i, i + 200);
        const { data, error } = await supabase.functions.invoke("agora-proxy", {
          body: { action: "set-product-visibility", connectionId, updates: slice },
        });
        if (error) throw error;
        if (!data?.success) throw new Error(data?.error || "Falló cambiar visibilidad de productos");
      }
      const famUpdates = familyIds.map(familyId => ({ familyId, showInPos: restore }));
      const { data: famData, error: famErr } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "set-family-visibility", connectionId, updates: famUpdates },
      });
      if (famErr) throw famErr;
      if (!famData?.success) throw new Error(famData?.error || "Falló cambiar visibilidad de familias");

      toast({
        title: restore ? "Familias restauradas" : "Archivado completo",
        description: restore
          ? `${familyIds.length} familia(s) y ${productUpdates.length} producto(s) vueltos a visibles.`
          : `${familyIds.length} familia(s) y ${productUpdates.length} producto(s) ocultos en Agora. Reversible.`,
      });
      setBulkSelected(new Set());
      setArchiveDialogOpen(false);
      await supabase.functions.invoke("agora-proxy", { body: { action: "sync-master-data", connectionId } });
      await loadData();
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setArchiving(false);
    }
  };

  const archiveSelected = () => archiveFamilies(Array.from(bulkSelected), false);

  const toggleBulk = (id: string) => {
    setBulkSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const productsToArchive = useMemo(
    () => Array.from(bulkSelected).reduce((sum, id) => sum + (productCountByFamily.get(id) || 0), 0),
    [bulkSelected, productCountByFamily]
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border bg-card p-5 shadow-card space-y-4"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Eye className="h-4 w-4 text-primary" /> Visibilidad de familias en Agora
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Controla qué familias aparecen en el TPV. Las familias Winerim (ID ≥ 900000) son las que creamos nosotros;
            las demás son del catálogo previo del cliente.
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
          <div className="text-muted-foreground">Ocultas</div>
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
        <div className="flex gap-1 flex-wrap">
          {(["all", "winerim", "legacy", "with-products", "visible", "hidden"] as const).map(f => (
            <Button
              key={f}
              variant={filter === f ? "default" : "outline"}
              size="sm"
              className="h-8 text-xs px-2"
              onClick={() => setFilter(f)}
            >
              <Filter className="mr-1 h-3 w-3" />
              {f === "all" ? "Todas" : f === "with-products" ? "Con productos" : f}
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

      {bulkSelected.size > 0 && (
        <div className="flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
          <span className="text-foreground">
            <strong>{bulkSelected.size}</strong> familia(s) seleccionadas — <strong>{productsToArchive}</strong> producto(s) se moverán a "ARCHIVO WINERIM" (oculto).
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setBulkSelected(new Set())}>Cancelar</Button>
            <Button size="sm" variant="destructive" className="h-7" onClick={() => setArchiveDialogOpen(true)}>
              <Archive className="mr-1 h-3 w-3" /> Archivar productos
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-muted/40 text-[10px] font-medium uppercase text-muted-foreground">
          <div className="col-span-1">Sel.</div>
          <div className="col-span-5">Familia</div>
          <div className="col-span-2">ID</div>
          <div className="col-span-2">Productos</div>
          <div className="col-span-2 text-right">Visible TPV</div>
        </div>
        <div className="max-h-[480px] overflow-y-auto divide-y divide-border">
          {loading && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              <Loader2 className="inline h-4 w-4 animate-spin mr-2" /> Cargando familias...
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="p-6 text-center text-xs text-muted-foreground">No hay familias que coincidan.</div>
          )}
          {filtered.map(f => {
            const originalVisible = String(f.ShowInPos).toLowerCase() === "true";
            const isOpen = expanded.has(f._id);
            const famProducts = productsByFamily.get(f._id) || [];
            return (
              <div key={f._id} className={f._dirty ? "bg-primary/5" : ""}>
                <div className={`grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center hover:bg-muted/30`}>
                  <div className="col-span-1">
                    <input
                      type="checkbox"
                      checked={bulkSelected.has(f._id)}
                      onChange={() => toggleBulk(f._id)}
                      disabled={f._productCount === 0}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                  </div>
                  <div className="col-span-5 truncate flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => f._productCount > 0 && toggleExpand(f._id)}
                      disabled={f._productCount === 0}
                      className="flex-shrink-0 p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                      aria-label={isOpen ? "Colapsar" : "Expandir"}
                    >
                      {isOpen
                        ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                    </button>
                    <span className="text-foreground font-medium truncate">{f.Name || "(sin nombre)"}</span>
                    {f._winerim ? (
                      <Badge variant="secondary" className="ml-1 text-[9px] bg-primary/10 text-primary border-primary/20">Winerim</Badge>
                    ) : (
                      <Badge variant="outline" className="ml-1 text-[9px]">Legacy</Badge>
                    )}
                  </div>
                  <div className="col-span-2 font-mono text-[10px] text-muted-foreground">{f._id}</div>
                  <div className="col-span-2">
                    {f._productCount > 0 ? (
                      <span className="text-foreground">{f._productCount}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                  <div className="col-span-2 flex items-center justify-end gap-2">
                    {f._dirty && (
                      <Badge variant="outline" className="text-[9px] border-primary/40 text-primary">
                        {originalVisible ? "→ ocultar" : "→ mostrar"}
                      </Badge>
                    )}
                    <Switch
                      checked={f._visible}
                      onCheckedChange={(v) => toggleOne(f._id, v, originalVisible)}
                    />
                    {f._visible ? <Eye className="h-3 w-3 text-emerald-500" /> : <EyeOff className="h-3 w-3 text-muted-foreground" />}
                  </div>
                </div>
                {isOpen && famProducts.length > 0 && (
                  <div className="bg-muted/20 border-t border-border px-3 py-2">
                    <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Productos en esta familia ({famProducts.length})
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px] px-2 border-amber-500/40 text-amber-600 hover:bg-amber-500/10"
                          disabled={archiving}
                          onClick={() => archiveFamilies([f._id], false)}
                        >
                          {archiving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Archive className="mr-1 h-3 w-3" />}
                          Archivar familia + productos
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[10px] px-2 text-emerald-600 hover:bg-emerald-500/10"
                          disabled={archiving}
                          onClick={() => archiveFamilies([f._id], true)}
                        >
                          <Eye className="mr-1 h-3 w-3" /> Restaurar
                        </Button>
                      </div>
                    </div>
                    <div className="max-h-[260px] overflow-y-auto rounded-md border border-border bg-background/40 divide-y divide-border">
                      {famProducts.slice(0, 500).map(p => {
                        const pid = String(p.Id);
                        const visibleProd =
                          (p.UseAsDirectSale === undefined || String(p.UseAsDirectSale).toLowerCase() === "true") &&
                          (p.SaleableAsMain === undefined || String(p.SaleableAsMain).toLowerCase() === "true");
                        return (
                          <div key={pid} className="grid grid-cols-12 gap-2 px-2 py-1 text-[11px] items-center">
                            <div className="col-span-8 truncate text-foreground">{p.Name || "(sin nombre)"}</div>
                            <div className="col-span-2 font-mono text-[10px] text-muted-foreground truncate">{pid}</div>
                            <div className="col-span-2 flex justify-end">
                              {visibleProd
                                ? <Badge variant="outline" className="text-[9px] border-emerald-500/30 text-emerald-500">Visible</Badge>
                                : <Badge variant="outline" className="text-[9px] border-muted-foreground/30 text-muted-foreground">Oculto</Badge>}
                            </div>
                          </div>
                        );
                      })}
                      {famProducts.length > 500 && (
                        <div className="px-2 py-1 text-[10px] text-muted-foreground text-center">
                          … {famProducts.length - 500} más (acota usando el panel de visibilidad de productos).
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-md border border-border bg-background/40 p-3 text-[11px] text-muted-foreground space-y-1">
        <p className="flex items-start gap-1.5">
          <AlertTriangle className="h-3 w-3 mt-0.5 text-amber-500 flex-shrink-0" />
          <span><strong>Toggle visibilidad</strong> oculta el botón de la familia en el TPV. La mayoría de versiones de Agora también lo respeta en el buscador.</span>
        </p>
        <p className="flex items-start gap-1.5">
          <Archive className="h-3 w-3 mt-0.5 text-amber-500 flex-shrink-0" />
          <span><strong>Archivar familia + productos</strong> oculta la familia (ShowInPos=false) y marca todos sus productos como no vendibles (UseAsDirectSale/SaleableAsMain=false). <strong>Totalmente reversible</strong> — pulsa "Restaurar" o reactiva los switches para volver a ponerlo visible. No se borra nada, el histórico se conserva.</span>
        </p>
      </div>

      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Archivar {productsToArchive} producto(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              Se ocultarán las {bulkSelected.size} familia(s) seleccionada(s) y sus {productsToArchive} producto(s) en Agora
              (ShowInPos=false + UseAsDirectSale/SaleableAsMain=false). No se borran — el histórico de ventas se conserva
              y es <strong>totalmente reversible</strong> desde este mismo panel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={archiveSelected} disabled={archiving}>
              {archiving ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Archive className="mr-2 h-3 w-3" />}
              Archivar productos
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
