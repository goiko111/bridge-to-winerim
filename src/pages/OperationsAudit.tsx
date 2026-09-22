import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ReviewCatalogAuditTab from "@/components/review/ReviewCatalogAuditTab";
import ReviewUnmappedTab from "@/components/review/ReviewUnmappedTab";
import {
  EXPECTED_ACTIVE_RESTAURANTS,
  connectionEvidenceState,
  evidenceLabel,
  formatEvidenceTime,
  type EvidenceState,
} from "@/lib/operationsAudit";
import { downloadCsv } from "@/lib/catalogReview";

type FleetConnection = {
  id: string;
  location_name: string;
  provider: string;
  enabled: boolean;
  last_sync_at: string | null;
  last_catalog_sync_at: string | null;
  sync_frequency_minutes: number;
  consecutive_failures: number;
  circuit_breaker_paused_until: string | null;
  catalog_sync_enabled: boolean | null;
  catalog_product_count: number | null;
  catalog_wine_candidate_count: number | null;
  auto_push_verified_ready: boolean;
  write_mode: string;
};

const stateClasses: Record<EvidenceState, string> = {
  healthy: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  stale: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  unavailable: "border-rose-500/30 bg-rose-500/10 text-rose-200",
};

function EvidenceBadge({ state }: { state: EvidenceState }) {
  return <Badge className={stateClasses[state]}>{evidenceLabel(state)}</Badge>;
}

