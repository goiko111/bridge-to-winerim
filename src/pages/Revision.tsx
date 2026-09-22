import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Info, Loader2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useReviewConnections } from "@/hooks/useReviewConnections";
import ReviewUnmappedTab from "@/components/review/ReviewUnmappedTab";
import ReviewLegacyTab from "@/components/review/ReviewLegacyTab";
import ReviewCatalogAuditTab from "@/components/review/ReviewCatalogAuditTab";
import { formatDateTime } from "@/lib/catalogReview";
import { unmappedFilterKey } from "@/lib/reviewUnmapped";

const TAB_KEY = "review.tab";

export default function Revision() {
  const { connections, connection, connectionId, setConnectionId, loading, error } = useReviewConnections();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<string>(() => localStorage.getItem(TAB_KEY) ?? "unmapped");
  const [unmappedSeed, setUnmappedSeed] = useState(0);

  useEffect(() => {
    localStorage.setItem(TAB_KEY, tab);
  }, [tab]);

  useEffect(() => {
    const requestedConnection = searchParams.get("connection");
    if (requestedConnection && connections.some((row) => row.id === requestedConnection)) {
      setConnectionId(requestedConnection);
    }
    const requestedTab = searchParams.get("tab");
    if (requestedTab && ["unmapped", "legacy", "audit"].includes(requestedTab)) setTab(requestedTab);
  }, [connections, searchParams, setConnectionId]);

  const openInReview = (search: string) => {
    localStorage.setItem(
      unmappedFilterKey(connectionId),
      JSON.stringify({ search, family: "", format: "", status: "", days: 30 }),
    );
    setUnmappedSeed((s) => s + 1);
    setTab("unmapped");
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Revisión</h1>
        <p className="max-w-4xl text-sm text-muted-foreground">
          Zona de lectura y decisión. Guardar una decisión no modifica mapas productivos, ventas, stock, precios,
          cursores ni catálogo. Una tarea con éxito no prueba publicación: solo una lectura fresca de Ágora permite
          afirmar que un producto o un precio está allí.
        </p>
      </div>

      <Card className="flex flex-wrap items-center gap-3 p-3 text-xs">
        <span className="text-muted-foreground">Restaurante</span>
        <select
          className="h-8 min-w-[240px] rounded-md border border-input bg-background px-2 text-xs"
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.location_name}
              {c.enabled ? "" : " (inactiva)"}
            </option>
          ))}
        </select>
        {connection && (
          <>
            <Badge variant={connection.enabled ? "default" : "outline"}>
              {connection.enabled ? "Activa" : "Inactiva"}
            </Badge>
            {connection.catalog_sync_enabled === false && <Badge variant="outline">Catálogo pausado</Badge>}
            {connection.circuit_breaker_paused_until &&
              new Date(connection.circuit_breaker_paused_until) > new Date() && (
                <Badge variant="destructive">Parada de seguridad</Badge>
              )}
            <span className="text-muted-foreground">
              Última sincronización: {formatDateTime(connection.last_sync_at)}
            </span>
          </>
        )}
      </Card>

      <Card className="flex items-start gap-2 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span>
          Los valores desconocidos se muestran como «Desconocido» o «—»: nunca se convierten en cero, falso ni éxito.
          Legacy es una procedencia, no un estado excluyente: si no tiene mapping confirmado aparece también en «Sin mapear»
          con su distintivo. Nunca se oculta ni se remapea automáticamente.
        </span>
      </Card>

      {error && <Card className="p-3 text-xs text-destructive">{error}</Card>}

      {loading ? (
        <Card className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando conexiones…
        </Card>
      ) : !connectionId ? (
        <Card className="p-4 text-xs text-muted-foreground">No hay conexiones Ágora disponibles.</Card>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="unmapped">Sin mapear</TabsTrigger>
            <TabsTrigger value="legacy">Legacy</TabsTrigger>
            <TabsTrigger value="audit">Auditoría catálogo</TabsTrigger>
          </TabsList>
          <TabsContent value="unmapped" className="mt-4">
            <ReviewUnmappedTab key={`${connectionId}-${unmappedSeed}`} connectionId={connectionId} />
          </TabsContent>
          <TabsContent value="legacy" className="mt-4">
            <ReviewLegacyTab key={connectionId} connectionId={connectionId} onOpenInReview={openInReview} />
          </TabsContent>
          <TabsContent value="audit" className="mt-4">
            <ReviewCatalogAuditTab key={connectionId} connectionId={connectionId} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
