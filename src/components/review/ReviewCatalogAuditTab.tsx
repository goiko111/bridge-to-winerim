import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { Download, Loader2, RefreshCw, Search } from "lucide-react";
import {
  AUDIT_STATUS_LABELS,
  REVIEW_FORMAT_FILTER_KEYS,
  downloadCsv,
  formatAuditStatusLabel,
  formatBoolean,
  formatDateTime,
  formatLabel,
  formatLatency,
  formatNumber,
} from "@/lib/catalogReview";
import ReviewAgoraCoverageTable from "./ReviewAgoraCoverageTable";

type AuditRow = {
  winerim_id: string;
  wine_name: string | null;
  wine_type: string | null;
  format_key: string;
  capacity_liters: number | null;
  winerim_price: number | null;
  agora_price: number | null;
  agora_product_id: string | null;
  agora_family_id: string | null;
  agora_family_name: string | null;
  stock_id: number | null;
  agora_visible: boolean | null;
  agora_saleable: boolean | null;
  read_at: string | null;
  readback_fresh: boolean | null;
  detected_at: string | null;
  queued_at: string | null;
  applied_at: string | null;
  push_status: string | null;
  push_error: string | null;
  differences: string[] | null;
  audit_status: string;
  comparison: string | null;
  next_action: string | null;
  latency_seconds: number | null;
  total_count: number;
};

type Summary = Record<string, number | string | null>;

const PAGE_SIZE = 25;
const FILTER_KEY = "review.audit.filters";
const READBACK_MAX_AGE_MIN = 120;

