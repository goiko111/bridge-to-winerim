import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle,
  Search, Link2, Settings2, Map, Power, Wine, Calendar,
  Download, Filter, Grape, ShieldCheck, BookOpen, FlaskConical,
  AlertTriangle, Eye, FileJson, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  useSimphonyConnection,
  SalesLineItem,
  PreflightCheck,
  CatalogWritePreview,
  PilotStep,
} from "@/hooks/useSimphonyConnection";

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Preflight", icon: ShieldCheck },
  { id: 3, label: "Sync Settings", icon: Settings2 },
  { id: 4, label: "Families", icon: Grape },
  { id: 5, label: "Sales & Mapping", icon: Map },
  { id: 6, label: "Catalog", icon: BookOpen },
  { id: 7, label: "Pilot", icon: FlaskConical },
  { id: 8, label: "Go Live", icon: Power },
];

export default function SimphonyWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState(1);

  // Connection fields (S1)
  const [hostUrl, setHostUrl] = useState("");
  const [orgShortName, setOrgShortName] = useState("");
  const [locRef, setLocRef] = useState("");
  const [rvcRef, setRvcRef] = useState("");
  const [idToken, setIdToken] = useState("");
  const [winerimApiToken, setWinerimApiToken] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [oidcBaseUrl, setOidcBaseUrl] = useState("");
  const [ccBaseUrl, setCcBaseUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const [syncMode, setSyncMode] = useState<"PULL_ONLY" | "BIDIRECTIONAL">("PULL_ONLY");
  const [frequency, setFrequency] = useState(15);
  const [backfill, setBackfill] = useState(30);
  const [enabled, setEnabled] = useState(false);
  const [searchMapping, setSearchMapping] = useState("");
  const [showWineOnly, setShowWineOnly] = useState(true);
  const [familyOverrides, setFamilyOverrides] = useState<Record<string, boolean>>({});
  const [catalogDryRun, setCatalogDryRun] = useState(true);

  const locationName = `${locationLabel}|${orgShortName}|${locRef}|${rvcRef}`;

  const {
    connectionId, testStatus, testError, merchantName,
    testConnection, updateConnection, loadConnection,
    daysWithSales, selectedDay, setSelectedDay, loadingDays, findDaysWithSales, scanStats,
    salesEvents, detectedFamilies, loadingSales, fetchSalesForDay,
    saving, saveResult, saveSalesToDb,
    enableSync, saveFamilyRules,
    preflightChecks, preflightRunning, runPreflight,
    catalogItems, catalogLoading, fetchCatalog,
    catalogWritePreview, previewCatalogWrite,
    catalogWriteResult, catalogWriting, executeCatalogWrite,
    generateImportExport,
    pilotSteps, pilotRunning, runPilot,
  } = useSimphonyConnection();

  useEffect(() => {
    const connParam = searchParams.get("connection");
    if (connParam && !connectionId) {
      loadConnection(connParam).then((conn) => {
        if (conn) {
          const parts = (conn.location_name || "").split("|");
          setLocationLabel(parts[0] || "");
          setOrgShortName(parts[1] || "");
          setLocRef(parts[2] || "");
          setRvcRef(parts[3] || "");
          setHostUrl(conn.base_url);
          setIdToken(conn.api_token);
          setWinerimApiToken(conn.winerim_api_token || "");
          setSyncMode(conn.sync_mode as "PULL_ONLY" | "BIDIRECTIONAL");
          setFrequency(conn.sync_frequency_minutes);
          setBackfill(conn.backfill_days);
          setEnabled(conn.enabled);
          const cfg = conn.provider_config as Record<string, string> | null;
          if (cfg) {
            setOidcBaseUrl(cfg.oidc_base_url || "");
            setCcBaseUrl(cfg.cc_base_url || "");
            setClientId(cfg.client_id || "");
            setClientSecret(cfg.client_secret || "");
          }
          setCurrentStep(5);
        }
      });
    }
  }, [searchParams]);

  useEffect(() => {
    if (currentStep === 2 && connectionId && preflightChecks.length === 0 && !preflightRunning) runPreflight();
  }, [currentStep, connectionId]);

  useEffect(() => {
    if ((currentStep === 4 || currentStep === 5) && connectionId && daysWithSales.length === 0 && !loadingDays) findDaysWithSales(60);
  }, [currentStep, connectionId]);

  useEffect(() => {
    if (selectedDay && (currentStep === 4 || currentStep === 5)) fetchSalesForDay(selectedDay);
  }, [selectedDay]);

  const handleNext = async () => {
    if (currentStep === 3 && connectionId) {
      await updateConnection(connectionId, {
        sync_mode: syncMode, sync_frequency_minutes: frequency,
        backfill_days: backfill, location_name: locationName,
      });
    }
    if (currentStep === 4) {
      const families = detectedFamilies.map((f) => ({
        name: f.name, isWine: f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine,
      }));
      if (families.length > 0) await saveFamilyRules(families);
    }
    setCurrentStep((s) => Math.min(8, s + 1));
  };

  const canNext = () => {
    if (currentStep === 1) return testStatus === "success";
    return true;
  };

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

  const wineCount = sortedFamilies.filter((f) => f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine).length;
  const totalAmount = salesEvents.reduce((s, e) => s + e.total_amount, 0);
  const wineLines = allLines.filter((l) => l.familyIsWine || l.is_wine_candidate);

  const preflightIcon = (status: string) => {
    if (status === "pass") return <CheckCircle2 className="h-4 w-4 text-success" />;
    if (status === "fail") return <XCircle className="h-4 w-4 text-destructive" />;
    if (status === "warn") return <AlertTriangle className="h-4 w-4 text-warning" />;
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  };

  const pilotIcon = (status: string) => {
    if (status === "done") return <CheckCircle2 className="h-4 w-4 text-success" />;
    if (status === "error") return <XCircle className="h-4 w-4 text-destructive" />;
    if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    return <div className="h-4 w-4 rounded-full border-2 border-border" />;
  };

  const preflightAllPass = preflightChecks.length > 0 && preflightChecks.filter((c) => c.id !== "cc").every((c) => c.status === "pass");

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <button onClick={() => navigate("/integrations")} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Integrations
      </button>

      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-lg">O</div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connect Oracle MICROS Simphony</h1>
          <p className="text-sm text-muted-foreground">STS Gen2 + OIDC + Config&Content + BI integration.</p>
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1">
        {steps.map((step, i) => {
          const isActive = step.id === currentStep;
          const isDone = step.id < currentStep;
          return (
            <div key={step.id} className="flex items-center gap-1 flex-1">
              <div className={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold transition-all ${isDone ? "bg-success text-success-foreground" : isActive ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>
                {isDone ? <CheckCircle2 className="h-3.5 w-3.5" /> : step.id}
              </div>
              <span className={`text-[10px] font-medium hidden lg:block ${isActive ? "text-foreground" : "text-muted-foreground"}`}>{step.label}</span>
              {i < steps.length - 1 && <div className={`h-px flex-1 ${isDone ? "bg-success" : "bg-border"}`} />}
            </div>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={currentStep} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }} className="rounded-xl border border-border bg-card p-6 shadow-card">

          {/* ── Step 1: Connection (S1) ── */}
          {currentStep === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Connection Details</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Enter Simphony credentials. Create API accounts in Reporting & Analytics → Administration → API Accounts.
                </p>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Location Label</label>
                  <Input placeholder="e.g. Rome Flagship" value={locationLabel} onChange={(e) => setLocationLabel(e.target.value)} className="bg-background text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Simphony Host URL (STS Gen2)</label>
                  <Input placeholder="https://myorg.oracleindustry.com" value={hostUrl} onChange={(e) => setHostUrl(e.target.value)} className="bg-background font-mono text-sm" />
                  <p className="mt-1 text-[11px] text-muted-foreground">EMC → Enterprise Parameters → Applications → STS Gen2 Services URL</p>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Org Short Name</label>
                    <Input placeholder="myorg" value={orgShortName} onChange={(e) => setOrgShortName(e.target.value)} className="bg-background font-mono text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Location Ref</label>
                    <Input placeholder="LOC001" value={locRef} onChange={(e) => setLocRef(e.target.value)} className="bg-background font-mono text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">RVC Ref</label>
                    <Input placeholder="RVC001" value={rvcRef} onChange={(e) => setRvcRef(e.target.value)} className="bg-background font-mono text-sm" />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">OIDC Base URL (OpenID Connect)</label>
                  <Input placeholder="https://login.oracleindustry.com" value={oidcBaseUrl} onChange={(e) => setOidcBaseUrl(e.target.value)} className="bg-background font-mono text-sm" />
                  <p className="mt-1 text-[11px] text-muted-foreground">EMC → Enterprise Parameters → Applications → OpenID Connect Provider URL</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Client ID</label>
                    <Input placeholder="API Account Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} className="bg-background font-mono text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Client Secret</label>
                    <Input type="password" placeholder="API Account Secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className="bg-background font-mono text-sm" />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">ID Token (Bearer)</label>
                  <Input type="password" placeholder="OIDC id_token" value={idToken} onChange={(e) => setIdToken(e.target.value)} className="bg-background font-mono text-sm" />
                  <p className="mt-1 text-[11px] text-muted-foreground">Obtained via OIDC PKCE flow. Valid ~14 days; refresh before expiry.</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Config & Content API URL <Badge variant="secondary" className="text-[9px] ml-1">Optional</Badge></label>
                  <Input placeholder="https://myorg-cc.oracleindustry.com" value={ccBaseUrl} onChange={(e) => setCcBaseUrl(e.target.value)} className="bg-background font-mono text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Winerim API Token</label>
                  <Input type="password" placeholder="Winerim API v2 token" value={winerimApiToken} onChange={(e) => setWinerimApiToken(e.target.value)} className="bg-background font-mono text-sm" />
                </div>
                <Button onClick={() => testConnection(hostUrl, idToken, locationName, winerimApiToken, oidcBaseUrl, ccBaseUrl, clientId, clientSecret)} disabled={testStatus === "testing" || !hostUrl || !idToken || !orgShortName || !locRef || !rvcRef} variant="secondary" className="w-full">
                  {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {testStatus === "success" && <CheckCircle2 className="mr-2 h-4 w-4 text-success" />}
                  {testStatus === "error" && <XCircle className="mr-2 h-4 w-4 text-destructive" />}
                  {testStatus === "idle" && "Test Connection"}
                  {testStatus === "testing" && "Testing…"}
                  {testStatus === "success" && (merchantName ? `Connected: ${merchantName}` : "Connection successful")}
                  {testStatus === "error" && (testError || "Connection failed")}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 2: Preflight (S3) ── */}
          {currentStep === 2 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Preflight Checks</h2>
                <p className="mt-1 text-sm text-muted-foreground">Verifying STS Gen2 activation, OIDC token, and optional C&C API access.</p>
              </div>
              {preflightRunning && (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">Running checks…</span>
                </div>
              )}
              {!preflightRunning && preflightChecks.length > 0 && (
                <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
                  {preflightChecks.map((check) => (
                    <div key={check.id} className={`flex items-start gap-3 px-4 py-3 ${check.status === "pass" ? "bg-success/5" : check.status === "fail" ? "bg-destructive/5" : "bg-card"}`}>
                      {preflightIcon(check.status)}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">{check.label}</p>
                        {check.detail && <p className="text-[11px] text-muted-foreground mt-0.5">{check.detail}</p>}
                      </div>
                      <Badge variant={check.status === "pass" ? "default" : check.status === "fail" ? "destructive" : "secondary"} className="text-[10px] shrink-0">{check.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
              {!preflightRunning && !preflightAllPass && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
                  <AlertTriangle className="inline h-3.5 w-3.5 mr-1" />
                  Some checks failed. You can continue setup but "Go Live" may be blocked. Fix issues and re-run.
                </div>
              )}
              {!preflightRunning && (
                <Button variant="outline" size="sm" onClick={runPreflight}>Re-run Preflight</Button>
              )}
            </div>
          )}

          {/* ── Step 3: Sync Settings ── */}
          {currentStep === 3 && (
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
                        <p className="mt-0.5 text-xs text-muted-foreground">{mode === "PULL_ONLY" ? "Read checks via STS Gen2" : "Read checks + CCAPI catalog sync"}</p>
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
                </div>
              </div>
            </div>
          )}

          {/* ── Step 4: Families ── */}
          {currentStep === 4 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Wine Family Classification</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {loadingDays || loadingSales ? "Scanning checks…" : detectedFamilies.length > 0
                    ? <>Detected <span className="font-medium text-foreground">{detectedFamilies.length}</span> families.</>
                    : "No families detected."}
                </p>
              </div>
              {(loadingDays || loadingSales) && <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /><span className="ml-2 text-sm text-muted-foreground">Scanning…</span></div>}
              {!loadingDays && !loadingSales && scanStats && (
                <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <span className="text-muted-foreground">Days scanned</span><span className="font-mono text-foreground">{scanStats.totalScanned}</span>
                    <span className="text-muted-foreground">Days with checks</span><span className="font-mono text-foreground">{daysWithSales.length}</span>
                    <span className="text-muted-foreground">Total checks</span><span className="font-mono text-foreground">{scanStats.totalInvoicesFound}</span>
                  </div>
                </div>
              )}
              {!loadingDays && !loadingSales && sortedFamilies.length > 0 && (
                <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-96 overflow-y-auto">
                  {sortedFamilies.map((f) => {
                    const isWine = f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine;
                    return (
                      <div key={f.name} className={`flex items-center justify-between px-4 py-3 ${isWine ? "bg-success/5" : "bg-card"}`}>
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
              )}
            </div>
          )}

          {/* ── Step 5: Sales & Mapping (S4 BI sales) ── */}
          {currentStep === 5 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Sales & Product Mapping</h2>
                <p className="mt-1 text-sm text-muted-foreground">Review checks fetched via STS Gen2 / BI API.</p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-2 block"><Calendar className="inline h-3.5 w-3.5 mr-1" />Business Day</label>
                {loadingDays ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 className="h-4 w-4 animate-spin" /> Searching…</div>
                ) : daysWithSales.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">No checks found.</p>
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
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Checks</span><span className="font-medium text-foreground">{salesEvents.length}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Total</span><span className="font-medium text-foreground">${totalAmount.toFixed(2)}</span></div>
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine candidates</span><span className="font-medium text-success">{wineLines.length}</span></div>
                  <Button size="sm" variant="secondary" className="w-full mt-2" onClick={() => saveSalesToDb(selectedDay)} disabled={saving}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                    {saveResult ? `Saved ${saveResult.savedEvents} events, ${saveResult.savedLines} lines` : "Save to DB"}
                  </Button>
                </div>
              )}
              {loadingSales && <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
              {allLines.length > 0 && (
                <>
                  <div className="flex gap-3 items-center">
                    <div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input placeholder="Search…" value={searchMapping} onChange={(e) => setSearchMapping(e.target.value)} className="pl-10 bg-background" /></div>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer whitespace-nowrap"><Switch checked={showWineOnly} onCheckedChange={setShowWineOnly} /><Filter className="h-3.5 w-3.5" />Wine only</label>
                  </div>
                  <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-80 overflow-y-auto">
                    {filteredLines.length === 0 ? <div className="text-center py-8 text-sm text-muted-foreground">No items found.</div> :
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

          {/* ── Step 6: Catalog (S5 C&C + S6 Import/Export) ── */}
          {currentStep === 6 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Catalog & Write</h2>
                <p className="mt-1 text-sm text-muted-foreground">Read menu items via Config & Content API and optionally push Winerim wines.</p>
              </div>

              {/* Read catalog */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-foreground">Menu Items (C&C API)</h3>
                  <Button size="sm" variant="outline" onClick={fetchCatalog} disabled={catalogLoading}>
                    {catalogLoading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <BookOpen className="mr-2 h-3.5 w-3.5" />}
                    Fetch Catalog
                  </Button>
                </div>
                {catalogItems.length > 0 && (
                  <div className="rounded-lg border border-border overflow-hidden max-h-48 overflow-y-auto divide-y divide-border">
                    {catalogItems.map((item) => (
                      <div key={item.menuItemId} className="flex items-center justify-between px-4 py-2 bg-card text-xs">
                        <div>
                          <span className="font-medium text-foreground">{item.name}</span>
                          <span className="text-muted-foreground ml-2">{item.familyGroup}</span>
                        </div>
                        <span className="font-mono text-foreground">${item.price.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Write preview */}
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-foreground">Push Wines to Simphony</h3>
                  <Button size="sm" variant="outline" onClick={previewCatalogWrite}>
                    <Eye className="mr-2 h-3.5 w-3.5" /> Preview Changes
                  </Button>
                </div>
                {catalogWritePreview.length > 0 && (
                  <>
                    <div className="rounded-lg border border-border overflow-hidden max-h-48 overflow-y-auto divide-y divide-border">
                      {catalogWritePreview.map((p, i) => (
                        <div key={i} className="flex items-center justify-between px-4 py-2 bg-card text-xs">
                          <div className="flex items-center gap-2">
                            <Badge variant={p.action === "create" ? "default" : "secondary"} className="text-[9px]">{p.action}</Badge>
                            <span className="font-medium text-foreground">{p.menuItemName}</span>
                          </div>
                          <span className="font-mono text-foreground">${p.price.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch checked={catalogDryRun} onCheckedChange={setCatalogDryRun} />
                        Dry-run mode
                      </label>
                      <Button size="sm" onClick={() => executeCatalogWrite(catalogDryRun)} disabled={catalogWriting}>
                        {catalogWriting ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-2 h-3.5 w-3.5" />}
                        {catalogDryRun ? "Simulate Write" : "Execute Write"}
                      </Button>
                    </div>
                    {catalogWriteResult && (
                      <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs text-success">
                        <CheckCircle2 className="inline h-3.5 w-3.5 mr-1" />
                        {catalogDryRun ? `Dry-run: ${catalogWriteResult.created} items would be written` : `${catalogWriteResult.created} tasks enqueued for approval`}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Import/Export fallback (S6) */}
              <div className="space-y-3 border-t border-border pt-4">
                <h3 className="text-sm font-medium text-foreground">Bulk Import/Export <Badge variant="secondary" className="text-[9px] ml-1">Plan B</Badge></h3>
                <p className="text-[11px] text-muted-foreground">Generate a file for Simphony's Import/Export web service if C&C write is unavailable.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={async () => {
                    const result = await generateImportExport("json");
                    if (result?.content) {
                      const blob = new Blob([result.content], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a"); a.href = url; a.download = result.fileName; a.click();
                      URL.revokeObjectURL(url);
                    }
                  }}>
                    <FileJson className="mr-2 h-3.5 w-3.5" /> Download JSON
                  </Button>
                  <Button size="sm" variant="outline" onClick={async () => {
                    const result = await generateImportExport("csv");
                    if (result?.content) {
                      const blob = new Blob([result.content], { type: "text/csv" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a"); a.href = url; a.download = result.fileName; a.click();
                      URL.revokeObjectURL(url);
                    }
                  }}>
                    <Download className="mr-2 h-3.5 w-3.5" /> Download CSV
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 7: Pilot (S7) ── */}
          {currentStep === 7 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Minimal Pilot (1 Location)</h2>
                <p className="mt-1 text-sm text-muted-foreground">Verify the full loop: connect → push test item → ring test sales → verify BOT/COPA.</p>
              </div>
              {!pilotRunning && pilotSteps.length === 0 && (
                <Button onClick={runPilot} variant="secondary" className="w-full">
                  <FlaskConical className="mr-2 h-4 w-4" /> Start Pilot
                </Button>
              )}
              {pilotRunning && (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">Running pilot…</span>
                </div>
              )}
              {!pilotRunning && pilotSteps.length > 0 && (
                <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
                  {pilotSteps.map((step) => (
                    <div key={step.id} className={`flex items-start gap-3 px-4 py-3 ${step.status === "done" ? "bg-success/5" : step.status === "error" ? "bg-destructive/5" : "bg-card"}`}>
                      {pilotIcon(step.status)}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">{step.label}</p>
                        {step.detail && <p className="text-[11px] text-muted-foreground mt-0.5">{step.detail}</p>}
                      </div>
                      <Badge variant={step.status === "done" ? "default" : step.status === "error" ? "destructive" : "secondary"} className="text-[10px] shrink-0">{step.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
              {!pilotRunning && pilotSteps.length > 0 && (
                <Button variant="outline" size="sm" onClick={runPilot}>Re-run Pilot</Button>
              )}
            </div>
          )}

          {/* ── Step 8: Go Live ── */}
          {currentStep === 8 && (
            <div className="space-y-6 text-center py-4">
              <div className="flex justify-center"><div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10"><Power className="h-8 w-8 text-primary" /></div></div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Ready to Go Live</h2>
                <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">Simphony integration fully configured with STS Gen2 + OIDC.</p>
              </div>
              {!preflightAllPass && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning max-w-sm mx-auto">
                  <AlertTriangle className="inline h-3.5 w-3.5 mr-1" />
                  Some preflight checks did not pass. Sync may not work correctly.
                </div>
              )}
              <div className="rounded-lg border border-border bg-secondary/30 p-4 text-left max-w-sm mx-auto space-y-2">
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Mode</span><span className="font-medium text-foreground">{syncMode === "PULL_ONLY" ? "Pull Only (STS)" : "Bidirectional (STS+CCAPI)"}</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Frequency</span><span className="font-medium text-foreground">Every {frequency} min</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Backfill</span><span className="font-medium text-foreground">Last {backfill} days</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine families</span><span className="font-medium text-foreground">{wineCount}</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">C&C API</span><span className="font-medium text-foreground">{ccBaseUrl ? "Configured" : "Not set"}</span></div>
              </div>
              <Button size="lg" onClick={async () => { await enableSync(); setEnabled(true); setTimeout(() => navigate("/integrations"), 1500); }} className="shadow-glow">
                {enabled ? <><CheckCircle2 className="mr-2 h-4 w-4" /> Sync Enabled — Redirecting…</> : "Enable Sync"}
              </Button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {currentStep < 8 && (
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
