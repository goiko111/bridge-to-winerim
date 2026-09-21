import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { Info, Loader2, Search } from "lucide-react";

const QTOMAS_CONNECTION_ID = "57e8acbe-5b5f-433c-a0c6-e760c211acd3";

// Familias explícitas de vino/copa/botella (excluye "COPAS - BARRAFINA/QTOMAS/HIRO",
// que contiene vermús y licores).
const WINE_FAMILIES = [
  "VINOS POR COPA - QTOMAS / BARRAFINA / HIRO",
  "VINO TINTO - BARRAFINA / QTOMAS / HIRO",
  "VINO BLANCO - BARRAFINA / QTOMAS / HIRO",
  "VINOS POR COPA",
  "VINO DULCE Y GENEROSO - BARRAFINA / QTOMAS / HIRO",
  "VINO ESPUMOSO BARRAFINA / QTOMAS / HIRO",
  "VINO ROSADO - BARRAFINA / QTOMAS / HIRO",
  "BLANCOS WINERIM",
  "TINTOS WINERIM",
  "ESPUMOSOS WINERIM",
  "ROSADOS WINERIM",
  "DULCE WINERIM",
  "MAGNUM WINERIM",
  "FORTIFICADOS WINERIM",
  "COPAS WINERIM",
];

type Status = "PENDING" | "READY_TO_APPLY" | "DO_NOT_MAP" | "NEEDS_CONFIRMATION";

const STATUS_LABEL: Record<Status, string> = {
  PENDING: "Pendiente",
  READY_TO_APPLY: "Listo para aplicar",
  DO_NOT_MAP: "No mapear",
  NEEDS_CONFIRMATION: "Necesita confirmar",
};

type Decision = {
  provider_product_id: string;
  selected_winerim_id: string | null;
  selected_winerim_name: string | null;
  decision_status: Status;
  note: string | null;
  updated_at: string;
};

type Row = {
  providerProductId: string;
  name: string;
  family: string;
  formatType: "GLASS" | "BOTTLE";
  units: number;
};

type Wine = { winerim_id: string; name: string; format: string | null; price: number | null };

type DraftValue = {
  wineId: string | null;
  wineName: string | null;
  status: Status;
  note: string;
  search: string;
};