export default function ReviewCatalogAuditTab({ connectionId }: { connectionId: string }) {
  const stored = (() => {
    try {
      return JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}");
    } catch {
      return {};
    }
  })();
  const [search, setSearch] = useState<string>(stored.search ?? "");
  const [status, setStatus] = useState<string>(stored.status ?? "");
  const [format, setFormat] = useState<string>(stored.format ?? "");
  const [direction, setDirection] = useState<"winerim" | "agora">(
    stored.direction === "agora" ? "agora" : "winerim",
  );
  const [debounced, setDebounced] = useState(search);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ search, status, format, direction }));
  }, [search, status, format, direction]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    if (!connectionId) return;
    if (direction === "agora") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const [listRes, summaryRes] = await Promise.all([
      supabase.rpc("review_catalog_audit", {
        p_connection_id: connectionId,
        p_search: debounced || null,
        p_status: status || null,
        p_format: format || null,
        p_readback_max_age_minutes: READBACK_MAX_AGE_MIN,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      }),
      supabase.rpc("review_catalog_audit_summary", {
        p_connection_id: connectionId,
        p_readback_max_age_minutes: READBACK_MAX_AGE_MIN,
      }),
    ]);
    if (listRes.error) {
      setError(listRes.error.message);
      setRows([]);
      setTotal(0);
    } else {
      const list = (listRes.data ?? []) as AuditRow[];
      setRows(list);
      setTotal(list.length ? Number(list[0].total_count) : 0);
    }
    if (!summaryRes.error) setSummary(((summaryRes.data ?? [])[0] ?? null) as Summary | null);
    setLoading(false);
  }, [connectionId, debounced, status, format, page, direction]);

  useEffect(() => {
    load();
  }, [load]);

  /** Read-only readback: reads Agora's product master and stores a snapshot. */
  const runReadback = async () => {
    setReading(true);
    const { data, error: err } = await supabase.functions.invoke("catalog-readback", {
      body: { connectionId, forceRefresh: true },
    });
    setReading(false);
    if (err) {
      toast({ title: "No se pudo leer Ágora", description: err.message, variant: "destructive" });
      return;
    }
    const res = data as any;
    if (res?.error) {
      toast({ title: "Lectura de Ágora no disponible", description: res.error, variant: "destructive" });
      return;
    }
    toast({
      title: "Lectura de Ágora completada",
      description: `${res?.expectedVariants ?? 0} variantes comparadas · ${res?.foundInAgora ?? 0} encontradas · ${res?.missingInAgora ?? 0} ausentes.`,
    });
    load();
  };

  const exportCsv = () =>
    downloadCsv(
      `revision-auditoria-catalogo-${connectionId}.csv`,
      rows.map((r) => ({
        winerim_id: r.winerim_id,
        vino: r.wine_name ?? "",
        tipo: r.wine_type ?? "",
        formato: r.format_key,
        etiqueta_formato: formatLabel(r.format_key),
        capacidad_l: r.capacity_liters ?? "",
        precio_winerim: r.winerim_price ?? "",
        precio_agora: r.agora_price ?? "",
        producto_agora: r.agora_product_id ?? "",
        familia_agora: r.agora_family_name ?? r.agora_family_id ?? "",
        stock_ref: r.stock_id ?? "",
        visible: r.agora_visible === null ? "DESCONOCIDO" : r.agora_visible,
        vendible: r.agora_saleable === null ? "DESCONOCIDO" : r.agora_saleable,
        lectura_agora: r.read_at ?? "",
        lectura_fresca: r.readback_fresh === null ? "DESCONOCIDO" : r.readback_fresh,
        detectado: r.detected_at ?? "",
        encolado: r.queued_at ?? "",
        aplicado_writer: r.applied_at ?? "",
        envio: r.push_status ?? "",
        error_envio: r.push_error ?? "",
        latencia: r.latency_seconds === null ? "SIN_EVIDENCIA" : r.latency_seconds,
        estado: r.audit_status,
        comparacion: r.comparison ?? "",
        siguiente_accion: r.next_action ?? "",
        diferencias: (r.differences ?? []).join("|"),
      })),
    );

  const summaryChips = summary
    ? [
        { label: "Vinos activos", value: summary.active_wines },
        { label: "Variantes esperadas", value: summary.expected_variants },
        { label: "Leídas en Ágora", value: summary.read_variants },
        { label: "Coinciden en vivo", value: summary.matched_live },
        { label: "No están en Ágora", value: summary.missing_in_agora },
        { label: "Precio distinto", value: summary.price_mismatch },
        { label: "Formato distinto", value: summary.format_mismatch },
        { label: "Familia distinta", value: summary.family_mismatch },
        { label: "No vendibles", value: summary.not_saleable },
        { label: "Sin tecla principal / ocultos", value: summary.hidden },
        { label: "Envío pendiente", value: summary.pending_push },
        { label: "Envío fallido", value: summary.push_failed },
        { label: "Sin lectura fresca", value: summary.no_current_readback },
        { label: "Solo legacy", value: summary.legacy_only },
        { label: "Ambiguos", value: summary.ambiguous },
      ]
    : [];

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs">
        <span className="text-muted-foreground">
          Última lectura de Ágora:{" "}
          <span className="text-foreground">
            {summary?.last_read_at ? formatDateTime(String(summary.last_read_at)) : "sin lectura"}
          </span>{" "}
          · sin lectura fresca (≤ {READBACK_MAX_AGE_MIN} min) el estado es «Sin lectura fresca», nunca coincidente.
        </span>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={reading} onClick={runReadback}>
          {reading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Leer Ágora ahora (solo lectura)
        </Button>
      </Card>

      <Card className="flex flex-wrap items-center gap-2 p-3 text-xs">
        <span className="text-muted-foreground">Dirección de la comparación:</span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={direction === "winerim" ? "default" : "outline"}
            className="h-8 text-xs"
            onClick={() => setDirection("winerim")}
          >
            Winerim → Ágora
          </Button>
          <Button
            size="sm"
            variant={direction === "agora" ? "default" : "outline"}
            className="h-8 text-xs"
            onClick={() => setDirection("agora")}
          >
            Ágora → Winerim
          </Button>
        </div>
        <span className="text-muted-foreground">
          {direction === "winerim"
            ? "Cada variante activa de Winerim y si está en Ágora, con qué precio y en qué familia."
            : "Cada producto de vino del catálogo de Ágora y si tiene vino de Winerim asociado."}
        </span>
      </Card>

      {direction === "agora" ? (
        <ReviewAgoraCoverageTable connectionId={connectionId} />
      ) : (
      <>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {summaryChips.map((c) => (
          <Card key={c.label} className="p-3">
            <div className="text-[11px] text-muted-foreground">{c.label}</div>
            <div className="text-lg font-semibold">
              {c.value === null || c.value === undefined ? "—" : formatNumber(Number(c.value), 0)}
            </div>
          </Card>
        ))}
      </div>

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-9 text-xs"
            placeholder="Vino, ID Winerim o producto Ágora"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Todos los estados</option>
          {Object.keys(AUDIT_STATUS_LABELS).map((k) => (
            <option key={k} value={k}>
              {AUDIT_STATUS_LABELS[k]}
            </option>
          ))}
        </select>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={format}
          onChange={(e) => {
            setFormat(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Todos los formatos</option>
          {REVIEW_FORMAT_FILTER_KEYS.map((k) => (
            <option key={k} value={k}>
              {formatLabel(k)}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={exportCsv}>
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
      </Card>

      {error && <Card className="p-3 text-xs text-destructive">{error}</Card>}

      {loading ? (
        <Card className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando auditoría…
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border text-left text-[11px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Vino / producto</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2">Formato</th>
                <th className="px-3 py-2">Capacidad</th>
                <th className="px-3 py-2">Winerim €</th>
                <th className="px-3 py-2">Ágora €</th>
                <th className="px-3 py-2">Familia Ágora</th>
                <th className="px-3 py-2">Stock ref</th>
                <th className="px-3 py-2">Visible</th>
                <th className="px-3 py-2">Vendible</th>
                <th className="px-3 py-2">Lectura</th>
                <th className="px-3 py-2">Evidencia envío</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Comparación / acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-3 py-4 text-muted-foreground">
                    Sin variantes con estos filtros.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={`${r.winerim_id}-${r.format_key}`}>
                  <td className="px-3 py-2">
                    <div>{r.wine_name ?? "—"}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {r.winerim_id}
                      {r.agora_product_id ? ` → ${r.agora_product_id}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{r.wine_type ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary">{formatLabel(r.format_key)}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {r.capacity_liters !== null ? `${formatNumber(r.capacity_liters, 3)} L` : "—"}
                  </td>
                  <td className="px-3 py-2">{formatNumber(r.winerim_price)}</td>
                  <td className="px-3 py-2">{formatNumber(r.agora_price)}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.agora_family_name ?? r.agora_family_id ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px]">{r.stock_id ?? "—"}</td>
                  <td className="px-3 py-2">{formatBoolean(r.agora_visible)}</td>
                  <td className="px-3 py-2">{formatBoolean(r.agora_saleable)}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDateTime(r.read_at)}
                    <div>{r.readback_fresh ? "fresca" : "no fresca"}</div>
                  </td>
                  <td className="px-3 py-2 text-[10px] text-muted-foreground">
                    <div>det. {formatDateTime(r.detected_at)}</div>
                    <div>enc. {formatDateTime(r.queued_at)}</div>
                    <div>apl. {formatDateTime(r.applied_at)}</div>
                    <div>latencia {formatLatency(r.latency_seconds)}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={
                        r.audit_status === "MATCHED_LIVE"
                          ? "default"
                          : r.audit_status === "NO_CURRENT_READBACK" || r.audit_status === "AMBIGUOUS"
                            ? "outline"
                            : r.audit_status === "HIDDEN" && r.agora_saleable === true
                              ? "secondary"
                              : "destructive"
                      }
                    >
                      {formatAuditStatusLabel(r.audit_status, r.agora_saleable)}
                    </Badge>
                    {r.push_status && (
                      <div className="mt-1 font-mono text-[10px] text-muted-foreground">{r.push_status}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground">
                    <div>{r.comparison ?? "—"}</div>
                    <div className="mt-1 text-foreground">{r.next_action ?? "—"}</div>
                    {r.push_error && <div className="mt-1 text-destructive">{r.push_error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total} variantes · página {page + 1} de {Math.max(1, Math.ceil(total / PAGE_SIZE))}
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Anterior
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            disabled={loading || (page + 1) * PAGE_SIZE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Siguiente
          </Button>
        </div>
      </div>
    </div>
  );
}
