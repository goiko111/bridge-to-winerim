import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { formatLabel, formatNumber, isVariantCompatible } from "@/lib/catalogReview";

export type VariantRow = {
  winerim_id: string;
  name: string;
  vintage: string | null;
  winery: string | null;
  region: string | null;
  grape_variety: string | null;
  wine_type: string | null;
  sku: string | null;
  ean: string | null;
  format_key: string;
  capacity_liters: number | null;
  sale_price: number | null;
  cost_price: number | null;
  stock_id: number | null;
  variant_source: string | null;
  origin: string | null;
  total_count: number;
};

const PAGE_SIZE = 40;

type Props = {
  connectionId: string;
  agoraFormatKey: string;
  onSelect: (variant: VariantRow) => void;
};

/**
 * Server-side search over ALL active Winerim wines of the connection.
 * Selection is always wine + exact format; incompatible variants are blocked.
 */
export default function WinerimVariantPicker({ connectionId, agoraFormatKey, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setDebounced(query);
      setPage(0);
    }, 300);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase.rpc("review_search_winerim_variants", {
        p_connection_id: connectionId,
        p_query: debounced || null,
        p_format: null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setRows([]);
        setTotal(0);
      } else {
        const list = (data ?? []) as VariantRow[];
        setRows(list);
        setTotal(list.length ? Number(list[0].total_count) : 0);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, debounced, page]);

  // Group variants by wine so a wine with Bottle + Glass shows two exact options.
  const grouped = useMemo(() => {
    const map = new Map<string, { head: VariantRow; variants: VariantRow[] }>();
    for (const r of rows) {
      const entry = map.get(r.winerim_id);
      if (entry) entry.variants.push(r);
      else map.set(r.winerim_id, { head: r, variants: [r] });
    }
    return [...map.values()];
  }, [rows]);

  return (
    <div className="space-y-2">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar por nombre, añada, bodega, región, uva, tipo, ID, SKU, EAN o formato"
        className="h-8 text-xs"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      {loading ? (
        <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Buscando…
        </div>
      ) : (
        <div className="max-h-72 overflow-auto rounded-md border border-border">
          {grouped.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">Sin resultados para esta búsqueda.</p>
          )}
          {grouped.map(({ head, variants }) => (
            <div key={head.winerim_id} className="border-b border-border/60 p-2 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{head.name}</span>
                {head.vintage && <span className="text-muted-foreground">{head.vintage}</span>}
                {head.wine_type && <Badge variant="secondary">{head.wine_type}</Badge>}
                <span className="font-mono text-[10px] text-muted-foreground">
                  ID {head.winerim_id}
                  {head.sku ? ` · SKU ${head.sku}` : ""}
                  {head.ean ? ` · EAN ${head.ean}` : ""}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {[head.winery, head.region, head.grape_variety].filter(Boolean).join(" · ") || "—"}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {variants.map((v) => {
                  const compatible = isVariantCompatible(agoraFormatKey, v.format_key);
                  return (
                    <Button
                      key={`${v.winerim_id}-${v.format_key}`}
                      size="sm"
                      variant={compatible ? "outline" : "ghost"}
                      disabled={!compatible}
                      title={
                        compatible
                          ? "Seleccionar esta variante exacta"
                          : `Formato incompatible con «${formatLabel(agoraFormatKey)}»: no se puede aprobar`
                      }
                      onClick={() => onSelect(v)}
                      className="h-7 gap-1.5 text-[11px]"
                    >
                      <span>{formatLabel(v.format_key)}</span>
                      <span className="text-muted-foreground">
                        {v.capacity_liters !== null ? `${formatNumber(v.capacity_liters, 3)} L` : "capacidad —"}
                      </span>
                      <span className="text-muted-foreground">
                        {v.sale_price !== null ? `${formatNumber(v.sale_price)} €` : "precio —"}
                      </span>
                      {v.stock_id !== null && (
                        <span className="font-mono text-muted-foreground">stock {v.stock_id}</span>
                      )}
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {v.variant_source ?? ""}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{total} variantes activas coinciden</span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Anterior
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
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
