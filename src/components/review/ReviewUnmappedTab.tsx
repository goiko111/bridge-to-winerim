import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { ChevronDown, Download, Loader2, Search } from "lucide-react";
import WinerimVariantPicker, { VariantRow } from "./WinerimVariantPicker";
import {
  DECISION_STATUS_LABELS,
  DecisionStatus,
  REVIEW_FORMAT_FILTER_KEYS,
  canApproveDecision,
  downloadCsv,
  formatDateTime,
  formatLabel,
  formatNumber,
} from "@/lib/catalogReview";

type UnmappedRow = {
  provider_product_id: string;
  provider_product_name: string;
  family: string | null;
  sale_format: string;
  format_key: string;
  units: number | null;
  line_count: number | null;
  last_sale_at: string | null;
  agora_price: number | null;
  decision_status: string;
  selected_winerim_id: string | null;
  selected_winerim_name: string | null;
  selected_format_key: string | null;
  note: string | null;
  decided_at: string | null;
  total_count: number;
};

const PAGE_SIZE = 25;
const FILTER_KEY = "review.unmapped.filters";

type Filters = {
  search: string;
  family: string;
  format: string;
  status: string;
  days: number;
};

const DEFAULT_FILTERS: Filters = { search: "", family: "", format: "", status: "", days: 30 };

