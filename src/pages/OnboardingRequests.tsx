import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, Loader2, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { resolveMiddlewareApiUrl } from "@/lib/middlewareApiUrl";
import {
  ONBOARDING_REQUEST_STATUSES,
  canTransitionOnboardingRequestStatus,
  type OnboardingRequestStatus,
} from "@/lib/onboardingRequest";

const middlewareApiUrl = resolveMiddlewareApiUrl(import.meta.env.VITE_MIDDLEWARE_API_URL, window.location.origin);

type FilterStatus = "ALL" | OnboardingRequestStatus;
type RequestStatus = OnboardingRequestStatus;

interface OnboardingRequestRow {
  id: string;
  provider: "agora" | "revo";
  location_name: string;
  pos_base_url: string;
  status: RequestStatus;
  requested_by_email?: string | null;
  normalized_input?: {
    revoTenant?: string;
    posAuthProvided?: boolean;
    winerimAuthProvided?: boolean;
    revoClientAuthProvided?: boolean;
  };
  test_summary?: {
    readyForTechnicalReview?: boolean;
    pass?: number;
    warn?: number;
    fail?: number;
    blocked?: number;
  };
  ready_for_technical_review: boolean;
  submitted_at?: string | null;
  created_at: string;
  updated_at: string;
}

const statusMeta: Record<RequestStatus, { label: string; className: string }> = {
  DRAFT: { label: "Borrador", className: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300" },
  TESTED: { label: "Probada", className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  READY_FOR_TECHNICAL_REVIEW: { label: "Lista", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  TECHNICAL_REVIEW: { label: "Revisión", className: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300" },
  APPROVED: { label: "Aprobada", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  REJECTED: { label: "Rechazada", className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300" },
  CONVERTED: { label: "Convertida", className: "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300" },
  CANCELED: { label: "Cancelada", className: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300" },
};

function formatDate(value?: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function requestLabel(row: OnboardingRequestRow): string {
  if (row.provider === "revo" && row.normalized_input?.revoTenant) {
    return `${row.location_name} · ${row.normalized_input.revoTenant}`;
  }
  return row.location_name;
}

function canMoveTo(row: OnboardingRequestRow, nextStatus: OnboardingRequestStatus): boolean {
  return row.status !== nextStatus && canTransitionOnboardingRequestStatus(row.status, nextStatus);
}

export default function OnboardingRequests() {
  const [rows, setRows] = useState<OnboardingRequestRow[]>([]);
  const [status, setStatus] = useState<FilterStatus>("ALL");
  const [loading, setLoading] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const filteredRows = useMemo(() => rows, [rows]);

  const loadRows = async () => {
    setLoading(true);
    setMessage(null);
    const query = status === "ALL" ? "" : `?status=${encodeURIComponent(status)}`;
    try {
      const response = await fetch(`${middlewareApiUrl}/api/onboarding/requests${query}`, {
        credentials: "include",
      });
      const data = await response.json();

      if (response.status === 503 && data.error === "REQUEST_STORAGE_DISABLED") {
        setRows([]);
        setMessage("La bandeja de solicitudes todavia no esta activada en este entorno.");
        return;
      }

      if (!response.ok || data.success === false) {
        setRows([]);
        setMessage("No se pudieron cargar las solicitudes.");
        return;
      }

      setRows(Array.isArray(data.items) ? data.items : []);
    } catch {
      setRows([]);
      setMessage(`No se pudo contactar con ${middlewareApiUrl}.`);
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (row: OnboardingRequestRow, nextStatus: RequestStatus) => {
    setUpdatingId(row.id);
    setMessage(null);
    try {
      const response = await fetch(`${middlewareApiUrl}/api/onboarding/requests/${row.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await response.json();

      if (!response.ok || data.success === false) {
        setMessage("No se pudo actualizar la solicitud.");
        return;
      }

      setRows((current) => current.map((item) => (item.id === row.id && data.item ? data.item : item)));
    } catch {
      setMessage(`No se pudo contactar con ${middlewareApiUrl}.`);
    } finally {
      setUpdatingId(null);
    }
  };

  useEffect(() => {
    void loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Solicitudes de integración</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Bandeja técnica para revisar altas antes de convertirlas en conexiones.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={(value) => setStatus(value as FilterStatus)}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todas</SelectItem>
              {ONBOARDING_REQUEST_STATUSES.map((item) => (
                <SelectItem key={item} value={item}>
                  {statusMeta[item].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={loadRows} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refrescar
          </Button>
        </div>
      </div>

      {message && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cola de revisión</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Restaurante</TableHead>
                <TableHead>POS</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Credenciales</TableHead>
                <TableHead>Semáforos</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map((row) => {
                const meta = statusMeta[row.status] || statusMeta.TESTED;
                const isUpdating = updatingId === row.id;
                const summary = row.test_summary || {};
                const canReview = canMoveTo(row, "TECHNICAL_REVIEW");
                const canApprove = canMoveTo(row, "APPROVED");
                const canReject = canMoveTo(row, "REJECTED");
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{requestLabel(row)}</div>
                      <div className="mt-1 max-w-80 truncate font-mono text-xs text-muted-foreground">{row.pos_base_url}</div>
                      {row.requested_by_email && (
                        <div className="mt-1 text-xs text-muted-foreground">{row.requested_by_email}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="uppercase">{row.provider}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {row.normalized_input?.posAuthProvided ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
                        POS
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        {row.normalized_input?.winerimAuthProvided ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
                        Winerim
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-300">
                          {summary.pass || 0}
                        </Badge>
                        <Badge variant="outline" className="border-amber-500/30 text-amber-700 dark:text-amber-300">
                          {summary.warn || 0}
                        </Badge>
                        <Badge variant="outline" className="border-red-500/30 text-red-700 dark:text-red-300">
                          {summary.fail || 0}
                        </Badge>
                        <Badge variant="outline" className="border-slate-500/30 text-slate-600 dark:text-slate-300">
                          {summary.blocked || 0}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock3 className="h-3.5 w-3.5" />
                        {formatDate(row.submitted_at || row.created_at)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isUpdating || !canReview}
                          onClick={() => updateStatus(row, "TECHNICAL_REVIEW")}
                        >
                          Revisar
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isUpdating || !canApprove}
                          onClick={() => updateStatus(row, "APPROVED")}
                        >
                          Aprobar
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isUpdating || !canReject}
                          onClick={() => updateStatus(row, "REJECTED")}
                        >
                          <ShieldAlert className="mr-1 h-3.5 w-3.5" />
                          Rechazar
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!loading && filteredRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">
                    Sin solicitudes para mostrar.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
