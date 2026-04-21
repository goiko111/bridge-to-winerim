import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Wine, GlassWater, Package, AlertTriangle, CheckCircle2, Clock, XCircle, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  connectionId: string | null;
}

interface SaleLine {
  id: string;
  name: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  format: string | null;
  mapped: boolean;
  winerim_product_id: string | null;
  is_wine_candidate: boolean;
  created_at: string;
  sales_event_id: string;
  business_day: string;
}

interface WinerimWine {
  winerim_id: string;
  name: string;
  stock_quantity: number | null;
  bottle_sale_price: number | null;
  glass_sale_price: number | null;
  magnum_sale_price: number | null;
  is_active: boolean;
}

interface StockSyncEntry {
  id: string;
  sales_line_item_id: string | null;
  winerim_product_id: string | null;
  quantity: number;
  status: string;
  error_message: string | null;
  synced_at: string | null;
  created_at: string;
}

interface AggregatedWine {
  winerim_id: string;
  name: string;
  currentStock: number | null;
  byFormat: Record<string, { soldQty: number; soldAmount: number; lines: SaleLine[] }>;
  totalSoldQty: number;
  totalSoldAmount: number;
  syncEntries: StockSyncEntry[];
  syncStatus: "SYNCED" | "PENDING" | "ERROR" | "PARTIAL" | "UNMAPPED";
  isActive: boolean;
}

interface UnmappedLine extends SaleLine {}