export default function ReviewUnmappedTab({ connectionId }: { connectionId: string }) {
  const [filters, setFilters] = useState<Filters>(() => {
    try {
      const raw = localStorage.getItem(FILTER_KEY);
      return raw ? { ...DEFAULT_FILTERS, ...JSON.parse(raw) } : DEFAULT_FILTERS;
    } catch {
      return DEFAULT_FILTERS;
    }
  });
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<UnmappedRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counters, setCounters] = useState<Record<string, number> | null>(null);
  const [families, setFamilies] = useState<{ family: string; rows_count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedSearch(filters.search);
      setPage(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [filters.search]);

  const load = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    setError(null);
    const args = {
      p_connection_id: connectionId,
      p_search: debouncedSearch || null,
      p_family: filters.family || null,
      p_format: filters.format || null,
      p_status: filters.status || null,
      p_days: filters.days,
    };
    const [listRes, countersRes, familiesRes] = await Promise.all([
      supabase.rpc("review_unmapped_products", {
        ...args,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      }),
      supabase.rpc("review_unmapped_counters", {
        p_connection_id: connectionId,
        p_days: filters.days,
      }),
      supabase.rpc("review_unmapped_families", {
        p_connection_id: connectionId,
        p_days: filters.days,
      }),
    ]);
    console.log("REVIEW_DEBUG", { args, listData: listRes.data, listError: listRes.error });
    if (listRes.error) {
      setError(listRes.error.message);
      setRows([]);
      setTotal(0);
    } else {
      const list = (listRes.data ?? []) as UnmappedRow[];
      setRows(list);
      setTotal(list.length ? Number(list[0].total_count) : 0);
    }
    if (!countersRes.error) setCounters(((countersRes.data ?? [])[0] ?? null) as any);
    if (!familiesRes.error) setFamilies((familiesRes.data ?? []) as any);
    setLoading(false);
  }, [connectionId, debouncedSearch, filters.family, filters.format, filters.status, filters.days, page]);

  useEffect(() => {
    load();
  }, [load]);

  const saveDecision = async (
    row: UnmappedRow,
    patch: {
      status: DecisionStatus;
      winerimId?: string | null;
      winerimName?: string | null;
      formatKey?: string | null;
      capacityLiters?: number | null;
      note?: string | null;
    },
  ) => {
    const key = `${row.provider_product_id}::${row.sale_format}`;
    setSaving(key);
    const { data: userData } = await supabase.auth.getUser();
    const payload = {
      connection_id: connectionId,
      provider_product_id: row.provider_product_id,
      sale_format: row.sale_format,
      provider_product_name: row.provider_product_name,
      family: row.family,
      units_recent: row.units,
      last_sale_at: row.last_sale_at,
      selected_winerim_id: patch.winerimId ?? null,
      selected_winerim_name: patch.winerimName ?? null,
      selected_format_key: patch.formatKey ?? null,
      selected_capacity_liters: patch.capacityLiters ?? null,
      status: patch.status,
      note: patch.note ?? row.note ?? null,
      decided_by: userData?.user?.id ?? null,
      decided_at: new Date().toISOString(),
    };
    const { error: err } = await supabase
      .from("catalog_review_decisions")
      .upsert(payload, { onConflict: "connection_id,provider_product_id,sale_format" });
    setSaving(null);
    if (err) {
      toast({ title: "No se pudo guardar la decisión", description: err.message, variant: "destructive" });
      return;
    }
    setRows((prev) =>
      prev.map((r) =>
        r.provider_product_id === row.provider_product_id && r.sale_format === row.sale_format
          ? {
              ...r,
              decision_status: payload.status,
              selected_winerim_id: payload.selected_winerim_id,
              selected_winerim_name: payload.selected_winerim_name,
              selected_format_key: payload.selected_format_key,
              note: payload.note,
              decided_at: payload.decided_at,
            }
          : r,
      ),
    );
    toast({
      title: "Decisión guardada",
      description: "Solo revisión: no cambia mapas, ventas, stock, cursores ni catálogo.",
    });
  };

  const onSelectVariant = (row: UnmappedRow) => (variant: VariantRow) => {
    const approvable = canApproveDecision({
      agoraFormatKey: row.format_key,
      selectedWinerimId: variant.winerim_id,
      selectedFormatKey: variant.format_key,
    });
    saveDecision(row, {
      status: approvable ? "READY_FOR_APPROVAL" : "NEEDS_CONFIRMATION",
      winerimId: variant.winerim_id,
      winerimName: variant.name,
      formatKey: variant.format_key,
      capacityLiters: variant.capacity_liters,
    });
    setExpanded(null);
  };

  const exportCsv = () =>
    downloadCsv(
      `revision-sin-mapear-${connectionId}.csv`,
      rows.map((r) => ({
        provider_product_id: r.provider_product_id,
        producto_agora: r.provider_product_name,
        familia: r.family ?? "",
        formato_agora: r.sale_format,
        formato_normalizado: r.format_key,
        etiqueta_formato: formatLabel(r.format_key),
        unidades: r.units ?? "",
        lineas: r.line_count ?? "",
        ultima_venta: r.last_sale_at ?? "",
        precio_agora: r.agora_price ?? "",
        estado_decision: r.decision_status,
        winerim_id: r.selected_winerim_id ?? "",
        winerim_nombre: r.selected_winerim_name ?? "",
        winerim_formato: r.selected_format_key ?? "",
        nota: r.note ?? "",
        decidido_en: r.decided_at ?? "",
      })),
    );

  const counterChips = useMemo(
    () =>
      counters
        ? [
            { label: "Referencias", value: counters.total },
            { label: "Unidades", value: counters.units },
            { label: DECISION_STATUS_LABELS.DRAFT, value: counters.draft },
            { label: DECISION_STATUS_LABELS.READY_FOR_APPROVAL, value: counters.ready },
            { label: DECISION_STATUS_LABELS.NO_MATCH, value: counters.no_match },
            { label: DECISION_STATUS_LABELS.NEEDS_CONFIRMATION, value: counters.needs_confirmation },
            { label: "Sin dato de formato", value: counters.sin_dato },
          ]
        : [],
    [counters],
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-7">
        {counterChips.map((c) => (
          <Card key={c.label} className="p-3">
            <div className="text-[11px] text-muted-foreground">{c.label}</div>
            <div className="text-lg font-semibold">{formatNumber(Number(c.value ?? 0), 0)}</div>
          </Card>
        ))}
      </div>

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-9 text-xs"
            placeholder="Nombre o ID de Ágora"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          />
        </div>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={filters.family}
          onChange={(e) => {
            setFilters((f) => ({ ...f, family: e.target.value }));
            setPage(0);
          }}
        >
          <option value="">Todas las familias</option>
          {families.map((f) => (
            <option key={f.family} value={f.family}>
              {f.family} ({f.rows_count})
            </option>
          ))}
        </select>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={filters.format}
          onChange={(e) => {
            setFilters((f) => ({ ...f, format: e.target.value }));
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
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={filters.status}
          onChange={(e) => {
            setFilters((f) => ({ ...f, status: e.target.value }));
            setPage(0);
          }}
        >
          <option value="">Todos los estados</option>
          {(Object.keys(DECISION_STATUS_LABELS) as DecisionStatus[]).map((s) => (
            <option key={s} value={s}>
              {DECISION_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={filters.days}
          onChange={(e) => {
            setFilters((f) => ({ ...f, days: Number(e.target.value) }));
            setPage(0);
          }}
        >
          <option value={7}>Actividad 7 días</option>
          <option value={30}>Actividad 30 días</option>
          <option value={90}>Actividad 90 días</option>
        </select>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={exportCsv}>
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
      </Card>

      {error && <Card className="p-3 text-xs text-destructive">{error}</Card>}

      {loading ? (
        <Card className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando referencias…
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {rows.length === 0 && (
            <p className="p-4 text-xs text-muted-foreground">No hay referencias con estos filtros.</p>
          )}
          {rows.map((row) => {
            const key = `${row.provider_product_id}::${row.sale_format}`;
            const blocked = row.format_key === "SIN_DATO";
            const approvable = canApproveDecision({
              agoraFormatKey: row.format_key,
              selectedWinerimId: row.selected_winerim_id,
              selectedFormatKey: row.selected_format_key,
            });
            return (
              <div key={key} className="p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono text-[11px] text-muted-foreground">#{row.provider_product_id}</span>
                  <span className="font-medium">{row.provider_product_name}</span>
                  <span className="text-muted-foreground">{row.family ?? "—"}</span>
                  <Badge variant={blocked ? "destructive" : "secondary"}>{formatLabel(row.format_key)}</Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">{row.sale_format}</span>
                  <span className="text-muted-foreground">
                    {row.units !== null ? `${formatNumber(row.units, 0)} uds` : "sin unidades"} ·{" "}
                    {row.last_sale_at ? formatDateTime(row.last_sale_at) : "sin última venta"}
                  </span>
                  <Badge variant={approvable ? "default" : "outline"}>
                    {DECISION_STATUS_LABELS[(row.decision_status as DecisionStatus) ?? "DRAFT"] ?? row.decision_status}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-7 gap-1 text-[11px]"
                    onClick={() => setExpanded(expanded === key ? null : key)}
                  >
                    <ChevronDown className={`h-3.5 w-3.5 ${expanded === key ? "rotate-180" : ""}`} />
                    Decidir
                  </Button>
                </div>

                <div className="mt-1 text-[11px] text-muted-foreground">
                  {row.selected_winerim_id ? (
                    <>
                      Winerim: <span className="text-foreground">{row.selected_winerim_name}</span>{" "}
                      <span className="font-mono">({row.selected_winerim_id})</span> ·{" "}
                      {formatLabel(row.selected_format_key)}
                      {!approvable && " · variante incompatible: no se puede aprobar"}
                    </>
                  ) : (
                    "Sin variante Winerim seleccionada"
                  )}
                  {blocked && " · formato del TPV Sin dato: aprobación bloqueada"}
                </div>

                {expanded === key && (
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <WinerimVariantPicker
                      connectionId={connectionId}
                      agoraFormatKey={row.format_key}
                      onSelect={onSelectVariant(row)}
                    />
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          disabled={saving === key}
                          onClick={() => saveDecision(row, { status: "NO_MATCH" })}
                        >
                          No encuentro coincidencia
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          disabled={saving === key}
                          onClick={() =>
                            saveDecision(row, {
                              status: "NEEDS_CONFIRMATION",
                              winerimId: row.selected_winerim_id,
                              winerimName: row.selected_winerim_name,
                              formatKey: row.selected_format_key,
                            })
                          }
                        >
                          Necesita confirmación
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-[11px]"
                          disabled={saving === key}
                          onClick={() => saveDecision(row, { status: "DRAFT" })}
                        >
                          Borrador
                        </Button>
                      </div>
                      <Input
                        className="h-8 text-xs"
                        placeholder="Nota (se guarda al salir del campo)"
                        defaultValue={row.note ?? ""}
                        onBlur={(e) =>
                          saveDecision(row, {
                            status: (row.decision_status as DecisionStatus) ?? "DRAFT",
                            winerimId: row.selected_winerim_id,
                            winerimName: row.selected_winerim_name,
                            formatKey: row.selected_format_key,
                            note: e.target.value || null,
                          })
                        }
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {row.decided_at ? `Última decisión: ${formatDateTime(row.decided_at)}` : "Sin decisión previa"}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total} referencias · página {page + 1} de {Math.max(1, Math.ceil(total / PAGE_SIZE))}
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
