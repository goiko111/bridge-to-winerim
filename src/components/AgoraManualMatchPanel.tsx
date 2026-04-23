import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Loader2, Search, Link2, Link2Off, Wine, ArrowLeftRight, RefreshCw,
  CheckCircle2, AlertTriangle, Filter, X,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────
interface WinerimWine {
  winerim_id: string;
  name: string;
  winery: string | null;
  vintage: string | null;
  region: string | null;
  bottle_sale_price: number | null;
  glass_sale_price: number | null;
  wine_type: string | null;
}

interface AgoraProduct {
  Id: string;
  Name: string;
  FamilyId?: string;
  VatId?: string;
  Price?: number;
  ReferenceCode?: string;
}

interface AgoraFamily {
  Id: string;
  Name: string;
}

interface ProductMapping {
  id: string;
  provider_product_id: string;
  provider_product_name: string;
  winerim_wine_id: string | null;
  winerim_wine_name: string | null;
  match_method: string;
  match_score: number;
  status: string;
  format_type: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
async function fetchAllWinerim(connectionId: string): Promise<WinerimWine[]> {
  const all: WinerimWine[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("winerim_wines")
      .select("winerim_id, name, winery, vintage, region, bottle_sale_price, glass_sale_price, wine_type")
      .eq("connection_id", connectionId)
      .order("name")
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    all.push(...(data as WinerimWine[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function fetchAllMappings(connectionId: string): Promise<ProductMapping[]> {
  const all: ProductMapping[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("product_mappings")
      .select("id, provider_product_id, provider_product_name, winerim_wine_id, winerim_wine_name, match_method, match_score, status, format_type")
      .eq("connection_id", connectionId)
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    all.push(...(data as ProductMapping[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────────
export default function AgoraManualMatchPanel({ connectionId }: { connectionId: string | null }) {
  const [loading, setLoading] = useState(false);
  const [winerimWines, setWinerimWines] = useState<WinerimWine[]>([]);
  const [agoraProducts, setAgoraProducts] = useState<AgoraProduct[]>([]);
  const [agoraFamilies, setAgoraFamilies] = useState<AgoraFamily[]>([]);
  const [mappings, setMappings] = useState<ProductMapping[]>([]);

  const [side, setSide] = useState<"winerim" | "agora">("winerim");
  const [searchWinerim, setSearchWinerim] = useState("");
  const [searchAgora, setSearchAgora] = useState("");
  const [filterWinerim, setFilterWinerim] = useState<"all" | "linked" | "unlinked">("all");
  const [filterAgora, setFilterAgora] = useState<"all" | "wine-families" | "linked" | "unlinked">("all");
  const [familyFilter, setFamilyFilter] = useState<string>("all");

  // Manual link dialog
  const [linkDialog, setLinkDialog] = useState<{
    fromSide: "winerim" | "agora";
    winerim?: WinerimWine;
    agora?: AgoraProduct;
  } | null>(null);
  const [linkSearch, setLinkSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // ────────────────────────────── Load data ──────────────────────────────
  const loadData = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    try {
      const [wines, mappingsData, master] = await Promise.all([
        fetchAllWinerim(connectionId),
        fetchAllMappings(connectionId),
        supabase
          .from("agora_master_data")
          .select("products_summary_json, families_json")
          .eq("connection_id", connectionId)
          .maybeSingle(),
      ]);
      setWinerimWines(wines);
      setMappings(mappingsData);
      const products = (master.data?.products_summary_json as AgoraProduct[] | null) || [];
      const families = (master.data?.families_json as AgoraFamily[] | null) || [];
      setAgoraProducts(products);
      setAgoraFamilies(families);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ────────────────────────────── Lookups ──────────────────────────────
  // winerim_id → mapping (CONFIRMED only)
  const winerimToMapping = useMemo(() => {
    const map = new Map<string, ProductMapping>();
    for (const m of mappings) {
      if (m.winerim_wine_id && m.status === "CONFIRMED") {
        map.set(m.winerim_wine_id, m);
      }
    }
    return map;
  }, [mappings]);

  // agora_product_id → mapping
  const agoraToMapping = useMemo(() => {
    const map = new Map<string, ProductMapping>();
    for (const m of mappings) {
      map.set(m.provider_product_id, m);
    }
    return map;
  }, [mappings]);

  const familyMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of agoraFamilies) m.set(f.Id, f.Name);
    return m;
  }, [agoraFamilies]);

  // Detect "wine-likely" Agora families heuristically
  const wineFamilyIds = useMemo(() => {
    const ids = new Set<string>();
    const KEYWORDS = ["vino", "tinto", "blanco", "rosado", "espumoso", "cava", "champ", "wine", "copa", "carta", "magnum", "fortific", "dulce"];
    for (const f of agoraFamilies) {
      const n = normalize(f.Name);
      if (KEYWORDS.some(k => n.includes(k))) ids.add(f.Id);
    }
    return ids;
  }, [agoraFamilies]);

  // ────────────────────────────── Filtering ──────────────────────────────
  const filteredWinerim = useMemo(() => {
    const q = normalize(searchWinerim);
    return winerimWines.filter(w => {
      const linked = winerimToMapping.has(w.winerim_id);
      if (filterWinerim === "linked" && !linked) return false;
      if (filterWinerim === "unlinked" && linked) return false;
      if (!q) return true;
      return normalize(w.name).includes(q)
        || normalize(w.winery || "").includes(q)
        || normalize(w.winerim_id).includes(q);
    });
  }, [winerimWines, searchWinerim, filterWinerim, winerimToMapping]);

  const filteredAgora = useMemo(() => {
    const q = normalize(searchAgora);
    return agoraProducts.filter(p => {
      const mapping = agoraToMapping.get(p.Id);
      const linked = mapping?.status === "CONFIRMED" && !!mapping.winerim_wine_id;
      if (filterAgora === "linked" && !linked) return false;
      if (filterAgora === "unlinked" && linked) return false;
      if (filterAgora === "wine-families" && !(p.FamilyId && wineFamilyIds.has(p.FamilyId))) return false;
      if (familyFilter !== "all" && p.FamilyId !== familyFilter) return false;
      if (!q) return true;
      return normalize(p.Name).includes(q) || normalize(p.Id).includes(q);
    });
  }, [agoraProducts, searchAgora, filterAgora, familyFilter, agoraToMapping, wineFamilyIds]);

  // ────────────────────────────── Counters ──────────────────────────────
  const winerimLinked = useMemo(
    () => winerimWines.filter(w => winerimToMapping.has(w.winerim_id)).length,
    [winerimWines, winerimToMapping],
  );
  const agoraLinked = useMemo(
    () => agoraProducts.filter(p => {
      const m = agoraToMapping.get(p.Id);
      return m?.status === "CONFIRMED" && !!m.winerim_wine_id;
    }).length,
    [agoraProducts, agoraToMapping],
  );

  // ────────────────────────────── Actions ──────────────────────────────
  const openLinkFromWinerim = (w: WinerimWine) => {
    setLinkDialog({ fromSide: "winerim", winerim: w });
    setLinkSearch(w.name);
  };
  const openLinkFromAgora = (p: AgoraProduct) => {
    setLinkDialog({ fromSide: "agora", agora: p });
    setLinkSearch(p.Name);
  };

  const performLink = async (winerim: WinerimWine, agora: AgoraProduct) => {
    if (!connectionId) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke("winerim-proxy", {
        body: {
          action: "create-manual-mapping",
          connectionId,
          providerProductId: agora.Id,
          providerProductName: agora.Name,
          winerimWineId: winerim.winerim_id,
          winerimWineName: winerim.name,
          formatType: "BOTTLE",
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Link failed");
      toast({ title: "Vinculado", description: `${winerim.name} ↔ ${agora.Name}` });
      setLinkDialog(null);
      await loadData();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const performUnlink = async (providerProductId: string) => {
    if (!connectionId) return;
    try {
      const { data, error } = await supabase.functions.invoke("winerim-proxy", {
        body: { action: "unlink-mapping", connectionId, providerProductId },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Unlink failed");
      toast({ title: "Desvinculado" });
      await loadData();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  // ────────────────────────────── Render ──────────────────────────────
  if (!connectionId) {
    return (
      <div className="text-center py-8 text-sm text-muted-foreground">
        Select a connection first.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-primary" />
            Manual Mapping (Winerim ↔ Agora)
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Side-by-side view of every wine. Link products manually to avoid duplicates.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Reload
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard label="Winerim wines" value={winerimWines.length} icon={<Wine className="h-3.5 w-3.5" />} />
        <StatCard label="Winerim linked" value={winerimLinked} tone="success" />
        <StatCard label="Agora products" value={agoraProducts.length} />
        <StatCard label="Agora linked" value={agoraLinked} tone="success" />
      </div>

      {/* Side toggle (mobile-first) */}
      <Tabs value={side} onValueChange={(v) => setSide(v as any)}>
        <TabsList className="w-full lg:hidden">
          <TabsTrigger value="winerim" className="flex-1">Winerim ({filteredWinerim.length})</TabsTrigger>
          <TabsTrigger value="agora" className="flex-1">Agora ({filteredAgora.length})</TabsTrigger>
        </TabsList>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-2">
          {/* Winerim panel */}
          <div className={`${side === "winerim" ? "block" : "hidden"} lg:block`}>
            <PanelHeader
              title="Winerim Catalog"
              count={filteredWinerim.length}
              total={winerimWines.length}
              accent="primary"
            />
            <div className="space-y-2 mb-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by name, winery, ID…"
                  value={searchWinerim}
                  onChange={(e) => setSearchWinerim(e.target.value)}
                  className="pl-9 h-8 text-xs"
                />
              </div>
              <FilterPills
                value={filterWinerim}
                onChange={(v) => setFilterWinerim(v as any)}
                options={[
                  { v: "all", label: "All" },
                  { v: "unlinked", label: "Unlinked" },
                  { v: "linked", label: "Linked" },
                ]}
              />
            </div>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="max-h-[520px] overflow-y-auto divide-y divide-border">
                {loading ? (
                  <div className="p-6 text-center text-xs text-muted-foreground">
                    <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />Loading…
                  </div>
                ) : filteredWinerim.length === 0 ? (
                  <div className="p-6 text-center text-xs text-muted-foreground">No wines.</div>
                ) : (
                  filteredWinerim.slice(0, 500).map((w) => {
                    const mapping = winerimToMapping.get(w.winerim_id);
                    const linkedAgoraName = mapping?.provider_product_name;
                    return (
                      <div key={w.winerim_id} className="px-3 py-2 bg-card hover:bg-secondary/30 transition-colors">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-foreground truncate">{w.name}</p>
                            <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                              <span className="font-mono">#{w.winerim_id}</span>
                              {w.winery && <span className="truncate">{w.winery}</span>}
                              {w.vintage && <span>{w.vintage}</span>}
                            </div>
                            {linkedAgoraName ? (
                              <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                                <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
                                <span className="text-success/90 truncate">→ {linkedAgoraName}</span>
                              </div>
                            ) : (
                              <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <AlertTriangle className="h-3 w-3" />
                                <span>Not linked</span>
                              </div>
                            )}
                          </div>
                          <div className="shrink-0 flex flex-col gap-1">
                            {linkedAgoraName ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => mapping && performUnlink(mapping.provider_product_id)}
                              >
                                <Link2Off className="h-3 w-3 mr-1" />Unlink
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => openLinkFromWinerim(w)}
                              >
                                <Link2 className="h-3 w-3 mr-1" />Link
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            {filteredWinerim.length > 500 && (
              <p className="text-[10px] text-muted-foreground mt-1">
                Showing first 500 — refine search to see more.
              </p>
            )}
          </div>

          {/* Agora panel */}
          <div className={`${side === "agora" ? "block" : "hidden"} lg:block`}>
            <PanelHeader
              title="Agora POS Products"
              count={filteredAgora.length}
              total={agoraProducts.length}
              accent="warning"
            />
            <div className="space-y-2 mb-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by name or Agora ID…"
                  value={searchAgora}
                  onChange={(e) => setSearchAgora(e.target.value)}
                  className="pl-9 h-8 text-xs"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <FilterPills
                  value={filterAgora}
                  onChange={(v) => setFilterAgora(v as any)}
                  options={[
                    { v: "all", label: "All" },
                    { v: "wine-families", label: "Wine families" },
                    { v: "unlinked", label: "Unlinked" },
                    { v: "linked", label: "Linked" },
                  ]}
                />
                <select
                  value={familyFilter}
                  onChange={(e) => setFamilyFilter(e.target.value)}
                  className="text-[10px] rounded-md border border-border bg-background px-2 py-1"
                >
                  <option value="all">All families</option>
                  {agoraFamilies.map((f) => (
                    <option key={f.Id} value={f.Id}>{f.Name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="max-h-[520px] overflow-y-auto divide-y divide-border">
                {loading ? (
                  <div className="p-6 text-center text-xs text-muted-foreground">
                    <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />Loading…
                  </div>
                ) : filteredAgora.length === 0 ? (
                  <div className="p-6 text-center text-xs text-muted-foreground">No products.</div>
                ) : (
                  filteredAgora.slice(0, 500).map((p) => {
                    const mapping = agoraToMapping.get(p.Id);
                    const linkedWinerim = mapping?.status === "CONFIRMED" ? mapping.winerim_wine_name : null;
                    const familyName = p.FamilyId ? familyMap.get(p.FamilyId) : null;
                    return (
                      <div key={p.Id} className="px-3 py-2 bg-card hover:bg-secondary/30 transition-colors">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-foreground truncate">{p.Name}</p>
                            <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                              <span className="font-mono">#{p.Id}</span>
                              {familyName && <span className="truncate">{familyName}</span>}
                            </div>
                            {linkedWinerim ? (
                              <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                                <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
                                <span className="text-success/90 truncate">↔ {linkedWinerim}</span>
                              </div>
                            ) : (
                              <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <AlertTriangle className="h-3 w-3" />
                                <span>Not linked to Winerim</span>
                              </div>
                            )}
                          </div>
                          <div className="shrink-0">
                            {linkedWinerim ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => performUnlink(p.Id)}
                              >
                                <Link2Off className="h-3 w-3 mr-1" />Unlink
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => openLinkFromAgora(p)}
                              >
                                <Link2 className="h-3 w-3 mr-1" />Link
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            {filteredAgora.length > 500 && (
              <p className="text-[10px] text-muted-foreground mt-1">
                Showing first 500 — refine search to see more.
              </p>
            )}
          </div>
        </div>
      </Tabs>

      {/* Link dialog */}
      <Dialog open={!!linkDialog} onOpenChange={(open) => !open && setLinkDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Link2 className="h-4 w-4 text-primary" />
              {linkDialog?.fromSide === "winerim"
                ? `Link "${linkDialog.winerim?.name}" to an Agora product`
                : `Link "${linkDialog?.agora?.Name}" to a Winerim wine`}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Pick the matching counterpart. Future sales of this product will deduce stock from the linked Winerim wine.
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              placeholder="Search…"
              value={linkSearch}
              onChange={(e) => setLinkSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="rounded-lg border border-border max-h-[400px] overflow-y-auto divide-y divide-border">
            {linkDialog?.fromSide === "winerim" ? (
              // searching Agora products
              (() => {
                const q = normalize(linkSearch);
                const list = agoraProducts
                  .filter(p => !q || normalize(p.Name).includes(q) || normalize(p.Id).includes(q))
                  .slice(0, 100);
                if (list.length === 0) {
                  return <div className="p-6 text-center text-xs text-muted-foreground">No Agora products match.</div>;
                }
                return list.map((p) => {
                  const m = agoraToMapping.get(p.Id);
                  const alreadyLinked = m?.status === "CONFIRMED" && !!m.winerim_wine_id;
                  return (
                    <button
                      key={p.Id}
                      type="button"
                      disabled={saving}
                      onClick={() => linkDialog?.winerim && performLink(linkDialog.winerim, p)}
                      className="w-full text-left px-3 py-2 hover:bg-secondary/40 transition-colors disabled:opacity-50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">{p.Name}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">
                            #{p.Id}
                            {p.FamilyId && familyMap.get(p.FamilyId) ? ` · ${familyMap.get(p.FamilyId)}` : ""}
                          </p>
                        </div>
                        {alreadyLinked && (
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            Linked → {m?.winerim_wine_name?.slice(0, 24)}
                          </Badge>
                        )}
                      </div>
                    </button>
                  );
                });
              })()
            ) : (
              // searching Winerim wines
              (() => {
                const q = normalize(linkSearch);
                const list = winerimWines
                  .filter(w => !q || normalize(w.name).includes(q) || normalize(w.winery || "").includes(q) || normalize(w.winerim_id).includes(q))
                  .slice(0, 100);
                if (list.length === 0) {
                  return <div className="p-6 text-center text-xs text-muted-foreground">No Winerim wines match.</div>;
                }
                return list.map((w) => {
                  const alreadyLinked = winerimToMapping.has(w.winerim_id);
                  return (
                    <button
                      key={w.winerim_id}
                      type="button"
                      disabled={saving}
                      onClick={() => linkDialog?.agora && performLink(w, linkDialog.agora)}
                      className="w-full text-left px-3 py-2 hover:bg-secondary/40 transition-colors disabled:opacity-50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">{w.name}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">
                            #{w.winerim_id}
                            {w.winery ? ` · ${w.winery}` : ""}
                            {w.vintage ? ` · ${w.vintage}` : ""}
                          </p>
                        </div>
                        {alreadyLinked && (
                          <Badge variant="outline" className="text-[10px] shrink-0">Already linked</Badge>
                        )}
                      </div>
                    </button>
                  );
                });
              })()
            )}
          </div>

          {saving && (
            <div className="flex items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Linking…
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────────
function StatCard({
  label, value, tone, icon,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning";
  icon?: React.ReactNode;
}) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide flex items-center gap-1">
        {icon}{label}
      </div>
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function PanelHeader({
  title, count, total, accent,
}: {
  title: string;
  count: number;
  total: number;
  accent: "primary" | "warning";
}) {
  const dotClass = accent === "primary" ? "bg-primary" : "bg-warning";
  return (
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
        {title}
      </h3>
      <Badge variant="outline" className="text-[10px]">
        {count} / {total}
      </Badge>
    </div>
  );
}

function FilterPills({
  value, onChange, options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { v: string; label: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <button
          key={opt.v}
          type="button"
          onClick={() => onChange(opt.v)}
          className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${
            value === opt.v
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-secondary/30 border-border text-muted-foreground hover:bg-secondary/60"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
