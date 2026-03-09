import { useState, useCallback, useEffect } from "react";
import {
  Loader2, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Clock,
  Server, ChevronDown, ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

interface EndpointRecord {
  path: string;
  role: string;
  last_success_at?: string;
  last_success_status?: number;
  last_error_at?: string;
  last_error_status?: number;
  last_error_body?: string;
  verified_at?: string;
}

const ROLE_LABELS: Record<string, string> = {
  auth: "Autenticación",
  sales: "Exportación Ventas",
  catalog: "Catálogo",
  write: "Escritura",
};

const ROLE_COLORS: Record<string, string> = {
  auth: "border-blue-500/30 bg-blue-500/10 text-blue-400",
  sales: "border-warning/30 bg-warning/10 text-warning",
  catalog: "border-success/30 bg-success/10 text-success",
  write: "border-primary/30 bg-primary/10 text-primary",
};

function getStatus(ep: EndpointRecord): "ok" | "error" | "stale" {
  if (!ep.last_success_at && !ep.last_error_at) return "stale";
  if (ep.last_error_at && (!ep.last_success_at || ep.last_error_at > ep.last_success_at)) return "error";
  return "ok";
}

export default function BdpEndpointDiagnostics({
  connectionId,
}: {
  connectionId: string | null;
}) {
  const [endpoints, setEndpoints] = useState<Record<string, EndpointRecord> | null>(null);
  const [lastDiscovery, setLastDiscovery] = useState<string | null>(null);
  const [host, setHost] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [expandedError, setExpandedError] = useState<string | null>(null);

  const fetchEndpoints = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "get-endpoints", connectionId },
      });
      if (error) throw error;
      if (data?.success) {
        setEndpoints(data.discoveredEndpoints || {});
        setLastDiscovery(data.lastDiscoveryAt || null);
        setHost(data.host || "");
      }
    } catch (e) {
      console.error("Failed to fetch BDP endpoints:", e);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    fetchEndpoints();
  }, [fetchEndpoints]);

  if (!connectionId) return null;

  const entries = endpoints ? Object.entries(endpoints) : [];
  const okCount = entries.filter(([, ep]) => getStatus(ep) === "ok").length;
  const errorCount = entries.filter(([, ep]) => getStatus(ep) === "error").length;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3 text-left">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          <p className="text-xs font-semibold text-foreground">Endpoints Persistidos</p>
          {entries.length > 0 && (
            <div className="flex gap-1">
              <Badge variant="default" className="text-[9px] bg-emerald-600">{okCount} OK</Badge>
              {errorCount > 0 && (
                <Badge variant="destructive" className="text-[9px]">{errorCount} Error</Badge>
              )}
            </div>
          )}
        </div>
        <Button
          variant="ghost" size="sm" className="h-6 px-2 text-[10px]"
          onClick={fetchEndpoints} disabled={loading}
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {lastDiscovery && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Clock className="h-2.5 w-2.5" />
          Último discovery: {new Date(lastDiscovery).toLocaleString()}
        </p>
      )}

      {!endpoints && !loading && (
        <p className="text-[11px] text-muted-foreground">
          No hay endpoints descubiertos. Ejecuta "Run Discovery" en el paso de Diagnósticos.
        </p>
      )}

      {entries.length > 0 && (
        <div className="space-y-1.5">
          {entries.map(([key, ep]) => {
            const status = getStatus(ep);
            const isExpanded = expandedError === key;
            return (
              <div
                key={key}
                className={`rounded-md border px-3 py-2 text-[11px] ${
                  status === "ok"
                    ? "border-success/20 bg-success/5"
                    : status === "error"
                    ? "border-destructive/20 bg-destructive/5"
                    : "border-border bg-secondary/20"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {status === "ok" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                    ) : status === "error" ? (
                      <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="font-medium text-foreground">{key}</span>
                    <Badge
                      variant="outline"
                      className={`text-[9px] ${ROLE_COLORS[ep.role] || "border-border"}`}
                    >
                      {ROLE_LABELS[ep.role] || ep.role}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {ep.last_success_status && (
                      <Badge variant="default" className="text-[9px] bg-emerald-600">
                        {ep.last_success_status}
                      </Badge>
                    )}
                    {ep.last_error_status !== undefined && ep.last_error_status > 0 && status === "error" && (
                      <Badge variant="destructive" className="text-[9px]">
                        {ep.last_error_status}
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Path */}
                <p className="font-mono text-[10px] text-muted-foreground mt-1 truncate">
                  {host}{ep.path}
                </p>

                {/* Timestamps */}
                <div className="flex gap-4 mt-1 text-[9px] text-muted-foreground">
                  {ep.last_success_at && (
                    <span className="flex items-center gap-0.5">
                      <CheckCircle2 className="h-2 w-2 text-success" />
                      {new Date(ep.last_success_at).toLocaleString()}
                    </span>
                  )}
                  {ep.last_error_at && (
                    <span className="flex items-center gap-0.5">
                      <XCircle className="h-2 w-2 text-destructive" />
                      {new Date(ep.last_error_at).toLocaleString()}
                    </span>
                  )}
                </div>

                {/* Error body toggle */}
                {ep.last_error_body && status === "error" && (
                  <div className="mt-1.5">
                    <button
                      onClick={() => setExpandedError(isExpanded ? null : key)}
                      className="flex items-center gap-1 text-[10px] text-destructive hover:underline"
                    >
                      {isExpanded ? (
                        <ChevronUp className="h-2.5 w-2.5" />
                      ) : (
                        <ChevronDown className="h-2.5 w-2.5" />
                      )}
                      {isExpanded ? "Ocultar error" : "Ver error (2KB)"}
                    </button>
                    {isExpanded && (
                      <pre className="mt-1 max-h-32 overflow-auto rounded border border-destructive/20 bg-destructive/5 p-2 text-[10px] font-mono text-foreground whitespace-pre-wrap break-all">
                        {ep.last_error_body}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
