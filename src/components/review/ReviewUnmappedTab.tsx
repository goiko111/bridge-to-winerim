import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { Check, ChevronDown, Download, Loader2, Search } from "lucide-react";
import WinerimVariantPicker, { VariantRow } from "./WinerimVariantPicker";
import {
  DECISION_STATUS_LABELS,
  DecisionStatus,
  REVIEW_FORMAT_FILTER_KEYS,
  buildMappingPayload,
  canApplyDecision,
  canApproveDecision,
  canForceReady,
  isPromotable,
  downloadCsv,
  formatDateTime,
  formatLabel,
  formatNumber,
} from "@/lib/catalogReview";
import {
  mergeUnmappedReviewRows,
  unmappedFilterKey,
  type LegacyReviewRow,
  type QtomasDecision,
  type ReviewDecision,
  type UnmappedReviewRow,
} from "@/lib/reviewUnmapped";

const PAGE_SIZE = 25;
const RPC_PAGE_SIZE = 200;

type Filters = {
  search: string;
  family: string;
  format: string;
  status: string;
  days: number;
};

const DEFAULT_FILTERS: Filters = { search: "", family: "", format: "", status: "", days: 30 };

async function loadAllUnmapped(connectionId: string, days: number) {
  const rows: Omit<UnmappedReviewRow, "legacy" | "legacy_state">[] = [];
  for (let offset = 0; ; offset += RPC_PAGE_SIZE) {
    const { data, error } = await supabase.rpc("review_unmapped_products", {
      p_connection_id: connectionId,
      p_search: null,
      p_family: null,
      p_format: null,
      p_status: null,
      p_days: days,
      p_limit: RPC_PAGE_SIZE,
      p_offset: offset,
    });
    if (error) throw error;
    const page = (data ?? []) as Omit<UnmappedReviewRow, "legacy" | "legacy_state">[];
    rows.push(...page);
    const total = Number((page[0] as { total_count?: number } | undefined)?.total_count ?? rows.length);
    if (page.length < RPC_PAGE_SIZE || rows.length >= total) return rows;
  }
}

async function loadAllLegacy(connectionId: string) {
  const rows: LegacyReviewRow[] = [];
  for (let offset = 0; ; offset += RPC_PAGE_SIZE) {
    const { data, error } = await supabase.rpc("review_legacy_products", {
      p_connection_id: connectionId,
      p_search: null,
      p_state: null,
      p_limit: RPC_PAGE_SIZE,
      p_offset: offset,
    });
    if (error) throw error;
    const page = (data ?? []) as (LegacyReviewRow & { total_count?: number })[];
    rows.push(...page);
    const total = Number(page[0]?.total_count ?? rows.length);
    if (page.length < RPC_PAGE_SIZE || rows.length >= total) return rows;
  }
}