function FleetMetric({ label, value, detail, tone = "default" }: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "default" | "success" | "warning";
}) {
  return (
    <div className="border-r border-border px-4 py-3 last:border-r-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${tone === "success" ? "text-emerald-300" : tone === "warning" ? "text-amber-200" : "text-foreground"}`}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export default function OperationsAudit() {
  const [connections, setConnections] = useState<FleetConnection[]>([]);
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem("audit.connectionId") ?? "");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const { data, error: loadError } = await supabase
      .from("pos_connections")
      .select("id,location_name,provider,enabled,last_sync_at,last_catalog_sync_at,sync_frequency_minutes,consecutive_failures,circuit_breaker_paused_until,catalog_sync_enabled,catalog_product_count,catalog_wine_candidate_count,auto_push_verified_ready,write_mode")
      .order("location_name");

    if (loadError) {
      setError(loadError.message);
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as FleetConnection[];
    setConnections(rows);
    setSelectedId((current) => {
      if (current && rows.some((row) => row.id === current)) return current;
      return rows.find((row) => row.enabled)?.id ?? rows[0]?.id ?? "";
    });
    setLoadedAt(new Date().toISOString());
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (selectedId) localStorage.setItem("audit.connectionId", selectedId);
  }, [selectedId]);

  const active = useMemo(() => connections.filter((row) => row.enabled), [connections]);
  const enriched = useMemo(
    () => connections.map((row) => ({ ...row, evidence: connectionEvidenceState(row) })),
    [connections],
  );
  const healthy = enriched.filter((row) => row.enabled && row.evidence === "healthy").length;
  const certified = active.filter((row) => row.auto_push_verified_ready).length;
  const selected = connections.find((row) => row.id === selectedId) ?? null;
  const visible = enriched.filter((row) => {
    const query = search.trim().toLocaleLowerCase("es-ES");
    return !query || row.location_name.toLocaleLowerCase("es-ES").includes(query) || row.provider.includes(query);
  });
  const coverageComplete = active.length === EXPECTED_ACTIVE_RESTAURANTS;

  const exportFleet = () => downloadCsv(
    `flota-winerim-${new Date().toISOString().slice(0, 10)}.csv`,
    enriched.map((row) => ({
      restaurante: row.location_name,
      proveedor: row.provider,
      activo: row.enabled ? "Sí" : "No",
      estado_lectura: evidenceLabel(row.evidence),
      ultima_lectura: row.last_sync_at ?? "",
      catalogo: row.catalog_sync_enabled ? "Activo" : "Pausado",
      productos: row.catalog_product_count ?? "",
      certificado: row.auto_push_verified_ready ? "Sí" : "No",
    })),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`h-2 w-2 rounded-full ${error ? "bg-rose-400" : "bg-emerald-400"}`} />
            Datos del middleware · {formatEvidenceTime(loadedAt)}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Operación y auditoría</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Estado real de cada restaurante. Una lectura ausente o antigua se muestra como tal y nunca como sincronizada.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={exportFleet} disabled={!connections.length}>
            <Download className="mr-2 h-4 w-4" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Actualizar
          </Button>
        </div>
      </div>

      {!coverageComplete && !loading && (
        <Card className="flex items-start gap-3 border-amber-500/30 bg-amber-500/5 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <div className="text-sm">
            <p className="font-medium text-amber-100">Cobertura incompleta</p>
            <p className="mt-1 text-muted-foreground">
              El objetivo operativo es {EXPECTED_ACTIVE_RESTAURANTS} restaurantes activos y esta cuenta solo puede ver {active.length}.
              Faltan permisos o conexiones en el origen; no se rellenan con datos simulados.
            </p>
          </div>
        </Card>
      )}

      <Card className="grid grid-cols-2 overflow-hidden md:grid-cols-4">
        <FleetMetric label="Restaurantes activos" value={active.length} detail={`Objetivo: ${EXPECTED_ACTIVE_RESTAURANTS}`} tone={coverageComplete ? "success" : "warning"} />
        <FleetMetric label="Cobertura activa" value={`${active.length}/${EXPECTED_ACTIVE_RESTAURANTS}`} detail={`${connections.length} registros contando inactivos`} tone={coverageComplete ? "success" : "warning"} />
        <FleetMetric label="Lectura al día" value={healthy} detail={`${active.length - healthy} requieren revisión`} tone={healthy === active.length && active.length > 0 ? "success" : "warning"} />
        <FleetMetric label="Certificados" value={certified} detail="Con verificación de escritura" />
      </Card>

      {error && <Card className="p-4 text-sm text-destructive">No se pudo leer la flota: {error}</Card>}

      <Tabs defaultValue="fleet">
        <TabsList className="h-auto w-full justify-start overflow-x-auto bg-transparent p-0">
          <TabsTrigger value="fleet">Flota</TabsTrigger>
          <TabsTrigger value="catalog" disabled={!selectedId}>Catálogo Winerim ↔ Ágora</TabsTrigger>
          <TabsTrigger value="mapping" disabled={!selectedId}>Resolver correspondencias</TabsTrigger>
        </TabsList>

        <TabsContent value="fleet" className="mt-4 space-y-3">
          <Card className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Buscar restaurante o proveedor" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <select
              aria-label="Restaurante para auditar"
              className="h-10 min-w-[240px] rounded-md border border-input bg-background px-3 text-sm"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {connections.map((row) => <option key={row.id} value={row.id}>{row.location_name}</option>)}
            </select>
          </Card>

          <Card className="overflow-hidden">
            {loading ? (
              <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Leyendo restaurantes…</div>
            ) : !visible.length ? (
              <div className="p-6 text-sm text-muted-foreground">No hay restaurantes con este filtro.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] text-left text-sm">
                  <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">Restaurante</th>
                      <th className="px-4 py-3 font-medium">Conexión</th>
                      <th className="px-4 py-3 font-medium">Última lectura</th>
                      <th className="px-4 py-3 font-medium">Catálogo</th>
                      <th className="px-4 py-3 font-medium">Certificación</th>
                      <th className="px-4 py-3 font-medium"><span className="sr-only">Acción</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visible.map((row) => (
                      <tr key={row.id} className={selectedId === row.id ? "bg-primary/5" : "hover:bg-muted/20"}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground">{row.location_name}</p>
                          <p className="mt-0.5 text-xs uppercase text-muted-foreground">{row.provider}</p>
                        </td>
                        <td className="px-4 py-3"><EvidenceBadge state={row.evidence} /></td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{formatEvidenceTime(row.last_sync_at)}</td>
                        <td className="px-4 py-3">
                          <p>{row.catalog_sync_enabled ? "Activo" : "Pausado"}</p>
                          <p className="text-xs text-muted-foreground">
                            {row.catalog_product_count === null ? "Sin recuento" : `${row.catalog_product_count} productos`}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {row.auto_push_verified_ready ? <ShieldCheck className="h-4 w-4 text-emerald-300" /> : <Activity className="h-4 w-4 text-muted-foreground" />}
                            <span>{row.auto_push_verified_ready ? "Verificado" : "Pendiente"}</span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">{row.write_mode || "Modo no informado"}</p>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button variant="ghost" size="sm" onClick={() => setSelectedId(row.id)}>Auditar</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="catalog" className="mt-4 space-y-4">
          <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">{selected?.location_name ?? "Restaurante"}</p>
              <p className="mt-1 text-xs text-muted-foreground">Esperado en Winerim frente a observado en la última lectura de Ágora.</p>
            </div>
            <select className="h-9 min-w-[240px] rounded-md border border-input bg-background px-3 text-sm" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              {connections.map((row) => <option key={row.id} value={row.id}>{row.location_name}</option>)}
            </select>
          </Card>
          {selectedId && <ReviewCatalogAuditTab key={selectedId} connectionId={selectedId} />}
        </TabsContent>

        <TabsContent value="mapping" className="mt-4 space-y-4">
          <Card className="flex items-start gap-3 p-4">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
            <div className="text-sm">
              <p className="font-medium">Decisión controlada</p>
              <p className="mt-1 text-muted-foreground">
                Selecciona un candidato de Winerim y guarda la decisión. Guardar no cambia el mapa productivo, las ventas ni el stock.
                Agua, comida y otras familias no vinícolas quedan fuera.
              </p>
            </div>
          </Card>
          {selectedId && <ReviewUnmappedTab key={selectedId} connectionId={selectedId} />}
          <p className="text-xs text-muted-foreground">También puedes continuar en el <Link className="text-primary hover:underline" to="/revision">hub de revisión completo</Link>.</p>
        </TabsContent>

      </Tabs>
    </div>
  );
}
