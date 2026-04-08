import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, Loader2, ArrowLeft, ArrowRight, MapPin, ShoppingCart, Info, Database, BarChart3 } from "lucide-react";
import { useNumierConnection } from "@/hooks/useNumierConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";
import NumierTpvDiagnostics from "@/components/NumierTpvDiagnostics";
import { useNavigate } from "react-router-dom";

const steps = [
  { label: "Connection", description: "Configure Numier API-KEY" },
  { label: "TPV Selection", description: "Choose your POS terminal" },
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
  } = useNumierConnection();

  const dateRangeValid = useMemo(() => {
    if (!startDate || !endDate) return false;
    return startDate <= endDate;
  }, [startDate, endDate]);

  const canFetchSales = !!activeTpvId && dateRangeValid && !loadingSales;

  const tpvSourceLabel = useMemo(() => {
    switch (tpvSource) {
      case "manual_override": return "🔧 manual override";
      case "selected": return "✅ explicitly selected";
      case "fallback_single": return "⚠ auto-selected (only 1 location)";
      default: return "❌ not set";
    }
  }, [tpvSource]);

  const canNext = useMemo(() => {
    switch (step) {
      case 0: return testStatus === "success";
      case 1: {
        if (manualTpvOverride.trim()) return true;
        if (selectedTpvId) return true;
        if (locations.length === 1) return true;
        return false;
      }
      case 2: return true;
      case 3: return true;
      default: return false;
    }
  }, [step, testStatus, selectedTpvId, locations.length, manualTpvOverride]);

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
                Se envía como header <code className="text-xs bg-muted px-1 rounded">API-KEY</code>. Solicítala desde tu panel de Numier.
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

      {/* Step 1: TPV Selection */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <MapPin className="h-5 w-5" /> Select TPV / Establishment
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Manual TPV Override */}
            <div className="rounded-md border border-dashed border-amber-500/50 bg-amber-500/5 p-4 space-y-2">
              <label className="text-sm font-medium text-foreground flex items-center gap-2">
                🔧 Manual TPV Override <Badge variant="outline" className="text-xs">Optional</Badge>
              </label>
              <Input
                placeholder="e.g. 6191"
                value={manualTpvOverride}
                onChange={(e) => setManualTpvOverride(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Si conoces el idTpv (ej. sandbox = <code className="bg-muted px-1 rounded">6191</code>), escríbelo aquí. Se usará en lugar de la selección automática.
              </p>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">o descubrir automáticamente</span>
              </div>
            </div>

            <p className="text-sm text-muted-foreground">
              Discover the establishments linked to your API-KEY, then select the one to sync sales from.
            </p>
            <Button onClick={fetchLocations} disabled={loadingLocations} variant="secondary">
              {loadingLocations && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Discover Establishments
            </Button>

            {locations.length > 0 && (
              <div className="space-y-2">
                {locations.map((loc) => {
                  const isSelected = selectedTpvId === loc.id && !manualTpvOverride.trim();
                  return (
                    <button
                      key={loc.id}
                      onClick={() => { setManualTpvOverride(""); selectTpv(loc.id); }}
                      className={`w-full flex items-center justify-between p-3 rounded-md border transition-colors text-left ${
                        isSelected
                          ? "border-primary bg-primary/10"
                          : "border-border bg-secondary/30 hover:bg-secondary/50"
                      }`}
                    >
                      <div>
                        <span className="font-medium text-foreground">{loc.name}</span>
                        {loc.address && <span className="text-xs text-muted-foreground ml-2">{loc.address}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">{loc.id}</Badge>
                        {isSelected && <CheckCircle2 className="h-4 w-4 text-primary" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Effective TPV summary */}
            <div className="flex items-start gap-2 text-sm bg-muted p-3 rounded-md">
              <Info className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">
                TPV efectivo: <strong className="text-foreground">{activeTpvId || "ninguno"}</strong>
                <span className="ml-1">({tpvSourceLabel})</span>
              </span>
            </div>

            {!loadingLocations && locations.length === 0 && !manualTpvOverride.trim() && (
              <p className="text-xs text-muted-foreground italic">No establishments found. Click Discover to fetch, or use the manual override above.</p>
            )}

            {locations.length > 1 && !selectedTpvId && !manualTpvOverride.trim() && (
              <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-500/10 p-3 rounded-md">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>Multiple locations found. Select one or use manual override.</span>
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
                <span className="text-muted-foreground">TPV</span>
                <span className="text-foreground font-medium">
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
                <span>No TPV configured. Go back to Step 2 and select or enter a TPV id.</span>
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
              diagnosing={diagnosing}
              diagnosisResult={diagnosisResult}
              onDiagnose={diagnoseTpv}
            />

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

            <Button
              onClick={() => fetchSalesRange(startDate, endDate)}
              disabled={!canFetchSales}
              className="w-full"
            >
              {loadingSales && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Fetch Sales ({startDate === endDate ? "1 day" : `${startDate} → ${endDate}`})
            </Button>

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

            {!loadingSales && salesEvents.length === 0 && (
              <p className="text-xs text-muted-foreground italic">No sales fetched yet. Configure dates and click Fetch.</p>
            )}
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
