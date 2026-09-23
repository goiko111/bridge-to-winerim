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
  formatDateTime,
  formatLabel,
  formatNumber,
} from "@/lib/catalogReview";

type MappedRow = {
  provider_product_id: string;
  provider_product_name: string | null;
  format_key: string;
  family: string | null;
  agora_price: number | null;
  winerim_wine_id: string | null;
  winerim_wine_name: string | null;
  winerim_price: number | null;
  winerim_active: boolean | null;
  match_method: string | null;
  mapped_at: string | null;
  last_synced_at: string | null;
  units_recent: number | null;
  mapped_state: string;
  comparison: string | null;
  total_count: number;
};

const STATE_LABELS: Record<string, string> = {
  OK: "Correcto",
  PRICE_MISMATCH: "Precio distinto",
  NO_PRICE_REF: "Sin precio de referencia",
  WINE_INACTIVE: "Vino inactivo en Winerim",
  WINE_MISSING: "Vino no encontrado en Winerim",
};

const PAGE_SIZE = 25;
const FILTER_KEY = "review.mapped.filters";
const DAYS = 30;

export default function ReviewMappedTab({ connectionId }: { connectionId: string }) {
  const stored = (() => {
    try {
      return JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}");
    } catch {
      return {};
    }
  })();
  const [search, setSearch] = useState<string>(stored.search ?? "");
  const [state, setState] = useState<string>(stored.state ?? "");
  const [format, setFormat] = useState<string>(stored.format ?? "");
  const [debounced, setDebounced] = useState(search);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<MappedRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Record<string, number | null> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ search, state, format }));
  }, [search, state, format]);

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
    const rpc = (fn: string, args: Record<string, unknown>) =>
      (supabase.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{
        data: unknown;
        error: { message: string } | null;
      }>).call(supabase, fn, args);
    const [listRes, summaryRes] = await Promise.all([
      rpc("review_mapped_products", {
        p_connection_id: connectionId,
        p_search: debounced || null,
        p_format: format || null,
        p_state: state || null,
        p_days: DAYS,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      }),
      rpc("review_mapped_summary", { p_connection_id: connectionId, p_days: DAYS }),
    ]);
    if (listRes.error) {
      setError(listRes.error.message);
      setRows([]);
      setTotal(0);
    } else {
      const list = (listRes.data ?? []) as MappedRow[];
      setRows(list);
      setTotal(list.length ? Number(list[0].total_count) : 0);
    }
    if (!summaryRes.error) {
      const arr = (summaryRes.data ?? []) as Record<string, number | null>[];
      setSummary(arr[0] ?? null);
    }
    setLoading(false);
  }, [connectionId, debounced, state, format, page]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () =>
    downloadCsv(
      `revision-mapeados-${connectionId}.csv`,
      rows.map((r) => ({
        producto_agora: r.provider_product_id,
        nombre_agora: r.provider_product_name ?? "",
        familia: r.family ?? "",
        formato: r.format_key,
        precio_agora: r.agora_price ?? "",
        winerim_id: r.winerim_wine_id ?? "",
        winerim_nombre: r.winerim_wine_name ?? "",
        precio_winerim: r.winerim_price ?? "",
        winerim_activo: r.winerim_active === null ? "DESCONOCIDO" : r.winerim_active,
        metodo: r.match_method ?? "",
        mapeado_el: r.mapped_at ?? "",
        ultimo_envio: r.last_synced_at ?? "",
        unidades_30d: r.units_recent ?? "",
        estado: r.mapped_state,
        comparacion: r.comparison ?? "",
      })),
    );

  const chips = summary
    ? [
        { label: "Mapeados", value: summary.mapped_total },
        { label: "Correctos", value: summary.state_ok },
        { label: "Precio distinto", value: summary.price_mismatch },
        { label: "Sin precio de referencia", value: summary.no_price_ref },
        { label: "Vino inactivo", value: summary.wine_inactive },
        { label: "Vino no encontrado", value: summary.wine_missing },
        { label: "Botella", value: summary.bottle_count },
        { label: "Copa", value: summary.glass_count },
        { label: "Otros formatos", value: summary.other_format_count },
        { label: "Unidades 30 d", value: summary.units_recent },
      ]
    : [];

  return (
    <div className="space-y-4">
      <Card className="p-3 text-xs text-muted-foreground">
        Productos del TPV con vino de Winerim ya confirmado. Vista de solo lectura: no cambia mapas, precios, stock ni
        catálogo.
      </Card>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
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
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Todos los estados</option>
          {Object.keys(STATE_LABELS).map((k) => (
            <option key={k} value={k}>
              {STATE_LABELS[k]}
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
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando vinos mapeados…
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
                <th className="px-3 py-2">Uds 30 d</th>
                <th className="px-3 py-2">Mapeado / envío</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Comparación</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-4 text-muted-foreground">
                    Sin vinos mapeados con estos filtros.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={`${r.provider_product_id}-${r.format_key}`}>
                  <td className="px-3 py-2">
                    <div>{r.provider_product_name ?? "—"}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{r.provider_product_id}</div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{r.family ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary">{formatLabel(r.format_key)}</Badge>
                  </td>
                  <td className="px-3 py-2">{formatNumber(r.agora_price)}</td>
                  <td className="px-3 py-2">{formatNumber(r.winerim_price)}</td>
                  <td className="px-3 py-2">
                    <div>{r.winerim_wine_name ?? "—"}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {r.winerim_wine_id ?? "—"}
                      {r.match_method ? ` · ${r.match_method}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2">{formatNumber(r.units_recent, 0)}</td>
                  <td className="px-3 py-2 text-[10px] text-muted-foreground">
                    <div>map. {formatDateTime(r.mapped_at)}</div>
                    <div>env. {formatDateTime(r.last_synced_at)}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={
                        r.mapped_state === "OK"
                          ? "default"
                          : r.mapped_state === "NO_PRICE_REF"
                            ? "outline"
                            : "destructive"
                      }
                    >
                      {STATE_LABELS[r.mapped_state] ?? r.mapped_state}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground">{r.comparison ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total} mapeados · página {page + 1} de {Math.max(1, Math.ceil(total / PAGE_SIZE))}
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
