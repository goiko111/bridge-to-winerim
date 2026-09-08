import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash, Clipboard, RefreshCw, Wine, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import {
  evaluateAgoraFleetConnection,
  signalRank,
  type AgoraFleetMetrics,
  type FleetSignal,
} from "@/lib/agoraFleetStatus";

interface AgoraConnectionRow {
  id: string;
  location_name: string;
  enabled: boolean;
  write_mode: string | null;
  last_sync_at: string | null;
  last_business_day_synced: string | null;
  catalog_sync_enabled: boolean | null;
  circuit_breaker_paused_until: string | null;
  circuit_breaker_reason: string | null;
  consecutive_failures: number | null;
}

interface AgoraFleetRow {
  connection: AgoraConnectionRow;
  metrics: AgoraFleetMetrics;
  latestError: string | null;
}

const signalMeta: Record<FleetSignal, { className: string; icon: typeof CheckCircle2; label: string }> = {
  ok: {
    label: "OK",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    icon: CheckCircle2,
  },
  warn: {
    label: "Revisar",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: AlertTriangle,
  },
  fail: {
    label: "Falla",
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    icon: XCircle,
  },
  disabled: {
    label: "Apagada",
    className: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
    icon: CircleSlash,
  },
};

function sinceLabel(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function asBool(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

function looksLikeWine(value: string): boolean {
  const text = value.toLowerCase();
  return /\b(vino|vinos|tinto|tintos|blanco|blancos|rosado|rosados|copa|copas|magnum|espumoso|espumosos|champagne|cava|dulce|dulces|generoso|generosos|bodega|ribera|rioja)\b/.test(text);
}

function countLegacyWineVisibleProducts(masterData: unknown): number {
  const row = (masterData || {}) as {
    families_json?: Array<Record<string, unknown>>;
    products_summary_json?: Array<Record<string, unknown>>;
  };
  const families = Array.isArray(row.families_json) ? row.families_json : [];
  const products = Array.isArray(row.products_summary_json) ? row.products_summary_json : [];
  const familyById = new Map(families.map((family) => [String(family.Id || ""), family]));

  return products.filter((product) => {
    const family = familyById.get(String(product.FamilyId || ""));
    const familyName = String(family?.Name || "");
    const productName = String(product.Name || "");
    const isWinerim = familyName.toUpperCase().includes("WINERIM") || productName.startsWith("B ") || productName.startsWith("C ") || productName.startsWith("M ");
    if (isWinerim) return false;
    if (!looksLikeWine(`${familyName} ${productName}`)) return false;

    const familyVisible = asBool(family?.ShowInPos, true) && !family?.DeletionDate;
    const productVisible = asBool(product.UseAsDirectSale, true) && asBool(product.SaleableAsMain, true) && !product.DeletionDate;
    return familyVisible && productVisible;
  }).length;
}

async function countRows(table: string, connectionId: string, configure: (query: any) => any): Promise<number> {
  const query = supabase.from(table as any).select("id", { count: "exact", head: true }).eq("connection_id", connectionId);
  const { count } = await configure(query);
  return count || 0;
}

function compactError(value: unknown): string | null {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function buildIncidentSummary(row: AgoraFleetRow): string {
  const verdict = evaluateAgoraFleetConnection(row.metrics);
  return [
    `Restaurante: ${row.connection.location_name}`,
    `Estado: ${verdict.label}`,
    `Detalle: ${verdict.detail}`,
    `Ultima sincronizacion: ${sinceLabel(row.connection.last_sync_at)}`,
    `Ultimo dia sincronizado: ${row.connection.last_business_day_synced || "-"}`,
    `Productos Winerim verificados: ${row.metrics.verifiedProducts}`,
    `Ventas mapeadas 7d: ${row.metrics.mappedSales7d}/${row.metrics.salesLines7d}`,
    `Stock 7d: ${row.metrics.stockSuccess7d} OK / ${row.metrics.stockFailedOpen} fallos abiertos`,
    `Cola: ${row.metrics.outboundOpen} abierta / ${row.metrics.outboundFailed} fallos`,
    `Legacy posible visible: ${row.metrics.legacyWineVisibleProducts}`,
    `Ultimo error: ${row.latestError || "-"}`,
  ].join("\n");
}

export default function AgoraFleetStatus() {
  const [rows, setRows] = useState<AgoraFleetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchFleet = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const { data, error: connError } = await supabase
        .from("pos_connections")
        .select("id, location_name, enabled, write_mode, last_sync_at, last_business_day_synced, catalog_sync_enabled, circuit_breaker_paused_until, circuit_breaker_reason, consecutive_failures")
        .eq("provider", "agora")
        .order("location_name", { ascending: true });

      if (connError) throw connError;
      const connections = (data || []) as AgoraConnectionRow[];
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();

      const nextRows = await Promise.all(connections.map(async (connection) => {
        const [
          verifiedProducts,
          masterRes,
          latestStockError,
          latestOutboundError,
          mappedSales7d,
          salesLines7d,
          stockSuccess7d,
          stockFailedOpen,
          outboundOpen,
          outboundFailed,
        ] = await Promise.all([
          countRows("winerim_push_tracking", connection.id, (query) => query.eq("sync_status", "VERIFIED")),
          supabase.from("agora_master_data").select("families_json, products_summary_json").eq("connection_id", connection.id).maybeSingle(),
          supabase.from("stock_sync_log").select("error_message, product_name, created_at").eq("connection_id", connection.id).in("status", ["FAILED", "BLOCKED"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
          supabase.from("outbound_tasks").select("last_error, blocked_reason, task_type, created_at").eq("connection_id", connection.id).in("status", ["FAILED", "BLOCKED"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
          countRows("sales_line_items", connection.id, (query) => query.not("winerim_product_id", "is", null).gte("created_at", sevenDaysAgo)),
          countRows("sales_line_items", connection.id, (query) => query.gte("created_at", sevenDaysAgo)),
          countRows("stock_sync_log", connection.id, (query) => query.eq("status", "SUCCESS").gte("created_at", sevenDaysAgo)),
          countRows("stock_sync_log", connection.id, (query) => query.in("status", ["FAILED", "BLOCKED", "PENDING"])),
          countRows("outbound_tasks", connection.id, (query) => query.in("status", ["QUEUED", "RUNNING"])),
          countRows("outbound_tasks", connection.id, (query) => query.in("status", ["FAILED", "BLOCKED"])),
        ]);

        const stockError = latestStockError.data
          ? compactError(`${latestStockError.data.product_name || "Stock"}: ${latestStockError.data.error_message || ""}`)
          : null;
        const outboundError = latestOutboundError.data
          ? compactError(`${latestOutboundError.data.task_type || "Outbound"}: ${latestOutboundError.data.last_error || latestOutboundError.data.blocked_reason || ""}`)
          : null;

        return {
          connection,
          latestError: stockError || outboundError,
          metrics: {
            enabled: connection.enabled,
            writeMode: connection.write_mode,
            lastSyncAt: connection.last_sync_at,
            lastBusinessDaySynced: connection.last_business_day_synced,
            circuitBreakerPausedUntil: connection.circuit_breaker_paused_until,
            consecutiveFailures: connection.consecutive_failures || 0,
            verifiedProducts,
            legacyWineVisibleProducts: countLegacyWineVisibleProducts(masterRes.data),
            mappedSales7d,
            salesLines7d,
            stockSuccess7d,
            stockFailedOpen,
            outboundOpen,
            outboundFailed,
          },
        };
      }));

      setRows(nextRows);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "No se pudo cargar la flota Agora.");
    } finally {
      setLoading(false);
    }
  }, []);

  const copyIncident = async (row: AgoraFleetRow) => {
    await navigator.clipboard.writeText(buildIncidentSummary(row));
    setCopiedId(row.connection.id);
    window.setTimeout(() => setCopiedId(null), 1600);
  };

  useEffect(() => {
    fetchFleet();
  }, [fetchFleet]);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aVerdict = evaluateAgoraFleetConnection(a.metrics);
      const bVerdict = evaluateAgoraFleetConnection(b.metrics);
      return signalRank(aVerdict.signal) - signalRank(bVerdict.signal)
        || a.connection.location_name.localeCompare(b.connection.location_name);
    });
  }, [rows]);

  const summary = useMemo(() => {
    return rows.reduce((acc, row) => {
      const verdict = evaluateAgoraFleetConnection(row.metrics);
      acc[verdict.signal] += 1;
      return acc;
    }, { ok: 0, warn: 0, fail: 0, disabled: 0 } as Record<FleetSignal, number>);
  }, [rows]);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Flota Agora</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Estado operativo por restaurante: conexión, catálogo, ventas, stock y cola.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchFleet} disabled={loading}>
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        {(["fail", "warn", "ok", "disabled"] as FleetSignal[]).map((signal) => {
          const meta = signalMeta[signal];
          const Icon = meta.icon;
          return (
            <Card key={signal}>
              <CardContent className="flex items-center justify-between pt-6">
                <div>
                  <p className="text-xs uppercase text-muted-foreground">{meta.label}</p>
                  <p className="mt-1 text-lg font-semibold text-foreground">{summary[signal]}</p>
                </div>
                <Icon className="h-5 w-5 text-muted-foreground" />
              </CardContent>
            </Card>
          );
        })}
      </div>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="grid grid-cols-[minmax(180px,1.25fr)_120px_90px_105px_120px_120px_90px_minmax(220px,1.1fr)_90px] border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span>Restaurante</span>
          <span>Estado</span>
          <span>Catálogo</span>
          <span>Ventas 7d</span>
          <span>Stock 7d</span>
          <span>Cola</span>
          <span>Legacy</span>
          <span>Último error</span>
          <span>Soporte</span>
        </div>

        {loading && rows.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">Cargando conexiones Agora...</div>
        )}

        {!loading && sortedRows.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">No hay conexiones Agora.</div>
        )}

        {sortedRows.map((row) => {
          const verdict = evaluateAgoraFleetConnection(row.metrics);
          const meta = signalMeta[verdict.signal];
          const Icon = meta.icon;
          return (
            <div key={row.connection.id} className="grid grid-cols-[minmax(180px,1.25fr)_120px_90px_105px_120px_120px_90px_minmax(220px,1.1fr)_90px] items-center border-b border-border px-4 py-3 text-sm last:border-b-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Wine className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-foreground">{row.connection.location_name}</span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  Last sync: {sinceLabel(row.connection.last_sync_at)}
                </p>
              </div>
              <Badge variant="outline" className={meta.className}>
                <Icon className="mr-1 h-3 w-3" />
                {meta.label}
              </Badge>
              <span className="text-muted-foreground">{row.metrics.verifiedProducts}</span>
              <span className="text-muted-foreground">
                {row.metrics.mappedSales7d}/{row.metrics.salesLines7d}
              </span>
              <span className={row.metrics.stockFailedOpen > 0 ? "text-red-500" : "text-muted-foreground"}>
                {row.metrics.stockSuccess7d} OK / {row.metrics.stockFailedOpen} fallo
              </span>
              <span className={row.metrics.outboundFailed > 0 ? "text-amber-500" : "text-muted-foreground"}>
                {row.metrics.outboundOpen} abierta / {row.metrics.outboundFailed} fallo
              </span>
              <span className={row.metrics.legacyWineVisibleProducts > 0 ? "text-amber-500" : "text-muted-foreground"}>
                {row.metrics.legacyWineVisibleProducts}
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{row.latestError || verdict.label}</p>
                <p className="truncate text-xs text-muted-foreground" title={row.latestError || verdict.detail}>
                  {row.latestError ? verdict.detail : ""}
                  {row.metrics.consecutiveFailures > 0 ? ` · ${row.metrics.consecutiveFailures} fallos seguidos` : ""}
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => copyIncident(row)}>
                <Clipboard className="mr-1 h-3.5 w-3.5" />
                {copiedId === row.connection.id ? "OK" : "Copiar"}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
