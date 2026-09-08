import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, CircleSlash, Clipboard, ClipboardList, Loader2, Play, ShieldCheck, Wifi, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  buildInitialOnboardingGates,
  buildTechnicalReviewPacket,
  DEFAULT_REVO_BASE_URL,
  isReadyForTechnicalReview,
  PROVIDER_LABELS,
  type CommercialOnboardingInput,
  type GateStatus,
  type OnboardingGate,
  validateCommercialOnboardingInput,
} from "@/lib/middlewareOnboarding";
import { getGoLiveBlockingItems, getIntegrationChecklist } from "@/lib/integrationChecklist";
import { getMiddlewareApiUrl, middlewareApiPost } from "@/lib/middlewareApi";

const emptyForm: CommercialOnboardingInput = {
  provider: "agora",
  locationName: "",
  posBaseUrl: "",
  posApiToken: "",
  revoTenant: "",
  revoClientToken: "",
  revoWebhookSecret: "",
  winerimApiToken: "",
};

const gateMeta: Record<GateStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  pass: {
    label: "OK",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    icon: CheckCircle2,
  },
  warn: {
    label: "Revisar",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: AlertCircle,
  },
  fail: {
    label: "Falla",
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    icon: XCircle,
  },
  blocked: {
    label: "Pendiente",
    className: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
    icon: CircleSlash,
  },
};

