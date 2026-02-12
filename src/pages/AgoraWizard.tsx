import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  XCircle,
  Search,
  Link2,
  Settings2,
  Map,
  Power,
  Wine,
  Calendar,
  Download,
  Filter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useAgoraConnection, SalesEvent, SalesLineItem, DetectedFamily } from "@/hooks/useAgoraConnection";

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Sync Settings", icon: Settings2 },
  { id: 3, label: "Sales & Mapping", icon: Map },
  { id: 4, label: "Go Live", icon: Power },
];

// ── Step 1: Connection ──
function StepConnection({
  locationName, setLocationName,
  baseUrl, setBaseUrl,
  apiToken, setApiToken,
  testStatus, testError,
  onTest,
}: {
  locationName: string; setLocationName: (v: string) => void;
  baseUrl: string; setBaseUrl: (v: string) => void;
  apiToken: string; setApiToken: (v: string) => void;
  testStatus: string; testError: string | null;
  onTest: () => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Connection Details</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter your Agora POS base URL, API token, and location name.
        </p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Location Name</label>
          <Input placeholder="e.g. La Vinoteca Central" value={locationName} onChange={(e) => setLocationName(e.target.value)} className="bg-background text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Base URL</label>
          <Input placeholder="http://192.168.1.100:8080" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="bg-background font-mono text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Api-Token</label>
          <Input type="password" placeholder="Enter your Agora API token" value={apiToken} onChange={(e) => setApiToken(e.target.value)} className="bg-background font-mono text-sm" />
        </div>
        <Button onClick={onTest} disabled={testStatus === "testing" || !baseUrl || !apiToken} variant="secondary" className="w-full">
          {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {testStatus === "success" && <CheckCircle2 className="mr-2 h-4 w-4 text-success" />}
          {testStatus === "error" && <XCircle className="mr-2 h-4 w-4 text-destructive" />}
          {testStatus === "idle" && "Test Connection"}
          {testStatus === "testing" && "Testing…"}
          {testStatus === "success" && "Connection Successful"}
          {testStatus === "error" && (testError || "Connection Failed")}
        </Button>
      </div>
    </div>
  );
}

// ── Step 2: Sync Settings ──
function StepSyncSettings({
  syncMode, setSyncMode,
  frequency, setFrequency,
  backfill, setBackfill,
}: {
  syncMode: string; setSyncMode: (v: "PULL_ONLY" | "BIDIRECTIONAL") => void;
  frequency: number; setFrequency: (v: number) => void;
  backfill: number; setBackfill: (v: number) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Sync Settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">Configure how and how often data is synced.</p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Sync Mode</label>
          <div className="grid grid-cols-2 gap-3">
            {(["PULL_ONLY", "BIDIRECTIONAL"] as const).map((mode) => (
              <button key={mode} onClick={() => setSyncMode(mode)} className={`rounded-lg border p-3 text-left transition-all ${syncMode === mode ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}>
                <span className="text-sm font-medium text-foreground">{mode === "PULL_ONLY" ? "Pull Only" : "Bidirectional"}</span>
                <p className="mt-0.5 text-xs text-muted-foreground">{mode === "PULL_ONLY" ? "Read sales data from Agora" : "Read sales + push wines to Agora"}</p>
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Sync Frequency</label>
          <div className="flex gap-2">
            {[5, 10, 15, 30, 60].map((f) => (
              <button key={f} onClick={() => setFrequency(f)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${frequency === f ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                {f} min
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Backfill Period</label>
          <div className="flex gap-2">
            {[7, 30, 90].map((d) => (
              <button key={d} onClick={() => setBackfill(d)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${backfill === d ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                Last {d} days
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Step 3: Sales & Mapping ──
function StepSalesMapping({
  daysWithSales, selectedDay, setSelectedDay, loadingDays,
  salesEvents, detectedFamilies, loadingSales,
  onFetchDay, onSaveSales,
  saving, saveResult,
  familyOverrides, setFamilyOverrides,
  searchMapping, setSearchMapping,
  showWineOnly, setShowWineOnly,
}: {
  daysWithSales: string[];
  selectedDay: string | null;
  setSelectedDay: (d: string) => void;
  loadingDays: boolean;
  salesEvents: SalesEvent[];
  detectedFamilies: DetectedFamily[];
  loadingSales: boolean;
  onFetchDay: (day: string) => void;
  onSaveSales: (day: string) => void;
  saving: boolean;
  saveResult: { savedEvents: number; savedLines: number } | null;
  familyOverrides: Record<string, boolean>;
  setFamilyOverrides: (v: Record<string, boolean>) => void;
  searchMapping: string;
  setSearchMapping: (v: string) => void;
  showWineOnly: boolean;
  setShowWineOnly: (v: boolean) => void;
}) {
  const allLines = useMemo(() => {
    const lines: (SalesLineItem & { docId: string })[] = [];
    for (const ev of salesEvents) {
      for (const l of ev.lines) {
        lines.push({ ...l, docId: ev.provider_doc_id });
      }
    }
    return lines;
  }, [salesEvents]);

  const filteredLines = useMemo(() => {
    let result = allLines;
    if (searchMapping) {
      const q = searchMapping.toLowerCase();
      result = result.filter((l) => l.name.toLowerCase().includes(q) || l.family.toLowerCase().includes(q));
    }
    if (showWineOnly) {
      result = result.filter((l) => {
        if (l.family in familyOverrides) return familyOverrides[l.family];
        return l.is_wine_candidate;
      });
    }
    return result;
  }, [allLines, searchMapping, showWineOnly, familyOverrides]);

  const totalAmount = salesEvents.reduce((s, e) => s + e.total_amount, 0);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Sales & Product Mapping</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select a business day (cash closure) to view sales and map products.
        </p>
      </div>

      {/* Day selector */}
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-2 block">
          <Calendar className="inline h-3.5 w-3.5 mr-1" />
          Business Day (cash closure)
        </label>
        {loadingDays ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Scanning for days with sales…
          </div>
        ) : daysWithSales.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No cash closures found in the last 30 days.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {daysWithSales.map((day) => (
              <button
                key={day}
                onClick={() => { setSelectedDay(day); onFetchDay(day); }}
                className={`rounded-lg border px-3 py-2 text-xs font-mono font-medium transition-all ${
                  selectedDay === day
                    ? "border-primary bg-primary/5 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/30"
                }`}
              >
                {day}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Sales summary */}
      {selectedDay && !loadingSales && salesEvents.length > 0 && (
        <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Business Day</span>
            <span className="font-mono font-medium text-foreground">{selectedDay}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Invoices</span>
            <span className="font-medium text-foreground">{salesEvents.length}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Line items</span>
            <span className="font-medium text-foreground">{allLines.length}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Total</span>
            <span className="font-medium text-foreground">€{totalAmount.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Wine candidates</span>
            <span className="font-medium text-success">{allLines.filter((l) => l.is_wine_candidate).length}</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="w-full mt-2"
            onClick={() => onSaveSales(selectedDay)}
            disabled={saving}
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            {saveResult ? `Saved ${saveResult.savedEvents} events, ${saveResult.savedLines} lines` : "Save to DB"}
          </Button>
        </div>
      )}

      {selectedDay && !loadingSales && salesEvents.length === 0 && (
        <div className="text-center py-8 text-sm text-muted-foreground rounded-lg border border-border bg-secondary/20">
          No hay datos porque no hubo cierre de caja ese día.
        </div>
      )}

      {loadingSales && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Loading sales…</span>
        </div>
      )}

      {/* Family detection */}
      {detectedFamilies.length > 0 && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">
            <Wine className="inline h-3.5 w-3.5 mr-1" />
            Detected Families — toggle wine/non-wine
          </label>
          <div className="flex flex-wrap gap-2">
            {detectedFamilies.map((f) => {
              const isWine = f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine;
              return (
                <button
                  key={f.name}
                  onClick={() => setFamilyOverrides({ ...familyOverrides, [f.name]: !isWine })}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                    isWine
                      ? "border-success/40 bg-success/10 text-success"
                      : "border-border bg-secondary/30 text-muted-foreground"
                  }`}
                >
                  {isWine ? <Wine className="inline h-3 w-3 mr-1" /> : null}
                  {f.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Filters */}
      {allLines.length > 0 && (
        <>
          <div className="flex gap-3 items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search products…" value={searchMapping} onChange={(e) => setSearchMapping(e.target.value)} className="pl-10 bg-background" />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <Switch checked={showWineOnly} onCheckedChange={setShowWineOnly} />
              <Filter className="h-3.5 w-3.5" />
              Wine only
            </label>
          </div>

          {/* Products table */}
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-80 overflow-y-auto">
            {filteredLines.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">No matching products.</div>
            ) : (
              filteredLines.map((l, i) => (
                <div key={`${l.docId}-${l.provider_product_id}-${i}`} className="flex items-center justify-between px-4 py-2.5 bg-card hover:bg-secondary/30 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`h-2 w-2 rounded-full shrink-0 ${l.is_wine_candidate ? "bg-success" : "bg-muted-foreground"}`} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{l.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {l.family && <span className="mr-2">{l.family}</span>}
                        {l.format && <span className="mr-2">· {l.format}</span>}
                        <span className="font-mono">×{l.quantity}</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-mono text-foreground">€{l.total_amount.toFixed(2)}</span>
                    {l.is_wine_candidate ? (
                      <Badge variant="default" className="text-[10px]"><Wine className="mr-1 h-3 w-3" />Wine</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">Non-wine</Badge>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Step 4: Go Live ──
function StepGoLive({
  syncMode, frequency, backfill,
  salesEvents, selectedDay,
  onEnable, enabled,
}: {
  syncMode: string;
  frequency: number;
  backfill: number;
  salesEvents: SalesEvent[];
  selectedDay: string | null;
  onEnable: () => void;
  enabled: boolean;
}) {
  const wineLines = salesEvents.flatMap((e) => e.lines).filter((l) => l.is_wine_candidate);
  return (
    <div className="space-y-6 text-center py-4">
      <div className="flex justify-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
          <Power className="h-8 w-8 text-primary" />
        </div>
      </div>
      <div>
        <h2 className="text-lg font-semibold text-foreground">Ready to Go Live</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
          Your Agora integration is configured. Enable sync to start pulling sales data every {frequency} minutes.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-secondary/30 p-4 text-left max-w-sm mx-auto space-y-2">
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Mode</span><span className="font-medium text-foreground">{syncMode === "PULL_ONLY" ? "Pull Only" : "Bidirectional"}</span></div>
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Frequency</span><span className="font-medium text-foreground">Every {frequency} min</span></div>
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Backfill</span><span className="font-medium text-foreground">Last {backfill} days</span></div>
        {selectedDay && <div className="flex justify-between text-xs"><span className="text-muted-foreground">Last business day</span><span className="font-medium font-mono text-foreground">{selectedDay}</span></div>}
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine candidates</span><span className="font-medium text-foreground">{wineLines.length}</span></div>
      </div>
      <Button size="lg" onClick={onEnable} className="shadow-glow">
        {enabled ? (<><CheckCircle2 className="mr-2 h-4 w-4" /> Sync Enabled — Redirecting…</>) : "Enable Sync"}
      </Button>
    </div>
  );
}

// ── Main Wizard ──
export default function AgoraWizard() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [locationName, setLocationName] = useState("");
  const [syncMode, setSyncMode] = useState<"PULL_ONLY" | "BIDIRECTIONAL">("PULL_ONLY");
  const [frequency, setFrequency] = useState(15);
  const [backfill, setBackfill] = useState(30);
  const [enabled, setEnabled] = useState(false);
  const [searchMapping, setSearchMapping] = useState("");
  const [showWineOnly, setShowWineOnly] = useState(false);
  const [familyOverrides, setFamilyOverrides] = useState<Record<string, boolean>>({});

  const {
    connectionId,
    testStatus, testError,
    testConnection, updateConnection,
    daysWithSales, selectedDay, setSelectedDay, loadingDays, findDaysWithSales,
    salesEvents, detectedFamilies, loadingSales, fetchSalesForDay,
    saving, saveResult, saveSalesToDb,
    enableSync, saveFamilyRules,
  } = useAgoraConnection();

  // When entering step 3, scan for business days
  useEffect(() => {
    if (currentStep === 3 && connectionId) {
      findDaysWithSales(backfill);
    }
  }, [currentStep, connectionId]);

  // Auto-fetch when selectedDay changes
  useEffect(() => {
    if (selectedDay && currentStep === 3) {
      fetchSalesForDay(selectedDay);
    }
  }, [selectedDay]);

  const handleNext = async () => {
    if (currentStep === 2 && connectionId) {
      await updateConnection(connectionId, {
        sync_mode: syncMode,
        sync_frequency_minutes: frequency,
        backfill_days: backfill,
        location_name: locationName || "New Location",
      });
    }
    if (currentStep === 3) {
      // Save family overrides
      const families = detectedFamilies.map((f) => ({
        name: f.name,
        isWine: f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine,
      }));
      if (families.length > 0) await saveFamilyRules(families);
    }
    setCurrentStep((s) => Math.min(4, s + 1));
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <button onClick={() => navigate("/integrations")} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Integrations
      </button>

      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-lg">A</div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connect Agora POS</h1>
          <p className="text-sm text-muted-foreground">Set up your Agora integration in a few steps.</p>
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {steps.map((step, i) => {
          const isActive = step.id === currentStep;
          const isDone = step.id < currentStep;
          return (
            <div key={step.id} className="flex items-center gap-2 flex-1">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-all ${isDone ? "bg-success text-success-foreground" : isActive ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>
                {isDone ? <CheckCircle2 className="h-4 w-4" /> : step.id}
              </div>
              <span className={`text-xs font-medium hidden sm:block ${isActive ? "text-foreground" : "text-muted-foreground"}`}>{step.label}</span>
              {i < steps.length - 1 && <div className={`h-px flex-1 ${isDone ? "bg-success" : "bg-border"}`} />}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <AnimatePresence mode="wait">
        <motion.div key={currentStep} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }} className="rounded-xl border border-border bg-card p-6 shadow-card">
          {currentStep === 1 && (
            <StepConnection
              locationName={locationName} setLocationName={setLocationName}
              baseUrl={baseUrl} setBaseUrl={setBaseUrl}
              apiToken={apiToken} setApiToken={setApiToken}
              testStatus={testStatus} testError={testError}
              onTest={() => testConnection(baseUrl, apiToken)}
            />
          )}
          {currentStep === 2 && (
            <StepSyncSettings
              syncMode={syncMode} setSyncMode={setSyncMode}
              frequency={frequency} setFrequency={setFrequency}
              backfill={backfill} setBackfill={setBackfill}
            />
          )}
          {currentStep === 3 && (
            <StepSalesMapping
              daysWithSales={daysWithSales} selectedDay={selectedDay} setSelectedDay={setSelectedDay} loadingDays={loadingDays}
              salesEvents={salesEvents} detectedFamilies={detectedFamilies} loadingSales={loadingSales}
              onFetchDay={fetchSalesForDay} onSaveSales={saveSalesToDb}
              saving={saving} saveResult={saveResult}
              familyOverrides={familyOverrides} setFamilyOverrides={setFamilyOverrides}
              searchMapping={searchMapping} setSearchMapping={setSearchMapping}
              showWineOnly={showWineOnly} setShowWineOnly={setShowWineOnly}
            />
          )}
          {currentStep === 4 && (
            <StepGoLive
              syncMode={syncMode} frequency={frequency} backfill={backfill}
              salesEvents={salesEvents} selectedDay={selectedDay}
              onEnable={async () => { await enableSync(); setEnabled(true); setTimeout(() => navigate("/sync-monitor"), 1000); }}
              enabled={enabled}
            />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setCurrentStep((s) => Math.max(1, s - 1))} disabled={currentStep === 1}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Previous
        </Button>
        {currentStep < 4 && (
          <Button onClick={handleNext}>Next <ArrowRight className="ml-2 h-4 w-4" /></Button>
        )}
      </div>
    </div>
  );
}
