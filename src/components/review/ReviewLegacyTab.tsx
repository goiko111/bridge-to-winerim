import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Loader2, Search } from "lucide-react";
import {
  LEGACY_STATE_LABELS,
  downloadCsv,
  formatBoolean,
  formatDateTime,
  formatLabel,
  formatNumber,
} from "@/lib/catalogReview";

type LegacyRow = {
  provider_product_id: string;
  name: string | null;
  family: string | null;
  sale_format: string;
  format_key: string;
  price: number | null;
  agora_visible: boolean | null;
  agora_saleable: boolean | null;
  units_recent: number | null;
  last_sale_at: string | null;
  mapping_status: string | null;
  tracking_status: string | null;
  legacy_state: string;
  reason: string;
  next_action: string;
  source: string;
  total_count: number;
};

const PAGE_SIZE = 25;
const FILTER_KEY = "review.legacy.filters";

export default function ReviewLegacyTab({
  connectionId,
  onOpenInReview,
}: {
  connectionId: string;
  onOpenInReview: (search: string) => void;
}) {
  const [search, setSearch] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}").search ?? "";
    } catch {
      return "";
    }
  });
  const [state, setState] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}").state ?? "";
    } catch {
      return "";
    }
  });
  const [debounced, setDebounced] = useState(search);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<LegacyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ search, state }));
  }, [search, state]);

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
    const { data, error: err } = await supabase.rpc("review_legacy_products", {
      p_connection_id: connectionId,
      p_search: debounced || null,
      p_state: state || null,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    });
    if (err) {
      setError(err.message);
      setRows([]);
      setTotal(0);
    } else {
      const list = (data ?? []) as LegacyRow[];
      setRows(list);
      setTotal(list.length ? Number(list[0].total_count) : 0);
    }
    setLoading(false);
  }, [connectionId, debounced, state, page]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () =>
    downloadCsv(
      `revision-legacy-${connectionId}.csv`,
      rows.map((r) => ({
        provider_product_id: r.provider_product_id,
        nombre: r.name ?? "",
        familia: r.family ?? "",
        formato_agora: r.sale_format,
        formato_normalizado: r.format_key,
        precio: r.price ?? "",
        visible: r.agora_visible === null ? "DESCONOCIDO" : r.agora_visible,
        vendible: r.agora_saleable === null ? "DESCONOCIDO" : r.agora_saleable,
        unidades_30d: r.units_recent ?? "",
        ultima_venta: r.last_sale_at ?? "",
        mapping: r.mapping_status ?? "",
        tracking: r.tracking_status ?? "",
        estado: r.legacy_state,
        motivo: r.reason,
        siguiente_accion: r.next_action,
        origen: r.source,
      })),
    );

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-9 text-xs"
            placeholder="Nombre o ID de Ágora"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Todos los estados legacy</option>
          {Object.keys(LEGACY_STATE_LABELS).map((k) => (
            <option key={k} value={k}>
              {LEGACY_STATE_LABELS[k]}
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
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando productos legacy…
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border text-left text-[11px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2">ID / Nombre</th>
                <th className="px-3 py-2">Familia</th>
                <th className="px-3 py-2">Formato</th>
                <th className="px-3 py-2">Precio</th>
                <th className="px-3 py-2">Visible</th>
                <th className="px-3 py-2">Vendible</th>
                <th className="px-3 py-2">Últ. venta / uds</th>
                <th className="px-3 py-2">Mapa / tracking</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Motivo y acción</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-4 text-muted-foreground">
                    Sin productos legacy con estos filtros.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={`${r.provider_product_id}-${r.sale_format}`}>
                  <td className="px-3 py-2">
                    <div className="font-mono text-[10px] text-muted-foreground">#{r.provider_product_id}</div>
                    <div>{r.name ?? "—"}</div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{r.family ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary">{formatLabel(r.format_key)}</Badge>
                    <div className="font-mono text-[10px] text-muted-foreground">{r.sale_format}</div>
                  </td>
                  <td className="px-3 py-2">{r.price !== null ? `${formatNumber(r.price)} €` : "—"}</td>
                  <td className="px-3 py-2">{formatBoolean(r.agora_visible)}</td>
                  <td className="px-3 py-2">{formatBoolean(r.agora_saleable)}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDateTime(r.last_sale_at)}
                    <div>{r.units_recent !== null ? `${formatNumber(r.units_recent, 0)} uds` : "—"}</div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.mapping_status ?? "sin mapa"} / {r.tracking_status ?? "sin tracking"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={r.legacy_state === "IDENTITY_BLOCKED" ? "destructive" : "outline"}>
                      {LEGACY_STATE_LABELS[r.legacy_state] ?? r.legacy_state}
                    </Badge>
                    <div className="mt-1 text-[10px] text-muted-foreground">{r.source}</div>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground">
                    <div>{r.reason}</div>
                    <div className="mt-1 text-foreground">{r.next_action}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px]"
                      onClick={() => onOpenInReview(r.provider_product_id)}
                    >
                      Abrir en revisión
                    </Button>
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
