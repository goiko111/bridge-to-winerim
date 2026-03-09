import { useState, useEffect, useMemo } from "react";
import { getSimphonyConfig } from "@/utils/providerConfig";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle,
  Search, Link2, Settings2, Map, Power, Wine, Calendar,
  Download, Filter, Grape, ShieldCheck, BookOpen, FlaskConical,
  AlertTriangle, Eye, FileJson, Upload, Radio, Compass,
  Bell, Layers, Key, Lock, MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  useSimphonyConnection,
  SalesLineItem,
  PreflightCheck,
  CatalogWritePreview,
  WriteVerificationResult,
  PilotStep,
} from "@/hooks/useSimphonyConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";
import PostWriteVerificationDisplay from "@/components/PostWriteVerificationDisplay";

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Auth & Token", icon: Key },
  { id: 3, label: "Discover", icon: Compass },
  { id: 4, label: "Preflight", icon: ShieldCheck },
  { id: 5, label: "Sync Settings", icon: Settings2 },
  { id: 6, label: "Families", icon: Grape },
  { id: 7, label: "Sales & Mapping", icon: Map },
  { id: 8, label: "Catalog", icon: BookOpen },
  { id: 9, label: "Webhooks", icon: Bell },
  { id: 10, label: "Pilot", icon: FlaskConical },
  { id: 11, label: "Go Live", icon: Power },
];

