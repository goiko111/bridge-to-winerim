import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Loader2, Search } from "lucide-react";
import {
  REVIEW_FORMAT_FILTER_KEYS,
  downloadCsv,
  formatBoolean,
  formatLabel,
  formatNumber,
} from "@/lib/catalogReview";

type CoverageRow = {
  provider_product_id: string;
  name: string | null;
  family: string | null;
  sale_format: string | null;
  format_key: string;
  agora_price: number | null;
  agora_visible: boolean | null;
  agora_saleable: boolean | null;
  linked_winerim_id: string | null;
  linked_winerim_name: string | null;
  link_source: string | null;
  winerim_price: number | null;
  winerim_active: boolean | null;
  coverage_status: string;
  comparison: string | null;
  next_action: string | null;
  total_count: number;
};

export const COVERAGE_STATUS_LABELS: Record<string, string> = {
  LINKED_OK: "Vinculado correcto",
  LINKED_PRICE_MISMATCH: "Precio distinto",
  LINKED_NO_PRICE_REF: "Sin precio de referencia",
  LINKED_WINE_INACTIVE: "Vino inactivo en Winerim",
  LINKED_WINE_MISSING: "Vino no encontrado en Winerim",
  NOT_IN_WINERIM: "No está en Winerim",
  IDENTITY_BLOCKED: "Formato sin dato",
};

const LINK_SOURCE_LABELS: Record<string, string> = {
  MAPA_CONFIRMADO: "mapa confirmado",
  ENVIO_WINERIM: "envío Winerim",
  CATALOGO_AGORA: "catálogo Ágora",
};

const PAGE_SIZE = 25;
const FILTER_KEY = "review.coverage.filters";

export default function ReviewAgoraCoverageTable({ connectionId }: { connectionId: string }) {
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
  const [debounced, setDebounced] = useState(search);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<CoverageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Record<string, number | null> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ search, status, format }));
  }, [search, status, format]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    setError(null);
    const [listRes, summaryRes] = await Promise.all([
      supabase.rpc("review_agora_coverage", {
        p_connection_id: connectionId,
        p_search: debounced || null,
        p_status: status || null,
        p_format: format || null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      }),
      supabase.rpc("review_agora_coverage_summary", { p_connection_id: connectionId }),
    ]);
    if (listRes.error) {
      setError(listRes.error.message);
      setRows([]);
      setTotal(0);
    } else {
      const list = (listRes.data ?? []) as CoverageRow[];
      setRows(list);
      setTotal(list.length ? Number(list[0].total_count) : 0);
    }
    if (!summaryRes.error) {
      setSummary(((summaryRes.data ?? [])[0] ?? null) as Record<string, number | null> | null);
    }
    setLoading(false);
  }, [connectionId, debounced, status, format, page]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () =>
    downloadCsv(
      `revision-agora-a-winerim-${connectionId}.csv`,
      rows.map((r) => ({
        producto_agora: r.provider_product_id,
        nombre: r.name ?? "",
        familia: r.family ?? "",
        formato_tpv: r.sale_format ?? "",
        formato: r.format_key,
        precio_agora: r.agora_price ?? "",
        visible: r.agora_visible === null ? "DESCONOCIDO" : r.agora_visible,
        vendible: r.agora_saleable === null ? "DESCONOCIDO" : r.agora_saleable,
        winerim_id: r.linked_winerim_id ?? "",
        winerim_nombre: r.linked_winerim_name ?? "",
        origen_vinculo: r.link_source ?? "",
        precio_winerim: r.winerim_price ?? "",
        winerim_activo: r.winerim_active === null ? "DESCONOCIDO" : r.winerim_active,
        estado: r.coverage_status,
        comparacion: r.comparison ?? "",
        siguiente_accion: r.next_action ?? "",
      })),
    );

  const chips = summary
    ? [
        { label: "Productos de vino en Ágora", value: summary.agora_wine_products },
        { label: "Vinculados correctos", value: summary.linked_ok },
        { label: "No están en Winerim", value: summary.not_in_winerim },
        { label: "Precio distinto", value: summary.linked_price_mismatch },
        { label: "Sin precio de referencia", value: summary.linked_no_price_ref },
        { label: "Vino inactivo", value: summary.linked_wine_inactive },
        { label: "Vino no encontrado", value: summary.linked_wine_missing },
        { label: "Formato sin dato", value: summary.identity_blocked },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {chips.map((c) => (
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
            placeholder="Producto Ágora, ID o vino Winerim"
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
          {Object.keys(COVERAGE_STATUS_LABELS).map((k) => (
            <option key={k} value={k}>
              {COVERAGE_STATUS_LABELS[k]}
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
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando cobertura de Ágora…
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border text-left text-[11px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Producto Ágora</th>
                <th className="px-3 py-2">Familia</th>
                <th className="px-3 py-2">Formato</th>
                <th className="px-3 py-2">Ágora €</th>
                <th className="px-3 py-2">Winerim €</th>
                <th className="px-3 py-2">Vino Winerim</th>
                <th className="px-3 py-2">Visible</th>
                <th className="px-3 py-2">Vendible</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Comparación / acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-4 text-muted-foreground">
                    Sin productos de Ágora con estos filtros.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={`${r.provider_product_id}-${r.format_key}`}>
                  <td className="px-3 py-2">
                    <div>{r.name ?? "—"}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{r.provider_product_id}</div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{r.family ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary">{formatLabel(r.format_key)}</Badge>
                  </td>
                  <td className="px-3 py-2">{formatNumber(r.agora_price)}</td>
                  <td className="px-3 py-2">{formatNumber(r.winerim_price)}</td>
                  <td className="px-3 py-2">
                    {r.linked_winerim_id ? (
                      <>
                        <div>{r.linked_winerim_name ?? "—"}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {r.linked_winerim_id}
                          {r.link_source ? ` · ${LINK_SOURCE_LABELS[r.link_source] ?? r.link_source}` : ""}
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Sin vincular</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{formatBoolean(r.agora_visible)}</td>
                  <td className="px-3 py-2">{formatBoolean(r.agora_saleable)}</td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={
                        r.coverage_status === "LINKED_OK"
                          ? "default"
                          : r.coverage_status === "LINKED_NO_PRICE_REF" || r.coverage_status === "IDENTITY_BLOCKED"
                            ? "outline"
                            : "destructive"
                      }
                    >
                      {COVERAGE_STATUS_LABELS[r.coverage_status] ?? r.coverage_status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground">
                    <div>{r.comparison ?? "—"}</div>
                    <div className="mt-1 text-foreground">{r.next_action ?? "—"}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total} productos · página {page + 1} de {Math.max(1, Math.ceil(total / PAGE_SIZE))}
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
