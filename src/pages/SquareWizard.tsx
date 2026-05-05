import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle,
  Search, Link2, Settings2, Map, Power, Wine, Calendar,
  Download, Filter, Grape, ShieldCheck, ShieldX, HelpCircle, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useSquareConnection, SalesEvent, SalesLineItem, DetectedFamily } from "@/hooks/useSquareConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";

const ENVIRONMENTS = [
  { label: "Production", base: "https://connect.squareup.com/v2" },
  { label: "Sandbox", base: "https://connect.squareupsandbox.com/v2" },
];

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Sync Settings", icon: Settings2 },
  { id: 3, label: "Families", icon: Grape },
  { id: 4, label: "Sales & Mapping", icon: Map },
  { id: 5, label: "Go Live", icon: Power },
];

// ── Step 1: Connection ──
function StepConnection({
  locationName, setLocationName,
  environment, setEnvironment,
  accessToken, setAccessToken,
  winerimApiToken, setWinerimApiToken,
  testStatus, testError, merchantName, squareLocations,
  onTest,
}: {
  locationName: string; setLocationName: (v: string) => void;
  environment: string; setEnvironment: (v: string) => void;
  accessToken: string; setAccessToken: (v: string) => void;
  winerimApiToken: string; setWinerimApiToken: (v: string) => void;
  testStatus: string; testError: string | null; merchantName: string | null;
  squareLocations: { id: string; name: string }[];
  onTest: () => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Connection Details</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter your Square access token. Create an app at{" "}
          <a href="https://developer.squareup.com" target="_blank" rel="noreferrer" className="text-primary underline">developer.squareup.com</a>.
        </p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Location Name</label>
          <Input placeholder="e.g. Main Wine Bar" value={locationName} onChange={(e) => setLocationName(e.target.value)} className="bg-background text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Environment</label>
          <div className="grid grid-cols-2 gap-2">
            {ENVIRONMENTS.map((env) => (
              <button key={env.base} onClick={() => setEnvironment(env.base)}
                className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${environment === env.base ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                {env.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Access Token</label>
          <Input type="password" placeholder="sq0atp-..." value={accessToken} onChange={(e) => setAccessToken(e.target.value)} className="bg-background font-mono text-sm" />
          <p className="mt-1 text-[11px] text-muted-foreground">OAuth access token or sandbox token from Developer Console.</p>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Winerim API Token</label>
          <Input type="password" placeholder="Winerim API v2 token" value={winerimApiToken} onChange={(e) => setWinerimApiToken(e.target.value)} className="bg-background font-mono text-sm" />
        </div>
        <Button onClick={onTest} disabled={testStatus === "testing" || !accessToken} variant="secondary" className="w-full">
          {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {testStatus === "success" && <CheckCircle2 className="mr-2 h-4 w-4 text-success" />}
          {testStatus === "error" && <XCircle className="mr-2 h-4 w-4 text-destructive" />}
          {testStatus === "idle" && "Test Connection"}
          {testStatus === "testing" && "Testing…"}
          {testStatus === "success" && (merchantName ? `Connected: ${merchantName}` : "Connection successful")}
          {testStatus === "error" && (testError || "Connection failed")}
        </Button>
        {squareLocations.length > 0 && (
          <div className="rounded-lg border border-border bg-secondary/30 p-3">
            <p className="text-xs font-medium text-muted-foreground mb-1">Detected Locations ({squareLocations.length})</p>
            <div className="space-y-1">
              {squareLocations.map((loc) => (
                <div key={loc.id} className="text-xs text-foreground font-mono">{loc.name} <span className="text-muted-foreground">({loc.id})</span></div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Reuse step components pattern from CloverWizard (Steps 2-5 are identical structure)
// For brevity, inlining them

export default function SquareWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState(1);
  const [environment, setEnvironment] = useState(ENVIRONMENTS[0].base);
  const [accessToken, setAccessToken] = useState("");
  const [winerimApiToken, setWinerimApiToken] = useState("");
  const [locationName, setLocationName] = useState("");
  const [syncMode, setSyncMode] = useState<"PULL_ONLY" | "BIDIRECTIONAL">("PULL_ONLY");
  const [frequency, setFrequency] = useState(15);
  const [backfill, setBackfill] = useState(30);
  const [enabled, setEnabled] = useState(false);
  const [searchMapping, setSearchMapping] = useState("");
  const [showWineOnly, setShowWineOnly] = useState(true);
  const [familyOverrides, setFamilyOverrides] = useState<Record<string, boolean>>({});

  const {
    connectionId, testStatus, testError, merchantName, squareLocations,
    testConnection, updateConnection, loadConnection,
    daysWithSales, selectedDay, setSelectedDay, loadingDays, findDaysWithSales, scanStats,
    salesEvents, detectedFamilies, loadingSales, fetchSalesForDay,
    saving, saveResult, saveSalesToDb,
    enableSync, saveFamilyRules,
  } = useSquareConnection();

  useEffect(() => {
    const connParam = searchParams.get("connection");
    if (connParam && !connectionId) {
      loadConnection(connParam).then((conn) => {
        if (conn) {
          setLocationName(conn.location_name);
          setEnvironment(conn.base_url);
          setAccessToken(conn.api_token);
          setWinerimApiToken(conn.winerim_api_token || "");
          setSyncMode(conn.sync_mode as "PULL_ONLY" | "BIDIRECTIONAL");
          setFrequency(conn.sync_frequency_minutes);
          setBackfill(conn.backfill_days);
          setEnabled(conn.enabled);
          setCurrentStep(4);
        }
      });
    }
  }, [searchParams]);

  useEffect(() => {
    if ((currentStep === 3 || currentStep === 4) && connectionId && daysWithSales.length === 0 && !loadingDays) {
      findDaysWithSales(60);
    }
  }, [currentStep, connectionId]);

  useEffect(() => {
    if (selectedDay && (currentStep === 3 || currentStep === 4)) fetchSalesForDay(selectedDay);
  }, [selectedDay]);

  const handleNext = async () => {
    if (currentStep === 2 && connectionId) {
      await updateConnection(connectionId, {
        sync_mode: syncMode, sync_frequency_minutes: frequency,
        backfill_days: backfill, location_name: locationName || "New Location",
      });
    }
    if (currentStep === 3) {
      const families = detectedFamilies.map((f) => ({
        name: f.name, isWine: f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine,
      }));
      if (families.length > 0) await saveFamilyRules(families);
    }
    setCurrentStep((s) => Math.min(5, s + 1));
  };

  const canNext = () => {
    if (currentStep === 1) return testStatus === "success";
    return true;
  };

  // Family helpers
  const isFamilyWine = (familyName: string) => {
    if (familyName in familyOverrides) return familyOverrides[familyName];
    const detected = detectedFamilies.find((f) => f.name === familyName);
    return detected?.suggestedWine ?? false;
  };

  const allLines = useMemo(() => {
    const lines: (SalesLineItem & { docId: string; familyIsWine: boolean })[] = [];
    for (const ev of salesEvents) {
      for (const l of ev.lines) lines.push({ ...l, docId: ev.provider_doc_id, familyIsWine: isFamilyWine(l.family) });
    }
    return lines;
  }, [salesEvents, familyOverrides, detectedFamilies]);

  const filteredLines = useMemo(() => {
    let result = allLines;
    if (searchMapping) { const q = searchMapping.toLowerCase(); result = result.filter((l) => l.name.toLowerCase().includes(q) || l.family.toLowerCase().includes(q)); }
    if (showWineOnly) result = result.filter((l) => l.familyIsWine || l.is_wine_candidate);
    return result;
  }, [allLines, searchMapping, showWineOnly]);

  const sortedFamilies = useMemo(() => {
    return [...detectedFamilies].sort((a, b) => {
      const aWine = a.name in familyOverrides ? familyOverrides[a.name] : a.suggestedWine;
      const bWine = b.name in familyOverrides ? familyOverrides[b.name] : b.suggestedWine;
      if (aWine !== bWine) return aWine ? -1 : 1;
      return b.itemCount - a.itemCount;
    });
  }, [detectedFamilies, familyOverrides]);

  const [expandedFamily, setExpandedFamily] = useState<string | null>(null);

  const familyProducts = useMemo(() => {
    const map: Record<string, { name: string; format: string; unitPrice: number; quantity: number }[]> = {};
    for (const ev of salesEvents) {
      for (const line of ev.lines) {
        const fam = line.family || "Uncategorized";
        if (!map[fam]) map[fam] = [];
        const existing = map[fam].find((p) => p.name === line.name);
        if (existing) existing.quantity += line.quantity;
        else map[fam].push({ name: line.name, format: line.format, unitPrice: line.unit_price, quantity: line.quantity });
      }
    }
    return map;
  }, [salesEvents]);

  const wineCount = sortedFamilies.filter((f) => f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine).length;
  const totalAmount = salesEvents.reduce((s, e) => s + e.total_amount, 0);
  const wineLines = allLines.filter((l) => l.familyIsWine || l.is_wine_candidate);
  const wineFamilyCount = wineCount;

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <button onClick={() => navigate("/integrations")} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Integrations
      </button>

      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-lg">S</div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connect Square POS</h1>
          <p className="text-sm text-muted-foreground">Set up Square integration with OAuth tokens.</p>
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

      <AnimatePresence mode="wait">
        <motion.div key={currentStep} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }} className="rounded-xl border border-border bg-card p-6 shadow-card">

          {/* Step 1 */}
          {currentStep === 1 && (
            <StepConnection
              locationName={locationName} setLocationName={setLocationName}
              environment={environment} setEnvironment={setEnvironment}
              accessToken={accessToken} setAccessToken={setAccessToken}
              winerimApiToken={winerimApiToken} setWinerimApiToken={setWinerimApiToken}
              testStatus={testStatus} testError={testError} merchantName={merchantName}
              squareLocations={squareLocations} onTest={() => testConnection(environment, accessToken, winerimApiToken)}
            />
          )}

          {/* Step 2: Sync Settings */}
          {currentStep === 2 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Sync Settings</h2>
                <p className="mt-1 text-sm text-muted-foreground">Configure sync mode and frequency.</p>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">Sync Mode</label>
                  <div className="grid grid-cols-2 gap-3">
                    {(["PULL_ONLY", "BIDIRECTIONAL"] as const).map((mode) => (
                      <button key={mode} onClick={() => setSyncMode(mode)} className={`rounded-lg border p-3 text-left transition-all ${syncMode === mode ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}>
                        <span className="text-sm font-medium text-foreground">{mode === "PULL_ONLY" ? "Pull Only" : "Bidirectional"}</span>
                        <p className="mt-0.5 text-xs text-muted-foreground">{mode === "PULL_ONLY" ? "Read orders from Square" : "Read orders + sync inventory"}</p>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">Sync Frequency</label>
                  <div className="flex gap-2">
                    {[5, 10, 15, 30, 60].map((f) => (
                      <button key={f} onClick={() => setFrequency(f)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${frequency === f ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>{f} min</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">Backfill Period</label>
                  <div className="flex gap-2">
                    {[7, 30, 90].map((d) => (
                      <button key={d} onClick={() => setBackfill(d)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${backfill === d ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>Last {d} days</button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">Square supports up to 90 days of historical orders.</p>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Families */}
          {currentStep === 3 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Wine Family Classification</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {loadingDays || loadingSales ? "Scanning sales data…" : detectedFamilies.length > 0
                    ? <>Detected <span className="font-medium text-foreground">{detectedFamilies.length}</span> product families.</>
                    : "No product families detected."}
                </p>
              </div>
              {(loadingDays || loadingSales) && (
                <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /><span className="ml-2 text-sm text-muted-foreground">Scanning…</span></div>
              )}
              {!loadingDays && !loadingSales && scanStats && (
                <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Scan Results</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <span className="text-muted-foreground">Days scanned</span><span className="font-mono text-foreground">{scanStats.totalScanned}</span>
                    <span className="text-muted-foreground">Days with sales</span><span className="font-mono text-foreground">{daysWithSales.length}</span>
                    <span className="text-muted-foreground">Total orders</span><span className="font-mono text-foreground">{scanStats.totalInvoicesFound}</span>
                  </div>
                </div>
              )}
              {!loadingDays && !loadingSales && sortedFamilies.length > 0 && (
                <>
                  <div className="flex gap-4 text-xs">
                    <div className="flex items-center gap-1.5"><div className="h-2.5 w-2.5 rounded-full bg-success" /><span className="text-muted-foreground"><span className="font-medium text-foreground">{wineCount}</span> wine</span></div>
                    <div className="flex items-center gap-1.5"><div className="h-2.5 w-2.5 rounded-full bg-muted-foreground" /><span className="text-muted-foreground"><span className="font-medium text-foreground">{sortedFamilies.length - wineCount}</span> non-wine</span></div>
                  </div>
                  <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-96 overflow-y-auto">
                    {sortedFamilies.map((f) => {
                      const isWine = f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine;
                      return (
                        <div key={f.name} className={`flex items-center justify-between px-4 py-3 transition-colors ${isWine ? "bg-success/5" : "bg-card"}`}>
                          <div className="flex items-center gap-3 min-w-0">
                            <Switch checked={isWine} onCheckedChange={(v) => setFamilyOverrides({ ...familyOverrides, [f.name]: v })} />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">{f.name}</p>
                              <span className="text-[11px] text-muted-foreground capitalize">{f.confidence} · {f.itemCount} items</span>
                            </div>
                          </div>
                          {isWine ? <Badge variant="default" className="text-[10px]"><Wine className="mr-1 h-3 w-3" />Wine</Badge> : <Badge variant="secondary" className="text-[10px]">Non-wine</Badge>}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 4: Sales & Mapping */}
          {currentStep === 4 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Sales & Product Mapping</h2>
                <p className="mt-1 text-sm text-muted-foreground">Review sales data and wine classification.</p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-2 block"><Calendar className="inline h-3.5 w-3.5 mr-1" />Business Day</label>
                {loadingDays ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 className="h-4 w-4 animate-spin" /> Searching…</div>
                ) : daysWithSales.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">No orders found.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {daysWithSales.map((day) => (
                      <button key={day} onClick={() => { setSelectedDay(day); fetchSalesForDay(day); }}
                        className={`rounded-lg border px-3 py-2 text-xs font-mono font-medium transition-all ${selectedDay === day ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>{day}</button>
                    ))}
                  </div>
                )}
              </div>
              {selectedDay && !loadingSales && salesEvents.length > 0 && (
                <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Orders</span><span className="font-medium text-foreground">{salesEvents.length}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Total</span><span className="font-medium text-foreground">${totalAmount.toFixed(2)}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine candidates</span><span className="font-medium text-success">{wineLines.length}</span></div>
                  <Button size="sm" variant="secondary" className="w-full mt-2" onClick={() => saveSalesToDb(selectedDay)} disabled={saving}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                    {saveResult ? `Saved ${saveResult.savedEvents} events, ${saveResult.savedLines} lines` : "Save to DB"}
                  </Button>
                </div>
              )}
              {loadingSales && <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /><span className="ml-2 text-sm text-muted-foreground">Loading…</span></div>}
              {allLines.length > 0 && (
                <>
                  <div className="flex gap-3 items-center">
                    <div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input placeholder="Search…" value={searchMapping} onChange={(e) => setSearchMapping(e.target.value)} className="pl-10 bg-background" /></div>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer whitespace-nowrap"><Switch checked={showWineOnly} onCheckedChange={setShowWineOnly} /><Filter className="h-3.5 w-3.5" />Wine only</label>
                  </div>
                  <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-80 overflow-y-auto">
                    {filteredLines.length === 0 ? <div className="text-center py-8 text-sm text-muted-foreground">No products found.</div> :
                      filteredLines.map((l, i) => {
                        const isWine = l.familyIsWine || l.is_wine_candidate;
                        return (
                          <div key={`${l.docId}-${i}`} className="flex items-center justify-between px-4 py-2.5 bg-card hover:bg-secondary/30 transition-colors">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className={`h-2 w-2 rounded-full shrink-0 ${isWine ? "bg-success" : "bg-muted-foreground"}`} />
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-foreground truncate">{l.name}</p>
                                <p className="text-[11px] text-muted-foreground">{l.family && <span className="mr-2">{l.family}</span>}<span className="font-mono">×{l.quantity}</span><span className="ml-2 font-mono">@${l.unit_price.toFixed(2)}</span></p>
                              </div>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              <span className="text-xs font-mono text-foreground">${l.total_amount.toFixed(2)}</span>
                              {isWine ? <Badge variant="default" className="text-[10px]"><Wine className="mr-1 h-3 w-3" />Wine</Badge> : <Badge variant="secondary" className="text-[10px]">Non-wine</Badge>}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 5: Go Live */}
          {currentStep === 5 && (
            <div className="space-y-6 text-center py-4">
              <div className="flex justify-center"><div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10"><Power className="h-8 w-8 text-primary" /></div></div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Ready to Go Live</h2>
                <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">Square integration configured. Enable sync to import orders every {frequency} minutes.</p>
              </div>
              {connectionId && <ConnectionHealthPanel connectionId={connectionId} />}
              <ProviderReadinessPanel connectionId={connectionId} provider="square" />
              <div className="rounded-lg border border-border bg-secondary/30 p-4 text-left max-w-sm mx-auto space-y-2">
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Mode</span><span className="font-medium text-foreground">{syncMode === "PULL_ONLY" ? "Pull Only" : "Bidirectional"}</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Frequency</span><span className="font-medium text-foreground">Every {frequency} min</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Backfill</span><span className="font-medium text-foreground">Last {backfill} days</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine families</span><span className="font-medium text-foreground">{wineFamilyCount}</span></div>
              </div>
              <Button size="lg" onClick={async () => { await enableSync(); setEnabled(true); setTimeout(() => navigate("/integrations"), 1500); }} className="shadow-glow">
                {enabled ? <><CheckCircle2 className="mr-2 h-4 w-4" /> Sync Enabled — Redirecting…</> : "Enable Sync"}
              </Button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Navigation */}
      {currentStep < 5 && (
        <div className="flex justify-between">
          <Button variant="ghost" onClick={() => setCurrentStep((s) => Math.max(1, s - 1))} disabled={currentStep === 1}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Back
          </Button>
          <Button onClick={handleNext} disabled={!canNext()}>
            Next <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
