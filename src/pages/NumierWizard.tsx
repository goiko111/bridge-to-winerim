import { useState, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, Loader2, ArrowLeft, ArrowRight, MapPin, ShoppingCart, Info, Database, BarChart3, Play, XCircle, Zap } from "lucide-react";
import { useNumierConnection } from "@/hooks/useNumierConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";
import NumierTpvDiagnostics from "@/components/NumierTpvDiagnostics";
import { useNavigate } from "react-router-dom";

interface ValidationReport {
  running: boolean;
  phase: string;
  sandbox_reachable: boolean | null;
  tpv_valid: "yes" | "no" | "suspicious" | "wrong_mapping" | "valid_no_sales" | null;
  diagnosis_error: string | null;
  pages_read: number | null;
  tickets_seen: number | null;
  unique_ticket_ids: number | null;
  duplicate_tickets: number | null;
  events_normalized: number | null;
  lines_normalized: number | null;
  fetch_error: string | null;
  events_saved: number | null;
  lines_saved: number | null;
  save_error: string | null;
  location_id_used: string | null;
  tpv_id_used: string | null;
  tpv_id_source: string | null;
  numier_message: string | null;
}

const steps = [
  { label: "Connection", description: "Configure Numier API-KEY" },
  { label: "Location & TPV", description: "Discover location, set TPV ID" },
  { label: "Sales Preview", description: "Fetch and preview sales data" },
  { label: "Activate", description: "Enable automated sync" },
];