async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let page = 0; page < 20; page++) {
    const { data, error } = await build(page * size, page * size + size - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

export default function QtomasRevision() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [wines, setWines] = useState<Wine[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});

  // Edición por fila (no se persiste hasta pulsar "Guardar decisión")
  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState<"ALL" | Status>("ALL");
  const [filterFormat, setFilterFormat] = useState<"ALL" | "GLASS" | "BOTTLE">("ALL");
  const [query, setQuery] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const [lines, mappings, decisionRows, wineRows] = await Promise.all([
        fetchAll<{ provider_product_id: string | null; name: string; family: string | null; quantity: number }>(
          (from, to) =>
            supabase
              .from("sales_line_items")
              .select("provider_product_id,name,family,quantity")
              .eq("connection_id", QTOMAS_CONNECTION_ID)
              .in("family", WINE_FAMILIES)
              .gte("created_at", since)
              .range(from, to),
        ),
        fetchAll<{ provider_product_id: string }>((from, to) =>
          supabase
            .from("product_mappings")
            .select("provider_product_id")
            .eq("connection_id", QTOMAS_CONNECTION_ID)
            .eq("status", "CONFIRMED")
            .range(from, to),
        ),
        fetchAll<Decision>(
          (from, to) =>
            supabase
              .from("qtomas_review_decisions" as any)
              .select("provider_product_id,selected_winerim_id,selected_winerim_name,decision_status,note,updated_at")
              .eq("connection_id", QTOMAS_CONNECTION_ID)
              .range(from, to) as any,
        ),
        fetchAll<Wine>((from, to) =>
          supabase
            .from("winerim_wines")
            .select("winerim_id,name,format,price")
            .eq("connection_id", QTOMAS_CONNECTION_ID)
            .eq("is_active", true)
            .order("name")
            .range(from, to),
        ),
      ]);

      const confirmed = new Set(mappings.map((m) => m.provider_product_id));

      const agg = new Map<string, Row>();
      for (const l of lines) {
        const id = l.provider_product_id;
        if (!id || confirmed.has(id)) continue;
        const family = l.family ?? "";
        const formatType: "GLASS" | "BOTTLE" = /COPA/i.test(family) ? "GLASS" : "BOTTLE";
        const prev = agg.get(id);
        if (prev) prev.units += Number(l.quantity) || 0;
        else agg.set(id, { providerProductId: id, name: l.name, family, formatType, units: Number(l.quantity) || 0 });
      }

      setRows([...agg.values()].sort((a, b) => b.units - a.units));
      setWines(wineRows);
      setDecisions(Object.fromEntries(decisionRows.map((d) => [d.provider_product_id, d])));
      setDraft({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error cargando datos");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const getDraft = (row: Row): DraftValue => {
    const d = decisions[row.providerProductId];
    return (
      draft[row.providerProductId] ?? {
        wineId: d?.selected_winerim_id ?? null,
        wineName: d?.selected_winerim_name ?? null,
        status: (d?.decision_status ?? "PENDING") as Status,
        note: d?.note ?? "",
        search: "",
      }
    );
  };

  const patchDraft = (row: Row, patch: Partial<DraftValue>) =>
    setDraft((prev) => ({ ...prev, [row.providerProductId]: { ...getDraft(row), ...patch } }));

  const save = async (row: Row) => {
    const d = getDraft(row);
    if (d.status === "READY_TO_APPLY" && !d.wineId) {
      toast({
        title: "Selecciona un vino",
        description: "Para marcar «Listo para aplicar» hace falta un vino concreto.",
      });
      return;
    }
    setSaving(row.providerProductId);
    const { error: saveError } = await supabase.from("qtomas_review_decisions" as any).upsert(
      {
        connection_id: QTOMAS_CONNECTION_ID,
        provider_product_id: row.providerProductId,
        provider_product_name: row.name,
        family: row.family,
        format_type: row.formatType,
        units_30d: row.units,
        selected_winerim_id: d.wineId,
        selected_winerim_name: d.wineName,
        decision_status: d.status,
        note: d.note || null,
      } as any,
      { onConflict: "connection_id,provider_product_id" },
    );
    setSaving(null);
    if (saveError) {
      toast({ title: "No se pudo guardar", description: saveError.message, variant: "destructive" });
      return;
    }
    setDecisions((prev) => ({
      ...prev,
      [row.providerProductId]: {
        provider_product_id: row.providerProductId,
        selected_winerim_id: d.wineId,
        selected_winerim_name: d.wineName,
        decision_status: d.status,
        note: d.note || null,
        updated_at: new Date().toISOString(),
      },
    }));
    setDraft((prev) => {
      const next = { ...prev };
      delete next[row.providerProductId];
      return next;
    });
    toast({ title: "Decisión guardada", description: "Solo revisión: no se han tocado ventas, stock ni mapas." });
  };

  const counters = useMemo(() => {
    const c: Record<Status, number> = { PENDING: 0, READY_TO_APPLY: 0, DO_NOT_MAP: 0, NEEDS_CONFIRMATION: 0 };
    for (const r of rows) c[(decisions[r.providerProductId]?.decision_status ?? "PENDING") as Status]++;
    return c;
  }, [rows, decisions]);

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      const status = (decisions[r.providerProductId]?.decision_status ?? "PENDING") as Status;
      if (filterStatus !== "ALL" && status !== filterStatus) return false;
      if (filterFormat !== "ALL" && r.formatType !== filterFormat) return false;
      if (q && !(r.name.toLowerCase().includes(q) || r.providerProductId.includes(q))) return false;
      return true;
    });
  }, [rows, decisions, filterStatus, filterFormat, query]);

  const readyList = useMemo(
    () =>
      rows
        .filter((r) => decisions[r.providerProductId]?.decision_status === "READY_TO_APPLY")
        .map((r) => ({ row: r, decision: decisions[r.providerProductId] })),
    [rows, decisions],
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Revisión Qtomas</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Productos de vino vendidos en los últimos 30 días sin correspondencia confirmada. Guardar una decisión no
          modifica ventas, stock ni mapas; la aplicación posterior se hace de forma controlada.
        </p>
      </div>

      <Card className="flex items-start gap-3 p-4 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          Esta pantalla es solo de revisión. Elige el vino de Winerim que corresponde a cada referencia del TPV, o marca
          «No mapear» / «Necesita confirmar» y añade una nota.
        </span>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Referencias</div>
          <div className="text-xl font-semibold">{rows.length}</div>
        </Card>
        {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
          <Card key={s} className="p-4">
            <div className="text-xs text-muted-foreground">{STATUS_LABEL[s]}</div>
            <div className="text-xl font-semibold">{counters[s]}</div>
          </Card>
        ))}
      </div>

      <Card className="flex flex-wrap items-center gap-3 p-4">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Buscar producto del TPV o ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as "ALL" | Status)}
        >
          <option value="ALL">Todos los estados</option>
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          value={filterFormat}
          onChange={(e) => setFilterFormat(e.target.value as "ALL" | "GLASS" | "BOTTLE")}
        >
          <option value="ALL">Copa y botella</option>
          <option value="BOTTLE">Botella</option>
          <option value="GLASS">Copa</option>
        </select>
        <Button variant="outline" onClick={load} disabled={loading}>
          Recargar
        </Button>
      </Card>

      {error && <Card className="p-4 text-sm text-destructive">{error}</Card>}

      {loading ? (
        <Card className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando referencias…
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {visibleRows.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground">No hay referencias con estos filtros.</div>
          )}
          {visibleRows.map((row) => {
            const d = getDraft(row);
            const saved = decisions[row.providerProductId];
            const status = (saved?.decision_status ?? "PENDING") as Status;
            const search = d.search.trim().toLowerCase();
            const matches = search ? wines.filter((w) => w.name.toLowerCase().includes(search)).slice(0, 8) : [];
            return (
              <div key={row.providerProductId} className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground">#{row.providerProductId}</span>
                  <span className="font-medium">{row.name}</span>
                  <Badge variant="secondary">{row.formatType === "GLASS" ? "Copa" : "Botella"}</Badge>
                  <span className="text-xs text-muted-foreground">{row.family}</span>
                  <span className="text-xs text-muted-foreground">{row.units} uds / 30 días</span>
                  <Badge variant={status === "PENDING" ? "outline" : "default"}>{STATUS_LABEL[status]}</Badge>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Input
                      placeholder="Buscar vino activo en Winerim"
                      value={d.search}
                      onChange={(e) => patchDraft(row, { search: e.target.value })}
                    />
                    {matches.length > 0 && (
                      <div className="max-h-44 overflow-auto rounded-md border border-border">
                        {matches.map((w) => (
                          <button
                            key={w.winerim_id}
                            type="button"
                            onClick={() =>
                              patchDraft(row, {
                                wineId: w.winerim_id,
                                wineName: w.name,
                                status: "READY_TO_APPLY",
                                search: "",
                              })
                            }
                            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                          >
                            <span>{w.name}</span>
                            <span className="font-mono text-xs text-muted-foreground">{w.winerim_id}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="text-sm">
                      {d.wineId ? (
                        <span>
                          Vino elegido: <strong>{d.wineName}</strong>{" "}
                          <span className="font-mono text-xs text-muted-foreground">({d.wineId})</span>{" "}
                          <button
                            type="button"
                            className="text-xs text-primary underline"
                            onClick={() => patchDraft(row, { wineId: null, wineName: null, status: "PENDING" })}
                          >
                            quitar
                          </button>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Sin vino elegido</span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      {(["DO_NOT_MAP", "NEEDS_CONFIRMATION", "PENDING"] as Status[]).map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant={d.status === s ? "default" : "outline"}
                          onClick={() => patchDraft(row, { status: s })}
                        >
                          {STATUS_LABEL[s]}
                        </Button>
                      ))}
                    </div>
                    <Input
                      placeholder="Nota para el restaurante"
                      value={d.note}
                      onChange={(e) => patchDraft(row, { note: e.target.value })}
                    />
                    <div className="flex items-center gap-3">
                      <Button size="sm" onClick={() => save(row)} disabled={saving === row.providerProductId}>
                        {saving === row.providerProductId ? "Guardando…" : "Guardar decisión"}
                      </Button>
                      {saved && (
                        <span className="text-xs text-muted-foreground">
                          Guardado {new Date(saved.updated_at).toLocaleString("es-ES")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Listo para aplicar ({readyList.length})</h2>
          <span className="text-xs text-muted-foreground">Resumen de decisiones guardadas. No aplica nada.</span>
        </div>
        {readyList.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay decisiones marcadas como listas.</p>
        ) : (
          <div className="divide-y divide-border text-sm">
            {readyList.map(({ row, decision }) => (
              <div key={row.providerProductId} className="flex flex-wrap items-center gap-3 py-2">
                <span className="font-mono text-xs text-muted-foreground">#{row.providerProductId}</span>
                <span>{row.name}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-medium">{decision.selected_winerim_name}</span>
                <Badge variant="secondary">{row.formatType === "GLASS" ? "Copa" : "Botella"}</Badge>
                <span className="text-xs text-muted-foreground">{row.units} uds</span>
                {decision.note && <span className="text-xs text-muted-foreground">“{decision.note}”</span>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