export default function SimphonyWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState(1);

  // Connection fields
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
  const [writeMode, setWriteMode] = useState<"NONE" | "GATED">("NONE");
  const [writeApprovalOpen, setWriteApprovalOpen] = useState(false);
  const [writeTargetContext, setWriteTargetContext] = useState<{
    locationLabel: string; orgShortName: string; locRef: string;
    rvcs: string[]; writeMode: string; writeEnabled: boolean; ccBaseUrl: string | null;
  } | null>(null);

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
    writeVerification, verifying, verifyWrite,
    generateImportExport,
    pilotSteps, pilotRunning, runPilot,
    // S2
    oidcAcquiring, oidcResult, acquireOidcToken,
    // S3
    discoveredLocations, discovering, discoverLocations, saveDiscoverySelection,
    // S6
    webhookStatus, webhookRegistering, registerWebhook, fetchWebhookStatus,
    // S9
    selectedRvcs, setSelectedRvcs,
    // RVC diagnostics
    rvcDiagnostics, rvcDiagLoading, fetchRvcDiagnostics,
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
          const cfg = getSimphonyConfig(conn.provider_config);
          setOidcBaseUrl(cfg.oidc_base_url || "");
          setCcBaseUrl(cfg.cc_base_url || "");
          setClientId(cfg.client_id || "");
          setClientSecret(cfg.client_secret || "");
          setCurrentStep(7);
        }
      });
    }
  }, [searchParams]);

  useEffect(() => {
    if (currentStep === 4 && connectionId && preflightChecks.length === 0 && !preflightRunning) runPreflight();
  }, [currentStep, connectionId]);

  useEffect(() => {
    if ((currentStep === 6 || currentStep === 7) && connectionId && daysWithSales.length === 0 && !loadingDays) findDaysWithSales(60);
  }, [currentStep, connectionId]);

  useEffect(() => {
    if (selectedDay && (currentStep === 6 || currentStep === 7)) fetchSalesForDay(selectedDay);
  }, [selectedDay]);

  useEffect(() => {
    if (currentStep === 9 && connectionId) fetchWebhookStatus();
  }, [currentStep, connectionId]);

  const handleNext = async () => {
    if (currentStep === 3 && connectionId) {
      // Persist discovery selection
      const selectedLoc = discoveredLocations.find((l) => l.locRef === locRef);
      await saveDiscoverySelection(
        locRef,
        selectedLoc?.name || locationLabel,
        selectedRvcs.length > 0 ? selectedRvcs : (rvcRef ? [rvcRef] : []),
        discoveredLocations,
      );
      // Also update location_name with selected values
      await updateConnection(connectionId, { location_name: locationName });
    }
    if (currentStep === 5 && connectionId) {
      await updateConnection(connectionId, {
        sync_mode: syncMode, sync_frequency_minutes: frequency,
        backfill_days: backfill, location_name: locationName,
      });
    }
    if (currentStep === 6) {
      const families = detectedFamilies.map((f) => ({
        name: f.name, isWine: f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine,
      }));
      if (families.length > 0) await saveFamilyRules(families);
    }
    setCurrentStep((s) => Math.min(11, s + 1));
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

  const requiredCheckIds = ["base_urls", "sts", "oidc", "locations", "rvc", "rvc74", "workstation"];
  const preflightAllPass = preflightChecks.length > 0 && preflightChecks.filter((c) => c.required !== false && requiredCheckIds.includes(c.id)).every((c) => c.status === "pass");

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <button onClick={() => navigate("/integrations")} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Integrations
      </button>

      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-lg">O</div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connect Oracle MICROS Simphony</h1>
          <p className="text-sm text-muted-foreground">STS Gen2 + OIDC + C&C API + Notifications + Multi-RVC.</p>
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-0.5 overflow-x-auto pb-1">
        {steps.map((step, i) => {
          const isActive = step.id === currentStep;
          const isDone = step.id < currentStep;
          return (
            <div key={step.id} className="flex items-center gap-0.5 flex-1 min-w-0">
              <button
                onClick={() => step.id <= currentStep && setCurrentStep(step.id)}
                className={`flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-semibold transition-all shrink-0 ${isDone ? "bg-success text-success-foreground cursor-pointer" : isActive ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}
              >
                {isDone ? <CheckCircle2 className="h-3 w-3" /> : step.id}
              </button>
              <span className={`text-[9px] font-medium hidden xl:block truncate ${isActive ? "text-foreground" : "text-muted-foreground"}`}>{step.label}</span>
              {i < steps.length - 1 && <div className={`h-px flex-1 min-w-1 ${isDone ? "bg-success" : "bg-border"}`} />}
            </div>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={currentStep} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }} className="rounded-xl border border-border bg-card p-6 shadow-card">

          {/* ── Step 1: Connection ── */}
          {currentStep === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Connection Details</h2>
                <p className="mt-1 text-sm text-muted-foreground">Enter Simphony API credentials from Reporting & Analytics → Administration → API Accounts.</p>
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
                    <p className="mt-0.5 text-[10px] text-muted-foreground">Or use Discover step</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">RVC Ref</label>
                    <Input placeholder="RVC001" value={rvcRef} onChange={(e) => setRvcRef(e.target.value)} className="bg-background font-mono text-sm" />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">OIDC Base URL (OpenID Connect)</label>
                  <Input placeholder="https://login.oracleindustry.com" value={oidcBaseUrl} onChange={(e) => setOidcBaseUrl(e.target.value)} className="bg-background font-mono text-sm" />
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
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">ID Token (Bearer) <Badge variant="secondary" className="text-[9px] ml-1">Or use auto-acquire in step 2</Badge></label>
                  <Input type="password" placeholder="OIDC id_token" value={idToken} onChange={(e) => setIdToken(e.target.value)} className="bg-background font-mono text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Config & Content API URL <Badge variant="secondary" className="text-[9px] ml-1">Optional</Badge></label>
                  <Input placeholder="https://myorg-cc.oracleindustry.com" value={ccBaseUrl} onChange={(e) => setCcBaseUrl(e.target.value)} className="bg-background font-mono text-sm" />
                  <p className="mt-1 text-[11px] text-muted-foreground">EMC → Enterprise Parameters → Applications → CCAPI URL</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Winerim API Token</label>
                  <Input type="password" placeholder="Winerim API v2 token" value={winerimApiToken} onChange={(e) => setWinerimApiToken(e.target.value)} className="bg-background font-mono text-sm" />
                </div>
                <Button onClick={() => testConnection(hostUrl, idToken, locationName, winerimApiToken, oidcBaseUrl, ccBaseUrl, clientId, clientSecret)} disabled={testStatus === "testing" || !hostUrl || !orgShortName || !locRef || !rvcRef || (!idToken && !clientId)} variant="secondary" className="w-full">
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

          {/* ── Step 2: Auth & Token (S2) ── */}
          {currentStep === 2 && (() => {
            const diag = (oidcResult as any)?.diagnostics || {};
            return (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">OIDC Token Management</h2>
                <p className="mt-1 text-sm text-muted-foreground">Acquire and refresh tokens automatically via client_credentials flow. Tokens are cached and auto-refreshed 5 min before expiry.</p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Key className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">Client Credentials</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div><span className="text-muted-foreground">OIDC URL</span><p className="font-mono text-foreground truncate">{oidcBaseUrl || "Not set"}</p></div>
                  <div><span className="text-muted-foreground">Client ID</span><p className="font-mono text-foreground truncate">{clientId || "Not set"}</p></div>
                </div>
              </div>

              <Button onClick={acquireOidcToken} disabled={oidcAcquiring || !oidcBaseUrl || !clientId || !clientSecret} variant="secondary" className="w-full">
                {oidcAcquiring ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Key className="mr-2 h-4 w-4" />}
                {oidcAcquiring ? "Acquiring Token…" : "Acquire OIDC Token"}
              </Button>

              {oidcResult && (
                <div className={`rounded-lg border p-3 text-xs space-y-2 ${oidcResult.success ? "border-success/30 bg-success/5 text-success" : "border-destructive/30 bg-destructive/5 text-destructive"}`}>
                  <div>
                    {oidcResult.success ? <CheckCircle2 className="inline h-3.5 w-3.5 mr-1" /> : <XCircle className="inline h-3.5 w-3.5 mr-1" />}
                    {oidcResult.message}
                  </div>
                  {oidcResult.expiresAt && <p className="font-mono">Expires: {oidcResult.expiresAt}</p>}
                </div>
              )}

              {/* Auth diagnostics panel */}
              {oidcResult && (diag.lastAuthSuccessAt || diag.lastAuthFailureAt || diag.endpointUsed) && (
                <div className="rounded-lg border border-border bg-card p-3 space-y-2">
                  <p className="text-xs font-semibold text-foreground flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-primary" /> Auth Diagnostics</p>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    {diag.lastAuthSuccessAt && (
                      <div>
                        <span className="text-muted-foreground">Last success</span>
                        <p className="font-mono text-success">{new Date(diag.lastAuthSuccessAt).toLocaleString()}</p>
                      </div>
                    )}
                    {diag.lastAuthFailureAt && (
                      <div>
                        <span className="text-muted-foreground">Last failure</span>
                        <p className="font-mono text-destructive">{new Date(diag.lastAuthFailureAt).toLocaleString()}</p>
                      </div>
                    )}
                    {diag.tokenExpiresAt && (
                      <div>
                        <span className="text-muted-foreground">Token expiry</span>
                        <p className="font-mono text-foreground">{new Date(diag.tokenExpiresAt).toLocaleString()}</p>
                      </div>
                    )}
                    {diag.endpointUsed && (
                      <div>
                        <span className="text-muted-foreground">Endpoint</span>
                        <p className="font-mono text-foreground truncate">{diag.endpointUsed}</p>
                      </div>
                    )}
                    {diag.attemptsLastAcquire && (
                      <div>
                        <span className="text-muted-foreground">Attempts</span>
                        <p className="font-mono text-foreground">{diag.attemptsLastAcquire}</p>
                      </div>
                    )}
                    {diag.lastAuthFailureReason && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Failure reason</span>
                        <p className="font-mono text-destructive text-[10px] break-all">{diag.lastAuthFailureReason}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="rounded-lg border border-border bg-card p-3 text-[11px] text-muted-foreground space-y-1">
                <p className="font-medium text-foreground text-xs">How OIDC works:</p>
                <p>1. POST to <code className="text-primary">{`{OIDC_URL}/oidc-provider/v1/oauth2/token`}</code></p>
                <p>2. With <code>grant_type=client_credentials</code>, client_id, client_secret</p>
                <p>3. Returns id_token (valid ~14 days) used as Bearer for STS Gen2</p>
                <p>4. Token is cached and auto-refreshed 5 min before expiry</p>
                <p>5. Transient failures (5xx, network) retry up to 3× with exponential backoff</p>
                <p>6. Secrets and raw tokens are never logged</p>
              </div>
            </div>
            );
          })()}

          {/* ── Step 3: Discover Locations & RVCs (S3 + S9) ── */}
          {currentStep === 3 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Discover Locations & Revenue Centers</h2>
                <p className="mt-1 text-sm text-muted-foreground">Auto-discover from Organizations API to avoid manual config mistakes.</p>
              </div>

              {/* Selection summary — always visible when something is selected */}
              {(locRef || selectedRvcs.length > 0) && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2">
                  <p className="text-xs font-semibold text-primary flex items-center gap-1.5"><Map className="h-3.5 w-3.5" /> Current Selection</p>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="text-muted-foreground">Location</span>
                      <p className="font-mono text-foreground font-medium">
                        {(() => {
                          const loc = discoveredLocations.find((l) => l.locRef === locRef);
                          return loc ? `${loc.name} (${locRef})` : locRef || "Not selected";
                        })()}
                      </p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Revenue Centers</span>
                      {selectedRvcs.length > 0 ? (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {selectedRvcs.map((r) => {
                            const loc = discoveredLocations.find((l) => l.locRef === locRef);
                            const rvcInfo = loc?.revenueCenters.find((rv) => rv.rvcRef === r);
                            return (
                              <Badge key={r} variant="secondary" className="text-[9px] font-mono">
                                {rvcInfo ? `${rvcInfo.name} (${r})` : r}
                                {r === rvcRef && <span className="ml-1 text-primary">★</span>}
                              </Badge>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="font-mono text-foreground">{rvcRef || "None"}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <Button onClick={discoverLocations} disabled={discovering || !connectionId} variant="secondary" className="w-full">
                {discovering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Compass className="mr-2 h-4 w-4" />}
                {discovering ? "Discovering…" : discoveredLocations.length > 0 ? "Re-discover Locations" : "Discover Locations"}
              </Button>

              {discoveredLocations.length > 0 && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Found <strong className="text-foreground">{discoveredLocations.length}</strong> location(s) with <strong className="text-foreground">{discoveredLocations.reduce((s, l) => s + l.revenueCenters.length, 0)}</strong> revenue center(s). Select one location and one or more RVCs.
                  </p>
                  {discoveredLocations.map((loc) => {
                    const isSelectedLoc = locRef === loc.locRef;
                    return (
                    <div key={loc.locRef} className={`rounded-lg border overflow-hidden ${isSelectedLoc ? "border-primary/50 ring-1 ring-primary/20" : "border-border"}`}>
                      <div className={`px-4 py-3 flex items-center justify-between ${isSelectedLoc ? "bg-primary/5" : "bg-secondary/30"}`}>
                        <div>
                          <p className="text-sm font-medium text-foreground">{loc.name}</p>
                          <p className="text-[11px] font-mono text-muted-foreground">locRef: {loc.locRef}</p>
                        </div>
                        <Button size="sm" variant={isSelectedLoc ? "default" : "outline"} onClick={() => {
                          setLocRef(loc.locRef);
                          // Auto-select all RVCs for this location if none selected
                          if (!isSelectedLoc && loc.revenueCenters.length > 0) {
                            const allRvcRefs = loc.revenueCenters.map((r) => r.rvcRef);
                            setSelectedRvcs(allRvcRefs);
                            setRvcRef(allRvcRefs[0]);
                          }
                        }}>
                          {isSelectedLoc ? <><CheckCircle2 className="mr-1 h-3 w-3" /> Selected</> : "Select Location"}
                        </Button>
                      </div>
                      {loc.revenueCenters.length > 0 && (
                        <div className="divide-y divide-border">
                          {loc.revenueCenters.map((rvc) => {
                            const isSelected = selectedRvcs.includes(rvc.rvcRef);
                            const isPrimary = rvc.rvcRef === rvcRef;
                            return (
                              <div key={rvc.rvcRef} className={`flex items-center justify-between px-4 py-2.5 ${isSelectedLoc ? "bg-card" : "bg-card/50 opacity-60"}`}>
                                <div className="flex items-center gap-3">
                                  <Checkbox
                                    checked={isSelected}
                                    disabled={!isSelectedLoc}
                                    onCheckedChange={(checked) => {
                                      if (checked) {
                                        const newRvcs = [...selectedRvcs, rvc.rvcRef];
                                        setSelectedRvcs(newRvcs);
                                        if (!rvcRef) setRvcRef(rvc.rvcRef);
                                      } else {
                                        const newRvcs = selectedRvcs.filter((r) => r !== rvc.rvcRef);
                                        setSelectedRvcs(newRvcs);
                                        if (rvcRef === rvc.rvcRef && newRvcs.length > 0) setRvcRef(newRvcs[0]);
                                      }
                                    }}
                                  />
                                  <div>
                                    <p className="text-sm text-foreground">{rvc.name}</p>
                                    <p className="text-[11px] font-mono text-muted-foreground">rvcRef: {rvc.rvcRef}</p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  {isPrimary && <Badge variant="default" className="text-[9px]">Primary</Badge>}
                                  {isSelected && !isPrimary && isSelectedLoc && (
                                    <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[9px]" onClick={() => setRvcRef(rvc.rvcRef)}>
                                      Set Primary
                                    </Button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    );
                  })}

                  {selectedRvcs.length > 1 && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-primary">
                      <Layers className="inline h-3.5 w-3.5 mr-1" />
                      Multi-RVC mode: {selectedRvcs.length} revenue centers selected. Sales will be fetched from all and deduplicated by checkRef.
                    </div>
                  )}
                </div>
              )}

              {discoveredLocations.length === 0 && !discovering && (
                <div className="rounded-lg border border-border bg-secondary/30 p-4 text-xs text-muted-foreground space-y-2">
                  <p className="font-medium text-foreground text-sm">Manual entry</p>
                  <p>If discovery fails, enter locRef and rvcRef manually from EMC → Setup → Locations / Revenue Centers.</p>
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <label className="text-[11px] text-muted-foreground mb-1 block">Location Ref</label>
                      <Input value={locRef} onChange={(e) => setLocRef(e.target.value)} className="bg-background font-mono text-sm" placeholder="LOC001" />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground mb-1 block">Primary RVC Ref</label>
                      <Input value={rvcRef} onChange={(e) => setRvcRef(e.target.value)} className="bg-background font-mono text-sm" placeholder="RVC001" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 4: Preflight (S8 enhanced) ── */}
          {currentStep === 4 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Preflight Checks</h2>
                <p className="mt-1 text-sm text-muted-foreground">Verifying base URLs, STS Gen2, OIDC auth, locations, RVC, Option 74, and workstation.</p>
              </div>
              {preflightRunning && (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">Running checks…</span>
                </div>
              )}
              {!preflightRunning && preflightChecks.length > 0 && (
                <div className="space-y-2">
                  {preflightChecks.map((check) => {
                    const level = check.status === "pass" ? "green" : check.status === "fail" ? "red" : "amber";
                    const bg = level === "green" ? "bg-success/5 border-success/30" : level === "red" ? "bg-destructive/5 border-destructive/30" : "bg-warning/5 border-warning/30";
                    const textColor = level === "green" ? "text-success" : level === "red" ? "text-destructive" : "text-warning";
                    return (
                      <div key={check.id} className={`flex items-start gap-3 rounded-lg border p-3 ${bg}`}>
                        <div className="mt-0.5 shrink-0">
                          {level === "green" && <CheckCircle2 className="h-4 w-4 text-success" />}
                          {level === "red" && <XCircle className="h-4 w-4 text-destructive" />}
                          {level === "amber" && <AlertTriangle className="h-4 w-4 text-warning" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-foreground">{check.label}</p>
                            {check.required !== false && <Badge variant="outline" className="text-[9px]">Required</Badge>}
                            <Badge className={`text-[9px] ml-auto shrink-0 ${level === "green" ? "bg-success/20 text-success border-success/30" : level === "red" ? "bg-destructive/20 text-destructive border-destructive/30" : "bg-warning/20 text-warning border-warning/30"}`} variant="outline">{check.status}</Badge>
                          </div>
                          {check.detail && <p className={`text-[11px] mt-0.5 ${textColor}`}>{check.detail}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {!preflightRunning && preflightChecks.length > 0 && !preflightAllPass && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive space-y-2">
                  <div className="flex items-center gap-2 font-semibold"><XCircle className="h-3.5 w-3.5" /> Required checks must be green before Go Live</div>
                  <div className="text-[11px] space-y-1 text-destructive/80">
                    <p className="font-medium">Failing checks:</p>
                    {preflightChecks.filter((c) => c.required !== false && c.status !== "pass").map((c) => (
                      <p key={c.id}>• <strong>{c.label}</strong>: {c.detail || c.status}</p>
                    ))}
                  </div>
                  <div className="text-[11px] space-y-1 mt-2 text-muted-foreground">
                    <p className="font-medium text-foreground">Common fixes:</p>
                    <p>• <strong>Base URLs</strong>: Verify STS Host URL, OIDC URL, Org Short Name, locRef, rvcRef in step 1</p>
                    <p>• <strong>Option 74</strong>: EMC → Setup → RVC Parameters → Options → #74 Enable STS Gen2</p>
                    <p>• <strong>Workstation</strong>: EMC → Setup → Workstations → New → Type: POS API Client</p>
                    <p>• <strong>CAPS Host</strong>: Set CAPS Service Host on the POS API Client workstation</p>
                  </div>
                </div>
              )}
              {!preflightRunning && preflightChecks.length > 0 && preflightAllPass && (
                <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs text-success flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" /> All required checks passed — ready to proceed.
                </div>
              )}
              {!preflightRunning && (
                <Button variant="outline" size="sm" onClick={runPreflight}>
                  <ShieldCheck className="mr-2 h-3.5 w-3.5" /> {preflightChecks.length > 0 ? "Re-run Preflight" : "Run Preflight"}
                </Button>
              )}
            </div>
          )}

          {/* ── Step 5: Sync Settings ── */}
          {currentStep === 5 && (
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
                {selectedRvcs.length > 1 && (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-primary">
                      <Layers className="inline h-3.5 w-3.5 mr-1" />
                      Multi-RVC: syncing across {selectedRvcs.length} revenue centers ({selectedRvcs.join(", ")})
                    </div>
                    <Button variant="outline" size="sm" onClick={fetchRvcDiagnostics} disabled={rvcDiagLoading}>
                      {rvcDiagLoading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Layers className="mr-2 h-3.5 w-3.5" />}
                      {rvcDiagLoading ? "Checking RVCs…" : "Check RVC Health"}
                    </Button>
                    {rvcDiagnostics && !rvcDiagnostics.singleRvc && rvcDiagnostics.diagnostics && (
                      <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                        {rvcDiagnostics.diagnostics.map((d) => (
                          <div key={d.rvc} className={`px-4 py-3 ${d.reachable ? "bg-card" : "bg-destructive/5"}`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <div className={`h-2 w-2 rounded-full ${d.reachable ? "bg-success" : "bg-destructive"}`} />
                                <span className="text-sm font-mono font-medium text-foreground">{d.rvc}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {d.reachable ? (
                                  <Badge variant="default" className="text-[9px]">Reachable</Badge>
                                ) : (
                                  <Badge variant="destructive" className="text-[9px]">Unreachable</Badge>
                                )}
                                {typeof d.savedEvents === "number" && (
                                  <Badge variant="secondary" className="text-[9px]">{d.savedEvents} events</Badge>
                                )}
                              </div>
                            </div>
                            <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                              <span className="text-muted-foreground">Last sync</span>
                              <span className="font-mono text-foreground">{d.cursor.synced_at ? new Date(d.cursor.synced_at).toLocaleString() : "Never"}</span>
                              <span className="text-muted-foreground">Last business day</span>
                              <span className="font-mono text-foreground">{d.cursor.last_business_day || "—"}</span>
                              <span className="text-muted-foreground">Last cursor</span>
                              <span className="font-mono text-foreground">{d.cursor.last_cursor ? d.cursor.last_cursor.slice(0, 19) : "—"}</span>
                              <span className="text-muted-foreground">Sample checks</span>
                              <span className="font-mono text-foreground">{d.sampleChecks}</span>
                              {d.error && (
                                <>
                                  <span className="text-destructive">Error</span>
                                  <span className="font-mono text-destructive truncate">{d.error.slice(0, 80)}</span>
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                        {rvcDiagnostics.globalCursor && (
                          <div className="px-4 py-2 bg-secondary/30 flex justify-between text-[10px]">
                            <span className="text-muted-foreground">Global cursor</span>
                            <span className="font-mono text-foreground">{rvcDiagnostics.globalCursor}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 6: Families ── */}
          {currentStep === 6 && (
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

          {/* ── Step 7: Sales & Mapping ── */}
          {currentStep === 7 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Sales & Product Mapping</h2>
                <p className="mt-1 text-sm text-muted-foreground">Review checks fetched via STS Gen2{selectedRvcs.length > 1 ? ` across ${selectedRvcs.length} RVCs` : ""}.</p>
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
                  {/* Sync diagnostics panel */}
                  {saveResult?.diagnostics && (
                    <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1.5">
                      <p className="text-xs font-semibold text-primary flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> Sync Diagnostics</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                        <span className="text-muted-foreground">Business date</span><span className="font-mono text-foreground">{saveResult.diagnostics.business_day}</span>
                        <span className="text-muted-foreground">Checks fetched</span><span className="font-mono text-foreground">{saveResult.diagnostics.checks_fetched}</span>
                        <span className="text-muted-foreground">Batches processed</span><span className="font-mono text-foreground">{saveResult.diagnostics.batches_processed}</span>
                        <span className="text-muted-foreground">Line items saved</span><span className="font-mono text-foreground">{saveResult.diagnostics.line_items_saved}</span>
                        <span className="text-muted-foreground">Retries</span><span className="font-mono text-foreground">{saveResult.diagnostics.retries > 0 ? <span className="text-warning">{saveResult.diagnostics.retries}</span> : "0"}</span>
                        <span className="text-muted-foreground">Duration</span><span className="font-mono text-foreground">{(saveResult.diagnostics.duration_ms / 1000).toFixed(1)}s</span>
                        <span className="text-muted-foreground">Synced at</span><span className="font-mono text-foreground">{new Date(saveResult.diagnostics.synced_at).toLocaleTimeString()}</span>
                      </div>
                      {saveResult.diagnostics.per_rvc && Object.keys(saveResult.diagnostics.per_rvc).length > 1 && (
                        <div className="mt-2 border-t border-border pt-2 space-y-1">
                          <p className="text-[10px] font-medium text-muted-foreground">Per-RVC breakdown</p>
                          {Object.entries(saveResult.diagnostics.per_rvc).map(([rvc, d]) => (
                            <div key={rvc} className="flex items-center justify-between text-[10px] font-mono">
                              <span className="text-muted-foreground">{rvc}</span>
                              <span className="text-foreground">{d.saved} checks · {d.lines} lines · {d.wine} wine{d.duplicates_skipped > 0 ? ` · ${d.duplicates_skipped} dedup` : ""}{d.last_cursor ? ` · cursor: ${d.last_cursor.slice(11, 19)}` : ""}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
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

          {/* ── Step 8: Catalog & Write ── */}
          {currentStep === 8 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Catalog & Write</h2>
                <p className="mt-1 text-sm text-muted-foreground">Read menu items via C&C API and push Winerim wines (gated).</p>
              </div>

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

                {/* Post-write verification */}
                {catalogWritePreview.length > 0 && (
                  <div className="space-y-2 border-t border-border pt-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                        <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Post-Write Verification
                      </h4>
                      <Button size="sm" variant="outline" onClick={() => {
                        const first = catalogWritePreview[0];
                        if (first) verifyWrite({ winerim_id: first.winerimId, format: first.format, expectedPrice: first.price, verifyMode: "ccapi" });
                      }} disabled={verifying}>
                        {verifying ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <ShieldCheck className="mr-1.5 h-3 w-3" />}
                        Verify First Item
                      </Button>
                    </div>
                    {writeVerification && (
                      <PostWriteVerificationDisplay result={writeVerification} provider="simphony" />
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-3 border-t border-border pt-4">
                <h3 className="text-sm font-medium text-foreground">Bulk Import/Export <Badge variant="secondary" className="text-[9px] ml-1">Plan B</Badge></h3>
                <p className="text-[11px] text-muted-foreground">Generate a file for Simphony's Import/Export if C&C write is unavailable.</p>
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

          {/* ── Step 9: Webhooks (S6) ── */}
          {currentStep === 9 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Notifications & Webhooks</h2>
                <p className="mt-1 text-sm text-muted-foreground">Register for near real-time check events via Simphony Notifications API.</p>
              </div>

              <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Bell className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">Webhook Status</span>
                </div>
                {webhookStatus ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <span className="text-muted-foreground">Registered</span>
                    <span className="font-medium text-foreground">{webhookStatus.registered ? "Yes" : "No"}</span>
                    <span className="text-muted-foreground">Callback URL</span>
                    <span className="font-mono text-foreground truncate text-[10px]">{webhookStatus.callbackUrl}</span>
                    <span className="text-muted-foreground">Last event</span>
                    <span className="font-mono text-foreground">{webhookStatus.lastEventAt || "Never"}</span>
                    <span className="text-muted-foreground">Total events</span>
                    <span className="font-mono text-foreground">{webhookStatus.eventCount}</span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No webhook registered yet.</p>
                )}
              </div>

              <Button onClick={registerWebhook} disabled={webhookRegistering || !connectionId} variant="secondary" className="w-full">
                {webhookRegistering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Radio className="mr-2 h-4 w-4" />}
                {webhookRegistering ? "Registering…" : "Register Webhook"}
              </Button>

              <div className="rounded-lg border border-border bg-card p-3 text-[11px] text-muted-foreground space-y-1">
                <p className="font-medium text-foreground text-xs">How Notifications work:</p>
                <p>1. We register a callback URL for CHECK_CLOSED / CHECK_OPENED events</p>
                <p>2. Simphony sends POST to our endpoint when events occur</p>
                <p>3. We validate and queue for async processing</p>
                <p>4. Updated checks are fetched and upserted as SalesEvents</p>
                <p className="text-warning mt-2"><AlertTriangle className="inline h-3 w-3 mr-1" />Notifications API may require partner enablement in your Simphony installation.</p>
              </div>
            </div>
          )}

          {/* ── Step 10: Pilot ── */}
          {currentStep === 10 && (
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

          {/* ── Step 11: Go Live ── */}
          {currentStep === 11 && (
            <div className="space-y-6 text-center py-4">
              <div className="flex justify-center"><div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10"><Power className="h-8 w-8 text-primary" /></div></div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Ready to Go Live</h2>
                <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">Simphony integration fully configured with STS Gen2 + OIDC + C&C + Notifications.</p>
              </div>
              <ProviderReadinessPanel connectionId={connectionId} provider="simphony" />
              {!preflightAllPass && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive max-w-sm mx-auto space-y-2">
                  <div className="flex items-center gap-2 font-semibold"><XCircle className="h-4 w-4" /> Required preflight checks not passed</div>
                  <p className="text-xs text-destructive/80">Go back to step 4 (Preflight) and resolve all required checks before enabling sync.</p>
                  <Button variant="outline" size="sm" onClick={() => setCurrentStep(4)} className="text-xs">
                    <ArrowLeft className="mr-1 h-3 w-3" /> Go to Preflight
                  </Button>
                </div>
              )}
              <div className="rounded-lg border border-border bg-secondary/30 p-4 text-left max-w-sm mx-auto space-y-2">
                {/* Location & RVCs */}
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Location</span>
                  <span className="font-medium text-foreground">
                    {(() => {
                      const loc = discoveredLocations.find((l) => l.locRef === locRef);
                      return loc ? `${loc.name} (${locRef})` : locRef || "Not set";
                    })()}
                  </span>
                </div>
                <div className="text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Revenue Centers</span>
                    <span className="font-medium text-foreground">{selectedRvcs.length > 1 ? `${selectedRvcs.length} (multi-RVC)` : rvcRef || "Not set"}</span>
                  </div>
                  {selectedRvcs.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1 justify-end">
                      {selectedRvcs.map((r) => {
                        const loc = discoveredLocations.find((l) => l.locRef === locRef);
                        const rvcInfo = loc?.revenueCenters.find((rv) => rv.rvcRef === r);
                        return (
                          <Badge key={r} variant="secondary" className="text-[9px] font-mono">
                            {rvcInfo ? rvcInfo.name : r}
                            {r === rvcRef && <span className="ml-0.5 text-primary">★</span>}
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="border-t border-border my-1" />
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Mode</span><span className="font-medium text-foreground">{syncMode === "PULL_ONLY" ? "Pull Only (STS)" : "Bidirectional (STS+CCAPI)"}</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Frequency</span><span className="font-medium text-foreground">Every {frequency} min</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Backfill</span><span className="font-medium text-foreground">Last {backfill} days</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine families</span><span className="font-medium text-foreground">{wineCount}</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">C&C API</span><span className="font-medium text-foreground">{ccBaseUrl ? "Configured" : "Not set"}</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Webhooks</span><span className="font-medium text-foreground">{webhookStatus?.registered ? "Active" : "Not set"}</span></div>
              </div>
              <Button size="lg" onClick={async () => { await enableSync(); setEnabled(true); setTimeout(() => navigate("/integrations"), 1500); }} disabled={!preflightAllPass} className="shadow-glow">
                {enabled ? <><CheckCircle2 className="mr-2 h-4 w-4" /> Sync Enabled — Redirecting…</> : "Enable Sync"}
              </Button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {currentStep < 11 && (
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