export default function ReviewUnmappedTab({ connectionId }: { connectionId: string }) {
  const filterKey = unmappedFilterKey(connectionId);
  const [filters, setFilters] = useState<Filters>(() => {
    try {
      const raw = localStorage.getItem(filterKey);
      return raw ? { ...DEFAULT_FILTERS, ...JSON.parse(raw) } : DEFAULT_FILTERS;
    } catch {
      return DEFAULT_FILTERS;
    }
  });
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<UnmappedReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    localStorage.setItem(filterKey, JSON.stringify(filters));
  }, [filterKey, filters]);

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
    try {
      const [activity, legacy, decisionsResult, qtomasResult] = await Promise.all([
        loadAllUnmapped(connectionId, filters.days),
        loadAllLegacy(connectionId),
        supabase
          .from("catalog_review_decisions")
          .select("provider_product_id,sale_format,status,selected_winerim_id,selected_winerim_name,selected_format_key,force_ready,note,decided_at")
          .eq("connection_id", connectionId),
        supabase
          .from("qtomas_review_decisions")
          .select("provider_product_id,format_type,decision_status,selected_winerim_id,selected_winerim_name,note,updated_at")
          .eq("connection_id", connectionId),
      ]);
      if (decisionsResult.error) throw decisionsResult.error;
      if (qtomasResult.error) throw qtomasResult.error;
      setRows(mergeUnmappedReviewRows({
        activity,
        legacy,
        decisions: (decisionsResult.data ?? []) as ReviewDecision[],
        qtomasDecisions: (qtomasResult.data ?? []) as QtomasDecision[],
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudieron leer las referencias pendientes.");
      setRows([]);
    }
    setLoading(false);
  }, [connectionId, filters.days]);

  useEffect(() => {
    load();
  }, [load]);

  const saveDecision = async (
    row: UnmappedReviewRow,
    patch: {
      status: DecisionStatus;
      winerimId?: string | null;
      winerimName?: string | null;
      formatKey?: string | null;
      capacityLiters?: number | null;
      forceReady?: boolean;
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
      force_ready: patch.forceReady ?? row.force_ready ?? false,
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
              force_ready: payload.force_ready,
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

  const onSelectVariant =
    (row: UnmappedReviewRow) => (variant: VariantRow, meta: { soleVariant: boolean; auto?: boolean }) => {
      const approvable = canApproveDecision({
        agoraFormatKey: row.format_key,
        selectedWinerimId: variant.winerim_id,
        selectedFormatKey: variant.format_key,
        soleVariant: meta.soleVariant,
      });
      saveDecision(row, {
        status: approvable ? "READY_FOR_APPROVAL" : "NEEDS_CONFIRMATION",
        winerimId: variant.winerim_id,
        winerimName: variant.name,
        formatKey: variant.format_key,
        capacityLiters: variant.capacity_liters,
      });
      if (!meta.auto) setExpanded(null);
    };

  /**
   * Approval = create/confirm the product mapping only.
   * Never touches sales, stock, cursors, prices or the Agora catalog.
   */
  const approveRows = async (targets: UnmappedReviewRow[]) => {
    const applicable = targets.filter((row) => canApplyDecision(row));
    if (!applicable.length) {
      toast({ title: "Nada que aprobar", description: "Solo se aprueban decisiones «Listo para aprobar» con variante compatible." });
      return;
    }
    setApproving(true);
    const { data: userData } = await supabase.auth.getUser();
    const { data: mappings, error: mapError } = await supabase
      .from("product_mappings")
      .upsert(
        applicable.map((row) => buildMappingPayload(connectionId, row)),
        { onConflict: "connection_id,provider_product_id" },
      )
      .select("id,provider_product_id");
    if (mapError) {
      setApproving(false);
      toast({ title: "No se pudo aprobar", description: mapError.message, variant: "destructive" });
      return;
    }
    const mappingByProduct = new Map((mappings ?? []).map((m) => [m.provider_product_id, m.id]));
    const appliedAt = new Date().toISOString();
    const { error: decisionError } = await supabase.from("catalog_review_decisions").upsert(
      applicable.map((row) => ({
        connection_id: connectionId,
        provider_product_id: row.provider_product_id,
        sale_format: row.sale_format,
        provider_product_name: row.provider_product_name,
        family: row.family,
        units_recent: row.units,
        last_sale_at: row.last_sale_at,
        selected_winerim_id: row.selected_winerim_id,
        selected_winerim_name: row.selected_winerim_name,
        selected_format_key: row.selected_format_key,
        note: row.note ?? null,
        status: "APPLIED",
        decided_by: userData?.user?.id ?? null,
        decided_at: appliedAt,
        applied_at: appliedAt,
        applied_by: userData?.user?.id ?? null,
        applied_mapping_id: mappingByProduct.get(row.provider_product_id) ?? null,
      })),
      { onConflict: "connection_id,provider_product_id,sale_format" },
    );
    setApproving(false);
    if (decisionError) {
      toast({
        title: "Mapa creado, pero no se pudo marcar la decisión",
        description: decisionError.message,
        variant: "destructive",
      });
    } else {
      toast({
        title: `${applicable.length} mapa(s) creados`,
        description: "Solo se creó el mapa de producto: no cambia ventas, stock, precios ni catálogo.",
      });
    }
    setSelected(new Set());
    load();
  };

  /**
   * Promote NEEDS_CONFIRMATION decisions that already have an exact variant chosen
   * to READY_FOR_APPROVAL. Only touches the review decision, never mappings.
   * When forced=true, the operator explicitly accepts a format mismatch.
   */
  const promoteRows = async (targets: UnmappedReviewRow[], forced: boolean) => {
    const promotable = forced ? targets.filter(canForceReady) : targets.filter(isPromotable);
    if (!promotable.length) {
      toast({
        title: "Nada que pasar",
        description: "Solo se pasan decisiones «Necesita confirmación» que ya tienen vino y formato elegidos.",
      });
      return;
    }
    setApproving(true);
    const { data: userData } = await supabase.auth.getUser();
    const decidedAt = new Date().toISOString();
    const { error: err } = await supabase.from("catalog_review_decisions").upsert(
      promotable.map((row) => ({
        connection_id: connectionId,
        provider_product_id: row.provider_product_id,
        sale_format: row.sale_format,
        provider_product_name: row.provider_product_name,
        family: row.family,
        units_recent: row.units,
        last_sale_at: row.last_sale_at,
        selected_winerim_id: row.selected_winerim_id,
        selected_winerim_name: row.selected_winerim_name,
        selected_format_key: row.selected_format_key,
        force_ready: forced,
        note: row.note ?? null,
        status: "READY_FOR_APPROVAL",
        decided_by: userData?.user?.id ?? null,
        decided_at: decidedAt,
      })),
      { onConflict: "connection_id,provider_product_id,sale_format" },
    );
    setApproving(false);
    if (err) {
      toast({ title: "No se pudo actualizar", description: err.message, variant: "destructive" });
      return;
    }
    setRows((prev) =>
      prev.map((r) =>
        promotable.some((p) => p.provider_product_id === r.provider_product_id && p.sale_format === r.sale_format)
          ? { ...r, decision_status: "READY_FOR_APPROVAL", force_ready: forced, decided_at: decidedAt }
          : r,
      ),
    );
    toast({
      title: `${promotable.length} decisión(es) listas para aprobar`,
      description: forced
        ? "Marcadas como listas forzosamente por formato; no crea mapas ni toca ventas, stock o catálogo."
        : "Solo cambia el estado de revisión: no crea mapas ni toca ventas, stock o catálogo.",
    });
  };



  const exportCsv = () =>
    downloadCsv(
      `revision-sin-mapear-${connectionId}.csv`,
      filteredRows.map((r) => ({
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
        origen: r.legacy ? "LEGACY" : "ACTIVIDAD",
      })),
    );

  const counters = useMemo(() => ({
    total: rows.length,
    units: rows.reduce((sum, row) => sum + (row.units ?? 0), 0),
    draft: rows.filter((row) => row.decision_status === "DRAFT").length,
    ready: rows.filter((row) => row.decision_status === "READY_FOR_APPROVAL").length,
    no_match: rows.filter((row) => row.decision_status === "NO_MATCH").length,
    needs_confirmation: rows.filter((row) => row.decision_status === "NEEDS_CONFIRMATION").length,
    applied: rows.filter((row) => row.decision_status === "APPLIED").length,
    sin_dato: rows.filter((row) => row.format_key === "SIN_DATO").length,
  }), [rows]);

  const counterChips = [
    { label: "Referencias", value: counters.total },
    { label: "Unidades conocidas", value: counters.units },
    { label: DECISION_STATUS_LABELS.DRAFT, value: counters.draft },
    { label: DECISION_STATUS_LABELS.READY_FOR_APPROVAL, value: counters.ready },
    { label: DECISION_STATUS_LABELS.APPLIED, value: counters.applied },
    { label: DECISION_STATUS_LABELS.NO_MATCH, value: counters.no_match },
    { label: DECISION_STATUS_LABELS.NEEDS_CONFIRMATION, value: counters.needs_confirmation },
    { label: "Sin dato de formato", value: counters.sin_dato },
  ];

  const readyRows = useMemo(() => rows.filter((row) => canApplyDecision(row)), [rows]);
  const promotableRows = useMemo(() => rows.filter((row) => isPromotable(row)), [rows]);
  const forceReadyRows = useMemo(() => rows.filter((row) => canForceReady(row)), [rows]);
  const selectedReadyRows = useMemo(
    () => readyRows.filter((row) => selected.has(`${row.provider_product_id}::${row.sale_format}`)),
    [readyRows, selected],
  );
  const selectedForceReadyRows = useMemo(
    () => forceReadyRows.filter((row) => selected.has(`${row.provider_product_id}::${row.sale_format}`)),
    [forceReadyRows, selected],
  );

  const families = useMemo(() => {
    const counts = new Map<string, number>();
    rows.forEach((row) => {
      if (row.family) counts.set(row.family, (counts.get(row.family) ?? 0) + 1);
    });
    return [...counts.entries()]
      .map(([family, rows_count]) => ({ family, rows_count }))
      .sort((left, right) => right.rows_count - left.rows_count || left.family.localeCompare(right.family, "es"));
  }, [rows]);

  const filteredRows = useMemo(() => {
    const query = debouncedSearch.trim().toLocaleLowerCase("es-ES");
    return rows.filter((row) => {
      if (query && !row.provider_product_name.toLocaleLowerCase("es-ES").includes(query) && !row.provider_product_id.includes(query)) return false;
      if (filters.family && row.family !== filters.family) return false;
      if (filters.format && row.format_key !== filters.format) return false;
      if (filters.status && row.decision_status !== filters.status) return false;
      return true;
    });
  }, [rows, debouncedSearch, filters.family, filters.format, filters.status]);

  const total = filteredRows.length;
  const pageRows = filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-8">
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

      <Card className="flex flex-wrap items-center gap-3 p-3 text-xs">
        <span className="font-medium">Listo para aprobar: {formatNumber(readyRows.length, 0)}</span>
        <span className="text-muted-foreground">
          Seleccionadas: {formatNumber(selectedReadyRows.length, 0)} · Aprobar crea solo el mapa del producto; no cambia
          ventas, stock, precios, cursores ni catálogo.
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            disabled={(!readyRows.length && !forceReadyRows.length) || approving}
            onClick={() =>
              setSelected(
                new Set(
                  [...readyRows, ...forceReadyRows].map(
                    (row) => `${row.provider_product_id}::${row.sale_format}`,
                  ),
                ),
              )
            }
          >
            Seleccionar todas
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px]"
            disabled={!selected.size || approving}
            onClick={() => setSelected(new Set())}
          >
            Limpiar
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-[11px]"
            disabled={!promotableRows.length || approving}
            title="Cambia solo el estado de revisión de las decisiones compatibles que ya tienen vino y formato elegidos."
            onClick={() => promoteRows(promotableRows, false)}
          >
            Pasar a listo ({promotableRows.length})
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            disabled={!selectedForceReadyRows.length || approving}
            title="Pasa a listo las filas seleccionadas aunque el formato del TPV no coincida."
            onClick={() => promoteRows(selectedForceReadyRows, true)}
          >
            Pasar seleccionadas a listo ({selectedForceReadyRows.length})
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1 text-[11px]"
            disabled={!selectedReadyRows.length || approving}
            onClick={() => approveRows(selectedReadyRows)}
          >
            {approving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Aprobar seleccionadas ({selectedReadyRows.length})
          </Button>
        </div>
      </Card>

      {error && <Card className="p-3 text-xs text-destructive">{error}</Card>}

      {loading ? (
        <Card className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando referencias…
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {total === 0 && (
            <p className="p-4 text-xs text-muted-foreground">No hay referencias con estos filtros.</p>
          )}
          {pageRows.map((row) => {
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
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    aria-label={`Seleccionar ${row.provider_product_name}`}
                    disabled={(!canApplyDecision(row) && !isPromotable(row) && !canForceReady(row)) || approving}
                    checked={selected.has(key)}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                  <span className="font-mono text-[11px] text-muted-foreground">#{row.provider_product_id}</span>
                  <span className="font-medium">{row.provider_product_name}</span>
                  {row.legacy && <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-200">LEGACY</Badge>}
                  <span className="text-muted-foreground">{row.family ?? "—"}</span>
                  <Badge variant={blocked ? "destructive" : "secondary"}>{formatLabel(row.format_key)}</Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">{row.sale_format}</span>
                  <span className="text-muted-foreground">
                    {row.units !== null ? `${formatNumber(row.units, 0)} uds` : "sin unidades"}
                    {row.agora_price !== null && row.agora_price !== undefined ? ` · ${formatNumber(Number(row.agora_price), 2)} €` : ""} ·{" "}
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
                  {(isPromotable(row) || canForceReady(row)) && (
                    <Button
                      size="sm"
                      variant={canForceReady(row) && !isPromotable(row) ? "default" : "secondary"}
                      className="h-7 text-[11px]"
                      disabled={approving}
                      title={
                        canForceReady(row) && !isPromotable(row)
                          ? "Pasa a listo aceptando el formato elegido aunque no coincida con el TPV"
                          : "Pasa a listo automáticamente"
                      }
                      onClick={() => promoteRows([row], !isPromotable(row))}
                    >
                      Pasar a listo
                    </Button>
                  )}
                  {canApplyDecision(row) && (
                    <Button
                      size="sm"
                      className="h-7 gap-1 text-[11px]"
                      disabled={approving}
                      onClick={() => approveRows([row])}
                    >
                      <Check className="h-3.5 w-3.5" /> Aprobar
                    </Button>
                  )}
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
                      initialQuery={row.provider_product_name}
                      autoSelect={!row.selected_winerim_id}
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