export default function CommercialOnboarding() {
  const [form, setForm] = useState<CommercialOnboardingInput>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [gates, setGates] = useState<OnboardingGate[]>(() => buildInitialOnboardingGates(emptyForm));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [copiedPacket, setCopiedPacket] = useState(false);

  const providerLabel = PROVIDER_LABELS[form.provider];
  const readyForReview = useMemo(() => isReadyForTechnicalReview(gates), [gates]);
  const checklist = useMemo(() => getIntegrationChecklist(form.provider), [form.provider]);
  const reviewPacket = useMemo(() => buildTechnicalReviewPacket(
    form,
    gates,
    getGoLiveBlockingItems(checklist).map((item) => item.id),
  ), [checklist, form, gates]);

  const updateField = (field: keyof CommercialOnboardingInput, value: string) => {
    const next = { ...form, [field]: value };
    if (field === "provider" && value === "revo" && !form.posBaseUrl) {
      next.posBaseUrl = DEFAULT_REVO_BASE_URL;
    }
    if (field === "provider" && value === "agora" && form.posBaseUrl === DEFAULT_REVO_BASE_URL) {
      next.posBaseUrl = "";
    }
    setForm(next);
    setErrors({});
    setLastMessage(null);
    setCopiedPacket(false);
    setGates(buildInitialOnboardingGates(next));
  };

  const copyReviewPacket = async () => {
    await navigator.clipboard.writeText(JSON.stringify(reviewPacket, null, 2));
    setCopiedPacket(true);
    window.setTimeout(() => setCopiedPacket(false), 1800);
  };

  const runTest = async () => {
    const validation = validateCommercialOnboardingInput(form);
    setErrors(validation.errors as Record<string, string>);
    setGates(buildInitialOnboardingGates(form));
    setLastMessage(null);

    if (!validation.valid) return;

    setLoading(true);
    try {
      const data = await middlewareApiPost<{
        success: boolean;
        gates?: OnboardingGate[];
        readyForTechnicalReview?: boolean;
        errors?: Record<string, string>;
      }>("/api/onboarding/test", validation.normalized);

      if (Array.isArray(data.gates)) setGates(data.gates);
      if (data.success === false) {
        setLastMessage("No se pudo completar la prueba.");
        if (data.errors) setErrors(data.errors);
        return;
      }

      setLastMessage(data.readyForTechnicalReview ? "Listo para revision tecnica." : "Hay puntos que revisar antes de activar.");
    } catch (error: unknown) {
      const apiError = error as { data?: { gates?: OnboardingGate[]; errors?: Record<string, string> } };
      if (Array.isArray(apiError.data?.gates)) {
        setGates(apiError.data.gates);
        if (apiError.data?.errors) setErrors(apiError.data.errors);
        setLastMessage("No se pudo completar la prueba.");
        return;
      }
      if (apiError.data?.errors) setErrors(apiError.data.errors);
      setLastMessage(`No se pudo contactar con ${getMiddlewareApiUrl()}.`);
      setGates([
        { id: "input", label: "Datos basicos", status: "pass", detail: "Campos minimos completos." },
        { id: "api", label: "Middleware", status: "fail", detail: "API del middleware no disponible.", technicalDetail: String(error) },
        { id: "write", label: "Escritura", status: "blocked", detail: "No se ha escrito nada." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Alta de integración</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Prueba inicial para dejar una conexión lista para revisión técnica.
          </p>
        </div>
        <Badge variant="outline" className="w-fit gap-2 px-3 py-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          Sin escrituras
        </Badge>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Datos de conexión</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="provider">POS</Label>
              <Select value={form.provider} onValueChange={(value) => updateField("provider", value)}>
                <SelectTrigger id="provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agora">Agora</SelectItem>
                  <SelectItem value="revo">REVO</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="locationName">Restaurante</Label>
              <Input
                id="locationName"
                value={form.locationName}
                onChange={(event) => updateField("locationName", event.target.value)}
                placeholder="Restaurante / hotel / outlet"
              />
              {errors.locationName && <p className="text-xs text-destructive">{errors.locationName}</p>}
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="posBaseUrl">{form.provider === "revo" ? "Base API REVO" : `URL ${providerLabel}`}</Label>
              <Input
                id="posBaseUrl"
                value={form.posBaseUrl}
                onChange={(event) => updateField("posBaseUrl", event.target.value)}
                placeholder={form.provider === "agora" ? "http://cliente.ddns.net:8984" : DEFAULT_REVO_BASE_URL}
              />
              {errors.posBaseUrl && <p className="text-xs text-destructive">{errors.posBaseUrl}</p>}
            </div>

            {form.provider === "revo" && (
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="revoTenant">Tenant REVO</Label>
                <Input
                  id="revoTenant"
                  value={form.revoTenant}
                  onChange={(event) => updateField("revoTenant", event.target.value)}
                  placeholder="account username"
                  className="font-mono"
                />
                {errors.revoTenant && <p className="text-xs text-destructive">{errors.revoTenant}</p>}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="posApiToken">{form.provider === "revo" ? "Access Token REVO" : `Token ${providerLabel}`}</Label>
              <Input
                id="posApiToken"
                type="password"
                value={form.posApiToken}
                onChange={(event) => updateField("posApiToken", event.target.value)}
                placeholder={form.provider === "revo" ? "Bearer token de Account Management" : "API key / token"}
              />
              {errors.posApiToken && <p className="text-xs text-destructive">{errors.posApiToken}</p>}
            </div>

            {form.provider === "revo" && (
              <div className="space-y-2">
                <Label htmlFor="revoClientToken">Client Token REVO</Label>
                <Input
                  id="revoClientToken"
                  type="password"
                  value={form.revoClientToken}
                  onChange={(event) => updateField("revoClientToken", event.target.value)}
                  placeholder="Integrator client-token"
                />
                {errors.revoClientToken && <p className="text-xs text-destructive">{errors.revoClientToken}</p>}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="winerimApiToken">Token Winerim</Label>
              <Input
                id="winerimApiToken"
                type="password"
                value={form.winerimApiToken}
                onChange={(event) => updateField("winerimApiToken", event.target.value)}
                placeholder="WINERIM-API-TOKEN"
              />
              {errors.winerimApiToken && <p className="text-xs text-destructive">{errors.winerimApiToken}</p>}
            </div>

            {form.provider === "revo" && (
              <div className="space-y-2">
                <Label htmlFor="revoWebhookSecret">Webhook Secret REVO</Label>
                <Input
                  id="revoWebhookSecret"
                  type="password"
                  value={form.revoWebhookSecret}
                  onChange={(event) => updateField("revoWebhookSecret", event.target.value)}
                  placeholder="Opcional en la prueba inicial"
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4 md:col-span-2">
              <div className="text-xs text-muted-foreground">
                La prueba valida alcance y permisos basicos. La activación queda para revisión técnica.
              </div>
              <Button onClick={runTest} disabled={loading} className="min-w-36">
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                Probar
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wifi className="h-4 w-4" />
                Estado
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {gates.map((gateItem) => {
                const meta = gateMeta[gateItem.status];
                const Icon = meta.icon;
                return (
                  <div key={gateItem.id} className="rounded-md border border-border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium text-foreground">{gateItem.label}</span>
                      </div>
                      <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{gateItem.detail}</p>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-6">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">Revisión técnica</span>
                <Badge variant={readyForReview ? "default" : "secondary"}>
                  {readyForReview ? "Preparada" : "Pendiente"}
                </Badge>
              </div>
              {lastMessage && <p className="text-sm text-muted-foreground">{lastMessage}</p>}
              <p className="text-xs text-muted-foreground">
                El siguiente paso técnico revisa familias, legacy, mappings, dry-run y activación automática.
              </p>
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link to="/checklist">Abrir checklist</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardList className="h-4 w-4" />
                Paquete tecnico
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <dl className="space-y-2 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Restaurante</dt>
                    <dd className="truncate font-medium text-foreground">{reviewPacket.locationName || "-"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">POS</dt>
                    <dd className="font-medium text-foreground">{PROVIDER_LABELS[reviewPacket.provider]}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">URL</dt>
                    <dd className="max-w-48 truncate font-mono text-foreground">{reviewPacket.posBaseUrl || "-"}</dd>
                  </div>
                  {reviewPacket.revoTenant && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Tenant</dt>
                      <dd className="max-w-48 truncate font-mono text-foreground">{reviewPacket.revoTenant}</dd>
                    </div>
                  )}
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Gates go-live</dt>
                    <dd className="font-medium text-foreground">{reviewPacket.nextRequiredChecklistIds.length}</dd>
                  </div>
                </dl>
              </div>
              <p className="text-xs text-muted-foreground">
                No incluye tokens ni secretos. Sirve para que tecnica continue con master data, legacy, dry-run y prueba de venta.
              </p>
              <Button type="button" variant="outline" size="sm" className="w-full" onClick={copyReviewPacket}>
                <Clipboard className="mr-2 h-3.5 w-3.5" />
                {copiedPacket ? "Copiado" : "Copiar paquete"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