export default function NumierWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  // Form state
  const [locationName, setLocationName] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("https://sandbox.numier.com/api/public/index.php/api");
  const [apiToken, setApiToken] = useState("");
  const [startDate, setStartDate] = useState("2023-09-01");
  const [endDate, setEndDate] = useState("2023-09-29");

  const {
    connectionId,
    testStatus,
    testError,
    testConnection,
    capabilities,
    locations,
    loadingLocations,
    fetchLocations,
    selectedLocationId,
    selectLocation,
    activeLocationId,
    selectedTpvId,
    selectTpv,
    salesEvents,
    loadingSales,
    salesMetrics,
    fetchSalesRange,
    saving,
    saveResult,
    saveSalesRange,
    enableSync,
    activeTpvId,
    tpvSource,
    manualTpvOverride,
    setManualTpvOverride,
    diagnosing,
    diagnosisResult,
    diagnoseTpv,
    probing,
    probeResult,
    probeSales,
  } = useNumierConnection();

  const dateRangeValid = useMemo(() => {
    if (!startDate || !endDate) return false;
    return startDate <= endDate;
  }, [startDate, endDate]);

  const canFetchSales = !!activeTpvId && dateRangeValid && !loadingSales;

  // ── Sandbox Validation ────────────────────────────────────
  const [validation, setValidation] = useState<ValidationReport | null>(null);

  const runSandboxValidation = useCallback(async () => {
    if (!connectionId || !activeTpvId || !dateRangeValid) return;

    const report: ValidationReport = {
      running: true, phase: "Diagnosing TPV…",
      sandbox_reachable: null, tpv_valid: null, diagnosis_error: null,
      pages_read: null, tickets_seen: null, unique_ticket_ids: null,
      duplicate_tickets: null, events_normalized: null, lines_normalized: null,
      fetch_error: null, events_saved: null, lines_saved: null, save_error: null,
      location_id_used: activeLocationId,
      tpv_id_used: activeTpvId,
      tpv_id_source: tpvSource,
      numier_message: null,
    };
    setValidation({ ...report });

    // Phase 1: diagnose (pass date range)
    try {
      await diagnoseTpv(startDate, endDate);
    } catch (e) {
      // diagnoseTpv sets diagnosisResult internally
    }

    // Phase 2: fetch sales
    report.phase = "Fetching sales…";
    setValidation({ ...report });
    try {
      await fetchSalesRange(startDate, endDate);
    } catch (e) {
      report.fetch_error = (e as Error).message;
    }

    report.running = false;
    report.phase = "Done";
    setValidation({ ...report });
  }, [connectionId, activeTpvId, activeLocationId, tpvSource, dateRangeValid, startDate, endDate, diagnoseTpv, fetchSalesRange]);

  // Derive final report from latest state
  const validationReport = useMemo(() => {
    if (!validation) return null;
    const diag = diagnosisResult;
    const conclusion = diag?.conclusion as string | undefined;
    return {
      ...validation,
      sandbox_reachable: diag ? diag.success === true || !!conclusion : null,
      tpv_valid: conclusion === "valid" ? "yes" as const
        : conclusion === "valid_no_sales_in_range" ? "valid_no_sales" as const
        : conclusion === "suspicious" ? "suspicious" as const
        : conclusion === "wrong_tpv_mapping" ? "wrong_mapping" as const
        : conclusion === "invalid" ? "no" as const
        : null,
      diagnosis_error: diag && !diag.success ? ((diag.error || diag.message) as string) : null,
      numier_message: conclusion === "wrong_tpv_mapping"
        ? ((diag?.warnings as string[])?.join(" · ") || "Location ID ≠ TPV ID")
        : conclusion === "valid_no_sales_in_range"
        ? ((diag?.warnings as string[])?.join(" · ") || "No sales in selected range")
        : null,
      pages_read: salesMetrics?.pagination?.pages_read ?? null,
      tickets_seen: salesMetrics?.pagination?.tickets_seen ?? null,
      unique_ticket_ids: salesMetrics?.pagination?.unique_ticket_ids ?? null,
      duplicate_tickets: salesMetrics?.pagination?.duplicate_ticket_ids_count ?? null,
      events_normalized: salesMetrics?.normalization?.events_count ?? null,
      lines_normalized: salesMetrics?.normalization?.total_lines ?? null,
      events_saved: saveResult?.savedEvents ?? null,
      lines_saved: saveResult?.savedLines ?? null,
    };
  }, [validation, diagnosisResult, salesMetrics, saveResult]);

  const tpvSourceLabel = useMemo(() => {
    switch (tpvSource) {
      case "manual_override": return "🔧 manual override";
      case "selected": return "✅ explicitly set";
      default: return "❌ not set";
    }
  }, [tpvSource]);

  const canNext = useMemo(() => {
    switch (step) {
      case 0: return testStatus === "success";
      case 1: return !!activeTpvId;
      case 2: return true;
      case 3: return true;
      default: return false;
    }
  }, [step, testStatus, activeTpvId]);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/integrations")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Numier Integration</h1>
          <p className="text-sm text-muted-foreground">Connect your Numier POS to Winerim</p>
        </div>
        <Badge variant="outline" className="ml-auto bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30">
          Experimental
        </Badge>
      </div>

      {/* Step indicator */}
      <div className="flex gap-2">
        {steps.map((s, i) => (
          <div
            key={i}
            className={`flex-1 text-center text-xs py-2 rounded-md border transition-colors ${
              i === step
                ? "bg-primary/10 border-primary text-primary font-medium"
                : i < step
                ? "bg-muted border-border text-muted-foreground"
                : "border-border text-muted-foreground/50"
            }`}
          >
            {s.label}
          </div>
        ))}
      </div>

      {/* Step 0: Connection */}
      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Numier API Connection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground">Location Name</label>
              <Input
                placeholder="Mi Restaurante"
                value={locationName}
                onChange={(e) => setLocationName(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">API Base URL</label>
              <Input
                placeholder="https://sandbox.numier.com/api/public/index.php/api"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Sandbox: <code className="text-xs bg-muted px-1 rounded">https://sandbox.numier.com/api/public/index.php/api</code>
                {" · "}
                Producción: <code className="text-xs bg-muted px-1 rounded">https://www.numier.com/api/public/index.php/api</code>
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">API-KEY</label>
              <Input
                type="password"
                placeholder="Tu API-KEY de Numier"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Se envía como header <code className="text-xs bg-muted px-1 rounded">apiKey</code>. Solicítala desde tu panel de Numier.
              </p>
            </div>

            <Button
              onClick={() => testConnection(apiBaseUrl, apiToken, locationName || undefined)}
              disabled={!apiBaseUrl || !apiToken || testStatus === "testing"}
              className="w-full"
            >
              {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {testStatus === "success" ? (
                <><CheckCircle2 className="mr-2 h-4 w-4" /> Connected</>
              ) : (
                "Test Connection"
              )}
            </Button>

            {testStatus === "error" && testError && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-md">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{testError}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 1: Location & TPV */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <MapPin className="h-5 w-5" /> Location & TPV Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Section A: Location Discovery */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                📍 Location Discovery
                <Badge variant="outline" className="text-xs">Informational</Badge>
              </h3>
              <p className="text-xs text-muted-foreground">
                Discover the establishments linked to your API-KEY. Note: the location ID from getLocales is <strong>NOT</strong> the same as the TPV ID used for sales/categories/products.
              </p>
              <Button onClick={fetchLocations} disabled={loadingLocations} variant="secondary" size="sm">
                {loadingLocations && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Discover Locations
              </Button>

              {locations.length > 0 && (
                <div className="space-y-2">
                  {locations.map((loc) => {
                    const isSelected = (selectedLocationId || activeLocationId) === loc.id;
                    return (
                      <button
                        key={loc.id}
                        onClick={() => selectLocation(loc.id)}
                        className={`w-full flex items-center justify-between p-3 rounded-md border transition-colors text-left ${
                          isSelected
                            ? "border-blue-500/50 bg-blue-500/10"
                            : "border-border bg-secondary/30 hover:bg-secondary/50"
                        }`}
                      >
                        <div>
                          <span className="font-medium text-foreground">{loc.name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">Location ID: {loc.id}</Badge>
                          {isSelected && <CheckCircle2 className="h-4 w-4 text-blue-500" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {activeLocationId && (
                <div className="flex items-start gap-2 text-xs bg-blue-500/10 text-blue-700 dark:text-blue-400 p-2 rounded-md">
                  <Info className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>Location ID: <strong>{activeLocationId}</strong> — este es solo el identificador del local, NO el idTpv operativo.</span>
                </div>
              )}
            </div>

            <div className="border-t border-border" />

            {/* Section B: TPV ID (operational) */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                🖥️ TPV ID (Operational)
                <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">Required</Badge>
              </h3>
              <p className="text-xs text-muted-foreground">
                El idTpv real que Numier usa para ventas, categorías y productos. En el sandbox es <code className="bg-muted px-1 rounded">6191</code>. Puede ser distinto del Location ID.
              </p>

              {/* Manual TPV Override */}
              <div className="rounded-md border border-dashed border-amber-500/50 bg-amber-500/5 p-4 space-y-2">
                <label className="text-sm font-medium text-foreground">TPV ID real</label>
                <Input
                  placeholder="e.g. 6191"
                  value={manualTpvOverride}
                  onChange={(e) => setManualTpvOverride(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Sandbox: <code className="bg-muted px-1 rounded">6191</code>. En producción, pide el idTpv correcto a Numier.
                </p>
              </div>

              {/* Or set a persisted TPV ID */}
              {!manualTpvOverride.trim() && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-muted-foreground">O establece un TPV ID fijo:</label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="TPV ID"
                      value={selectedTpvId || ""}
                      onChange={(e) => selectTpv(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-border" />

            {/* Summary */}
            <div className="rounded-md border border-border bg-muted/50 p-3 space-y-1.5">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">ID Summary</h4>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Location ID (getLocales)</span>
                <span className="text-foreground font-mono">{activeLocationId || "—"}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">TPV ID (operational)</span>
                <span className={`font-mono font-medium ${activeTpvId ? "text-foreground" : "text-destructive"}`}>
                  {activeTpvId || "⛔ not set"}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">TPV ID source</span>
                <span className="text-muted-foreground">{tpvSourceLabel}</span>
              </div>
            </div>

            {!activeTpvId && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-md">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>Debes establecer un TPV ID para continuar. En sandbox usa <strong>6191</strong>.</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 2: Sales Preview */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ShoppingCart className="h-5 w-5" /> Sales Preview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Effective config summary */}
            <div className="rounded-md border border-border bg-muted/50 p-3 space-y-1.5">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Effective Configuration</h4>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Base URL</span>
                <code className="text-foreground font-mono text-[11px] max-w-[300px] truncate">{apiBaseUrl}</code>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Location ID</span>
                <span className="text-foreground font-mono">{activeLocationId || "—"}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">TPV ID</span>
                <span className={`font-mono font-medium ${activeTpvId ? "text-foreground" : "text-destructive"}`}>
                  {activeTpvId || <span className="text-destructive">⛔ not set</span>}
                  <span className="ml-1 text-muted-foreground">({tpvSourceLabel})</span>
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Date Range</span>
                <span className="text-foreground font-mono">{startDate} → {endDate}</span>
              </div>
            </div>

            {!activeTpvId && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-md">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>No TPV ID configured. Go back and set one.</span>
              </div>
            )}

            {!dateRangeValid && startDate && endDate && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-md">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>Invalid date range: start date must be ≤ end date.</span>
              </div>
            )}

            {/* TPV Diagnostics */}
            <NumierTpvDiagnostics
              activeTpvId={activeTpvId}
              activeLocationId={activeLocationId}
              diagnosing={diagnosing}
              diagnosisResult={diagnosisResult}
              onDiagnose={() => diagnoseTpv(startDate, endDate)}
            />

            {/* Sandbox date helper */}
            {apiBaseUrl.includes("sandbox") && (
              <div className="flex items-start gap-2 text-xs bg-blue-500/10 text-blue-700 dark:text-blue-400 p-2 rounded-md border border-blue-500/20">
                <Info className="h-3 w-3 mt-0.5 shrink-0" />
                <span>Sandbox data is available until <strong>2023-09-29</strong>. Make sure your date range falls within this period.</span>
              </div>
            )}

            {/* Warn if range is outside sandbox data */}
            {apiBaseUrl.includes("sandbox") && startDate > "2023-09-29" && (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 p-2 rounded-md border border-amber-500/20">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                <span>⚠ Your start date ({startDate}) is after the sandbox data limit (2023-09-29). You will get 0 results.</span>
              </div>
            )}

            {/* Date range inputs */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-foreground">Start Date</label>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">End Date</label>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>

            {/* Probe & Fetch buttons */}
            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={() => probeSales(startDate, endDate)}
                disabled={!canFetchSales || probing}
                variant="outline"
                className="w-full"
              >
                {probing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Zap className="mr-2 h-4 w-4" />
                Probe Page 1
              </Button>
              <Button
                onClick={() => fetchSalesRange(startDate, endDate)}
                disabled={!canFetchSales}
                className="w-full"
              >
                {loadingSales && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Fetch All Sales
              </Button>
            </div>

            {/* Probe result */}
            {probeResult && (
              <div className="rounded-md border border-border p-4 space-y-3">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5" /> Sales Probe (Page 1 only — not saved)
                </h4>
                {probeResult.success ? (
                  <div className="space-y-2">
                    {(() => {
                      const p = probeResult.probe as Record<string, unknown>;
                      return (
                        <>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                            <MetricRow label="Effective URL" value={String(p.effective_url || "—")} />
                            <MetricRow label="HTTP Status" value={Number(p.http_status)} />
                            <MetricRow label="API response" value={p.api_response === true ? "✅ true" : `❌ ${p.api_response}`} />
                            <MetricRow label="Total pages" value={Number(p.total_pages)} />
                            <MetricRow label="Tickets in page 1" value={Number(p.tickets_in_page1)} />
                            <MetricRow label="Lines in 1st ticket" value={Number(p.first_ticket_lines)} />
                            <MetricRow label="TPV ID" value={String(p.tpv_id)} />
                            <MetricRow label="TPV source" value={String(p.tpv_source)} />
                          </div>
                          {p.api_message && (
                            <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 p-2 rounded">
                              Numier message: {String(p.api_message)}
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground font-medium">Top-level keys: {(p.top_level_keys as string[])?.join(", ")}</div>
                          {p.first_ticket_sample && (
                            <details className="text-xs">
                              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">First ticket sample (raw)</summary>
                              <pre className="mt-1 bg-muted p-2 rounded overflow-x-auto text-[10px] leading-tight max-h-48">
                                {String(p.first_ticket_sample)}
                              </pre>
                            </details>
                          )}
                        </>
                      );
                    })()}
                  </div>
                ) : (
                  <div className="text-xs text-destructive">{String(probeResult.error || probeResult.message || "Probe failed")}</div>
                )}
              </div>
            )}

            {/* Sales results */}
            {salesEvents.length > 0 && (
              <div className="space-y-4">
                {/* Summary metrics */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-md border border-border p-3 text-center">
                    <div className="text-lg font-bold text-foreground">{salesEvents.length}</div>
                    <div className="text-xs text-muted-foreground">Documents</div>
                  </div>
                  <div className="rounded-md border border-border p-3 text-center">
                    <div className="text-lg font-bold text-foreground">
                      {salesEvents.reduce((s, e) => s + e.line_count, 0)}
                    </div>
                    <div className="text-xs text-muted-foreground">Lines</div>
                  </div>
                  <div className="rounded-md border border-border p-3 text-center">
                    <div className="text-lg font-bold text-foreground">
                      €{salesEvents.reduce((s, e) => s + e.total_amount, 0).toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground">Total Amount</div>
                  </div>
                </div>

                {/* Detailed Metrics */}
                {salesMetrics && (
                  <div className="rounded-md border border-border p-4 space-y-3">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                      <BarChart3 className="h-3.5 w-3.5" /> Pagination & Normalization Metrics
                    </h4>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                      <MetricRow label="Pages read" value={salesMetrics.pagination.pages_read} />
                      <MetricRow label="Tickets seen" value={salesMetrics.pagination.tickets_seen} />
                      <MetricRow label="Unique ticket IDs" value={salesMetrics.pagination.unique_ticket_ids} />
                      <MetricRow
                        label="Duplicate ticket IDs"
                        value={salesMetrics.pagination.duplicate_ticket_ids_count}
                        warn={salesMetrics.pagination.duplicate_ticket_ids_count > 0}
                      />
                      <MetricRow label="Events normalized" value={salesMetrics.normalization.events_count} />
                      <MetricRow label="Total lines" value={salesMetrics.normalization.total_lines} />
                      <MetricRow
                        label="Tickets without lines"
                        value={salesMetrics.normalization.tickets_without_lines}
                        warn={salesMetrics.normalization.tickets_without_lines > 0}
                      />
                      <MetricRow
                        label="Lines with zero price"
                        value={salesMetrics.normalization.lines_with_zero_price}
                        warn={salesMetrics.normalization.lines_with_zero_price > 0}
                      />
                      <MetricRow
                        label="Lines without product ID"
                        value={salesMetrics.normalization.lines_without_product_id}
                        warn={salesMetrics.normalization.lines_without_product_id > 0}
                      />
                      {salesMetrics.normalization.business_day_range && (
                        <div className="flex justify-between text-xs col-span-2 pt-1 border-t border-border">
                          <span className="text-muted-foreground">Business day range</span>
                          <span className="font-mono text-foreground">
                            {salesMetrics.normalization.business_day_range.min} → {salesMetrics.normalization.business_day_range.max}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Save to DB */}
                <Button
                  onClick={() => saveSalesRange(startDate, endDate)}
                  disabled={saving}
                  variant="secondary"
                  className="w-full"
                >
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Database className="mr-2 h-4 w-4" />
                  Save to Database
                </Button>

                {saveResult && (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="h-4 w-4" /> Saved Successfully
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                      <MetricRow label="Events saved" value={saveResult.savedEvents} />
                      <MetricRow label="Lines saved" value={saveResult.savedLines} />
                      {saveResult.pagination && (
                        <>
                          <MetricRow label="Pages read" value={saveResult.pagination.pages_read} />
                          <MetricRow label="Tickets seen" value={saveResult.pagination.tickets_seen} />
                          <MetricRow
                            label="Duplicates"
                            value={saveResult.pagination.duplicate_ticket_ids_count}
                            warn={saveResult.pagination.duplicate_ticket_ids_count > 0}
                          />
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {!loadingSales && salesEvents.length === 0 && !validationReport && (
              <p className="text-xs text-muted-foreground italic">No sales fetched yet. Configure dates and click Fetch, or run full Sandbox Validation.</p>
            )}

            {/* ── Sandbox Validation ────────────────── */}
            <div className="border-t border-border pt-4 space-y-3">
              <Button
                onClick={runSandboxValidation}
                disabled={!canFetchSales || validation?.running || diagnosing}
                className="w-full"
                variant="default"
              >
                {(validation?.running || diagnosing) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Play className="mr-2 h-4 w-4" />
                {validation?.running ? validation.phase : "Run Sandbox Validation"}
              </Button>

              {validationReport && !validationReport.running && (
                <Card className="border-2 border-primary/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <BarChart3 className="h-4 w-4" /> Sandbox Validation Report
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* Context: IDs used */}
                    <div className="rounded-md bg-muted/50 p-2 space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Location ID used</span>
                        <span className="font-mono text-foreground">{validationReport.location_id_used || "—"}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">TPV ID used</span>
                        <span className="font-mono font-medium text-foreground">{validationReport.tpv_id_used || "—"}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">TPV ID source</span>
                        <span className="text-muted-foreground">{validationReport.tpv_id_source || "—"}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                      <ValidationRow label="Sandbox reachable" value={validationReport.sandbox_reachable === true ? "yes" : validationReport.sandbox_reachable === false ? "no" : "—"} ok={validationReport.sandbox_reachable === true} />
                      <ValidationRow
                        label="TPV valid"
                        value={validationReport.tpv_valid === "wrong_mapping" ? "wrong mapping"
                          : validationReport.tpv_valid === "valid_no_sales" ? "valid (no sales in range)"
                          : (validationReport.tpv_valid ?? "—")}
                        ok={validationReport.tpv_valid === "yes" || validationReport.tpv_valid === "valid_no_sales"}
                        warn={validationReport.tpv_valid === "suspicious" || validationReport.tpv_valid === "wrong_mapping"}
                      />
                      <ValidationRow label="Pages read" value={validationReport.pages_read ?? "—"} />
                      <ValidationRow label="Tickets seen" value={validationReport.tickets_seen ?? "—"} />
                      <ValidationRow label="Unique ticket IDs" value={validationReport.unique_ticket_ids ?? "—"} />
                      <ValidationRow label="Duplicate tickets" value={validationReport.duplicate_tickets ?? "—"} warn={(validationReport.duplicate_tickets ?? 0) > 0} />
                      <ValidationRow label="Events normalized" value={validationReport.events_normalized ?? "—"} />
                      <ValidationRow label="Lines normalized" value={validationReport.lines_normalized ?? "—"} />
                      <ValidationRow label="Events saved" value={validationReport.events_saved ?? "—"} />
                      <ValidationRow label="Lines saved" value={validationReport.lines_saved ?? "—"} />
                    </div>

                    {validationReport.tpv_valid === "wrong_mapping" && validationReport.numier_message && (
                      <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 p-2 rounded">
                        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span><strong>Wrong TPV mapping:</strong> {validationReport.numier_message}</span>
                      </div>
                    )}

                    {validationReport.diagnosis_error && (
                      <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 p-2 rounded">
                        <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span><strong>Diagnosis error:</strong> {validationReport.diagnosis_error}</span>
                      </div>
                    )}
                    {validationReport.fetch_error && (
                      <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 p-2 rounded">
                        <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span><strong>Fetch error:</strong> {validationReport.fetch_error}</span>
                      </div>
                    )}
                    {validationReport.save_error && (
                      <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 p-2 rounded">
                        <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span><strong>Save error:</strong> {validationReport.save_error}</span>
                      </div>
                    )}

                    {validationReport.events_saved === null && salesEvents.length > 0 && (
                      <Button
                        onClick={() => saveSalesRange(startDate, endDate)}
                        disabled={saving}
                        variant="secondary"
                        className="w-full"
                      >
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        <Database className="mr-2 h-4 w-4" /> Save to Database
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Activate */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Activate Sync</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Enable automated sales sync for this Numier connection.
            </p>

            {connectionId && (
              <ProviderReadinessPanel connectionId={connectionId} provider="numier" />
            )}

            {/* Capabilities summary */}
            <div className="rounded-md border border-border p-4 space-y-2">
              <h4 className="text-sm font-medium text-foreground">Capabilities</h4>
              {Object.entries(capabilities).map(([key, val]) => (
                <div key={key} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{key.replace(/_/g, " ")}</span>
                  <Badge variant={val ? "default" : "outline"} className="text-xs">
                    {val ? "✅ Verified" : "⬜ Not verified"}
                  </Badge>
                </div>
              ))}
            </div>

            <Button onClick={enableSync} className="w-full">
              Enable Automated Sync
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <Button onClick={() => setStep((s) => s + 1)} disabled={step >= steps.length - 1 || !canNext}>
          Next <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ── Small helper component for metric rows ──
function MetricRow({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${warn ? "text-amber-600 dark:text-amber-400 font-semibold" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

function ValidationRow({ label, value, ok, warn }: { label: string; value: number | string; ok?: boolean; warn?: boolean }) {
  const icon = ok === true ? "✅" : ok === false ? "❌" : warn ? "⚠️" : "";
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${warn ? "text-amber-600 dark:text-amber-400 font-semibold" : ok === false ? "text-destructive font-semibold" : "text-foreground"}`}>
        {icon} {value}
      </span>
    </div>
  );
}