const FORMAT_ICON: Record<string, typeof Wine> = {
  BOTTLE: Wine,
  GLASS: GlassWater,
  MAGNUM: Package,
};

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function AgoraTodaysSalesStock({ connectionId }: Props) {
  const [loading, setLoading] = useState(false);
  const [businessDay, setBusinessDay] = useState<string>(todayISO());
  const [aggregated, setAggregated] = useState<AggregatedWine[]>([]);
  const [unmapped, setUnmapped] = useState<UnmappedLine[]>([]);
  const [eventCount, setEventCount] = useState(0);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);

  const load = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    try {
      // 1. Sales events for the business day
      const { data: events } = await supabase
        .from("sales_events")
        .select("id, business_day, total_amount")
        .eq("connection_id", connectionId)
        .eq("business_day", businessDay);

      const eventIds = (events ?? []).map((e) => e.id);
      setEventCount(eventIds.length);

      if (eventIds.length === 0) {
        setAggregated([]);
        setUnmapped([]);
        setLastLoaded(new Date());
        return;
      }

      // 2. Wine line items in those events
      const { data: linesRaw } = await supabase
        .from("sales_line_items")
        .select("*")
        .eq("connection_id", connectionId)
        .in("sales_event_id", eventIds)
        .eq("is_wine_candidate", true)
        .order("created_at", { ascending: true });

      const lines = (linesRaw ?? []).map((l: any) => ({
        ...l,
        business_day: businessDay,
      })) as SaleLine[];

      const mappedLines = lines.filter((l) => l.mapped && l.winerim_product_id);
      const unmappedLines = lines.filter((l) => !l.mapped || !l.winerim_product_id);
      setUnmapped(unmappedLines);

      // 3. Distinct winerim_ids
      const winerimIds = Array.from(new Set(mappedLines.map((l) => l.winerim_product_id!).filter(Boolean)));

      // 4. Fetch winerim wines for stock + activity
      let wines: WinerimWine[] = [];
      if (winerimIds.length > 0) {
        const { data: winesRaw } = await supabase
          .from("winerim_wines")
          .select("winerim_id, name, stock_quantity, bottle_sale_price, glass_sale_price, magnum_sale_price, is_active")
          .eq("connection_id", connectionId)
          .in("winerim_id", winerimIds);
        wines = (winesRaw ?? []) as WinerimWine[];
      }

      // 5. Stock sync log entries for today's lines
      const lineIds = mappedLines.map((l) => l.id);
      let syncLog: StockSyncEntry[] = [];
      if (lineIds.length > 0) {
        const { data: logRaw } = await supabase
          .from("stock_sync_log")
          .select("id, sales_line_item_id, winerim_product_id, quantity, status, error_message, synced_at, created_at")
          .eq("connection_id", connectionId)
          .in("sales_line_item_id", lineIds);
        syncLog = (logRaw ?? []) as StockSyncEntry[];
      }

      // 6. Aggregate per winerim_id
      const byWine = new Map<string, AggregatedWine>();
      for (const line of mappedLines) {
        const wid = line.winerim_product_id!;
        const wine = wines.find((w) => w.winerim_id === wid);
        const fmt = (line.format || "BOTTLE").toUpperCase();
        let entry = byWine.get(wid);
        if (!entry) {
          entry = {
            winerim_id: wid,
            name: wine?.name ?? line.name,
            currentStock: wine?.stock_quantity ?? null,
            byFormat: {},
            totalSoldQty: 0,
            totalSoldAmount: 0,
            syncEntries: [],
            syncStatus: "PENDING",
            isActive: wine?.is_active ?? true,
          };
          byWine.set(wid, entry);
        }
        if (!entry.byFormat[fmt]) {
          entry.byFormat[fmt] = { soldQty: 0, soldAmount: 0, lines: [] };
        }
        entry.byFormat[fmt].soldQty += Number(line.quantity);
        entry.byFormat[fmt].soldAmount += Number(line.total_amount);
        entry.byFormat[fmt].lines.push(line);
        entry.totalSoldQty += Number(line.quantity);
        entry.totalSoldAmount += Number(line.total_amount);
      }

      // Attach sync entries + compute status
      for (const entry of byWine.values()) {
        const entries = syncLog.filter((s) => s.winerim_product_id === entry.winerim_id);
        entry.syncEntries = entries.sort((a, b) => (b.created_at).localeCompare(a.created_at));
        if (entries.length === 0) {
          entry.syncStatus = "PENDING";
        } else {
          const allSynced = entries.every((e) => e.status === "SYNCED");
          const anyError = entries.some((e) => e.status === "ERROR" || e.status === "FAILED");
          const anyPending = entries.some((e) => e.status === "PENDING" || e.status === "QUEUED");
          if (anyError) entry.syncStatus = "ERROR";
          else if (anyPending && !allSynced) entry.syncStatus = "PARTIAL";
          else if (allSynced) entry.syncStatus = "SYNCED";
          else entry.syncStatus = "PENDING";
        }
      }

      const arr = Array.from(byWine.values()).sort((a, b) => b.totalSoldQty - a.totalSoldQty);
      setAggregated(arr);
      setLastLoaded(new Date());
    } catch (err) {
      console.error("Failed to load today's sales/stock:", err);
    } finally {
      setLoading(false);
    }
  }, [connectionId, businessDay]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh every 60s
  useEffect(() => {
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  const totals = useMemo(() => {
    const totalUnits = aggregated.reduce((acc, w) => acc + w.totalSoldQty, 0);
    const totalAmount = aggregated.reduce((acc, w) => acc + w.totalSoldAmount, 0);
    const synced = aggregated.filter((w) => w.syncStatus === "SYNCED").length;
    const pending = aggregated.filter((w) => w.syncStatus === "PENDING" || w.syncStatus === "PARTIAL").length;
    const errors = aggregated.filter((w) => w.syncStatus === "ERROR").length;
    return { totalUnits, totalAmount, synced, pending, errors, distinctWines: aggregated.length };
  }, [aggregated]);

  const renderSyncBadge = (status: AggregatedWine["syncStatus"]) => {
    switch (status) {
      case "SYNCED":
        return <Badge variant="outline" className="border-success/40 text-success bg-success/10 gap-1"><CheckCircle2 className="h-3 w-3" /> Sincronizado</Badge>;
      case "PENDING":
        return <Badge variant="outline" className="border-amber-500/40 text-amber-600 bg-amber-500/10 gap-1"><Clock className="h-3 w-3" /> Pendiente</Badge>;
      case "PARTIAL":
        return <Badge variant="outline" className="border-amber-500/40 text-amber-600 bg-amber-500/10 gap-1"><Clock className="h-3 w-3" /> Parcial</Badge>;
      case "ERROR":
        return <Badge variant="outline" className="border-destructive/40 text-destructive bg-destructive/10 gap-1"><XCircle className="h-3 w-3" /> Error</Badge>;
      default:
        return <Badge variant="outline">—</Badge>;
    }
  };

  if (!connectionId) {
    return <p className="text-sm text-muted-foreground">Selecciona una conexión primero.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Ventas de vinos del día · Stock</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Vinos Winerim vendidos hoy en Agora con stock actual y estado de sincronización a Winerim.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-muted-foreground flex items-center gap-1">
              <Calendar className="h-3 w-3" /> Día comercial
            </label>
            <input
              type="date"
              value={businessDay}
              onChange={(e) => setBusinessDay(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refrescar
          </Button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        <KpiCard label="Tickets" value={String(eventCount)} />
        <KpiCard label="Vinos distintos" value={String(totals.distinctWines)} />
        <KpiCard label="Unidades" value={totals.totalUnits.toFixed(0)} />
        <KpiCard label="Importe" value={`€${totals.totalAmount.toFixed(2)}`} />
        <KpiCard label="Sincronizados" value={String(totals.synced)} tone="success" />
        <KpiCard label="Pendientes/Errores" value={String(totals.pending + totals.errors)} tone={totals.errors > 0 ? "destructive" : totals.pending > 0 ? "warning" : "default"} />
      </div>

      {lastLoaded && (
        <p className="text-[10px] text-muted-foreground">
          Última actualización: {lastLoaded.toLocaleTimeString()} · Auto-refresca cada 60s
        </p>
      )}

      {loading && aggregated.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && aggregated.length === 0 && unmapped.length === 0 && (
        <div className="text-center py-10 rounded-lg border border-border bg-secondary/20">
          <Wine className="mx-auto h-8 w-8 text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">Sin ventas de vino para {businessDay}.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Las ventas se cargan cada 15 min desde Agora.</p>
        </div>
      )}

      {/* Aggregated wines list */}
      {aggregated.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-2.5 bg-secondary/30 border-b border-border flex items-center justify-between">
            <p className="text-xs font-semibold text-foreground">Vinos vendidos hoy ({aggregated.length})</p>
            <p className="text-[10px] text-muted-foreground">Stock antes = stock actual + vendido hoy</p>
          </div>
          <div className="divide-y divide-border">
            {aggregated.map((w) => {
              const stockNow = w.currentStock ?? null;
              const stockBefore = stockNow !== null ? stockNow + w.totalSoldQty : null;
              return (
                <details key={w.winerim_id} className="group">
                  <summary className="px-4 py-3 cursor-pointer hover:bg-secondary/30 list-none">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-foreground truncate">{w.name}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">Winerim ID: {w.winerim_id}{!w.isActive && " · INACTIVO"}</p>
                      </div>
                      <div className="flex items-center gap-4 text-xs flex-wrap">
                        {/* Format breakdown */}
                        <div className="flex items-center gap-2">
                          {Object.entries(w.byFormat).map(([fmt, data]) => {
                            const Icon = FORMAT_ICON[fmt] ?? Wine;
                            return (
                              <div key={fmt} className="flex items-center gap-1 px-2 py-0.5 rounded bg-secondary/50 border border-border">
                                <Icon className="h-3 w-3 text-muted-foreground" />
                                <span className="font-mono text-foreground">{data.soldQty}</span>
                                <span className="text-[10px] text-muted-foreground">{fmt}</span>
                              </div>
                            );
                          })}
                        </div>
                        {/* Stock */}
                        <div className="text-right">
                          <p className="text-[10px] text-muted-foreground">Stock antes → ahora</p>
                          <p className="font-mono text-foreground">
                            {stockBefore !== null ? stockBefore.toFixed(0) : "—"} → <strong>{stockNow !== null ? stockNow.toFixed(0) : "—"}</strong>
                          </p>
                        </div>
                        {/* Amount */}
                        <div className="text-right">
                          <p className="text-[10px] text-muted-foreground">Importe</p>
                          <p className="font-mono text-foreground">€{w.totalSoldAmount.toFixed(2)}</p>
                        </div>
                        {renderSyncBadge(w.syncStatus)}
                      </div>
                    </div>
                  </summary>
                  {/* Timeline detail */}
                  <div className="px-4 pb-3 pt-1 bg-secondary/10 space-y-2">
                    <p className="text-[10px] uppercase text-muted-foreground font-semibold mt-2">Historial del día</p>
                    <div className="space-y-1">
                      {Object.entries(w.byFormat).flatMap(([fmt, data]) =>
                        data.lines.map((line) => {
                          const syncEntry = w.syncEntries.find((s) => s.sales_line_item_id === line.id);
                          return (
                            <div key={line.id} className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-background/50 border border-border/50">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-muted-foreground">
                                  {new Date(line.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                </span>
                                <Badge variant="outline" className="text-[9px] py-0 h-4">{fmt}</Badge>
                                <span className="text-foreground">{line.quantity} × €{Number(line.unit_price).toFixed(2)}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-foreground">€{Number(line.total_amount).toFixed(2)}</span>
                                {syncEntry ? (
                                  syncEntry.status === "SYNCED" ? (
                                    <span className="text-[10px] text-success flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> sync</span>
                                  ) : syncEntry.status === "ERROR" || syncEntry.status === "FAILED" ? (
                                    <span className="text-[10px] text-destructive flex items-center gap-1" title={syncEntry.error_message ?? ""}>
                                      <XCircle className="h-3 w-3" /> {syncEntry.status.toLowerCase()}
                                    </span>
                                  ) : (
                                    <span className="text-[10px] text-amber-600 flex items-center gap-1"><Clock className="h-3 w-3" /> {syncEntry.status.toLowerCase()}</span>
                                  )
                                ) : (
                                  <span className="text-[10px] text-muted-foreground/70">no sync log</span>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    {w.syncEntries.some((e) => e.error_message) && (
                      <div className="rounded bg-destructive/10 border border-destructive/30 p-2 text-[10px] text-destructive space-y-1">
                        {w.syncEntries.filter((e) => e.error_message).slice(0, 3).map((e) => (
                          <p key={e.id} className="font-mono">⚠ {e.error_message}</p>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      )}

      {/* Unmapped lines */}
      {unmapped.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-2.5 bg-destructive/5 border-b border-border flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
            <p className="text-xs font-semibold text-destructive">Líneas sin matchear ({unmapped.length})</p>
          </div>
          <div className="max-h-[260px] overflow-y-auto divide-y divide-border">
            {unmapped.map((l) => (
              <div key={l.id} className="flex items-center justify-between px-4 py-2 text-xs">
                <div className="flex-1 min-w-0">
                  <p className="text-foreground truncate">{l.name}</p>
                  <p className="text-[10px] text-muted-foreground">{new Date(l.created_at).toLocaleTimeString()} · {l.format ?? "—"}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-foreground">{l.quantity} u · €{Number(l.total_amount).toFixed(2)}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="px-4 py-2 bg-secondary/20 border-t border-border text-[10px] text-muted-foreground">
            Resuélvelas en Wine Matching para que se descuenten del stock.
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "success" | "warning" | "destructive" }) {
  const toneClass =
    tone === "success" ? "text-success" :
    tone === "warning" ? "text-amber-600" :
    tone === "destructive" ? "text-destructive" :
    "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3 text-center">
      <p className={`text-lg font-bold ${toneClass}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
    </div>
  );
}
