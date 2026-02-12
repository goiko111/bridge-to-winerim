import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
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
  Grape,
  ShieldCheck,
  ShieldX,
  HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useAgoraConnection, SalesEvent, SalesLineItem, DetectedFamily } from "@/hooks/useAgoraConnection";

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

// ── Step 3: Families ──
function StepFamilies({
  detectedFamilies,
  loadingDays,
  loadingSales,
  familyOverrides,
  setFamilyOverrides,
  scanStats,
  daysWithSales,
  selectedDay,
  onRunHistoricalScan,
}: {
  detectedFamilies: DetectedFamily[];
  loadingDays: boolean;
  loadingSales: boolean;
  familyOverrides: Record<string, boolean>;
  setFamilyOverrides: (v: Record<string, boolean>) => void;
  scanStats: { totalScanned: number; totalInvoicesFound: number } | null;
  daysWithSales: string[];
  selectedDay: string | null;
  onRunHistoricalScan: () => void;
}) {
  const sortedFamilies = useMemo(() => {
    return [...detectedFamilies].sort((a, b) => {
      const aWine = a.name in familyOverrides ? familyOverrides[a.name] : a.suggestedWine;
      const bWine = b.name in familyOverrides ? familyOverrides[b.name] : b.suggestedWine;
      if (aWine !== bWine) return aWine ? -1 : 1;
      const confOrder = { high: 0, medium: 1, low: 2 };
      if (a.confidence !== b.confidence) return confOrder[a.confidence] - confOrder[b.confidence];
      return b.itemCount - a.itemCount;
    });
  }, [detectedFamilies, familyOverrides]);

  const wineCount = sortedFamilies.filter((f) => {
    return f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine;
  }).length;

  const confidenceIcon = (c: "high" | "medium" | "low") => {
    if (c === "high") return <ShieldCheck className="h-3.5 w-3.5 text-success" />;
    if (c === "medium") return <HelpCircle className="h-3.5 w-3.5 text-warning" />;
    return <ShieldX className="h-3.5 w-3.5 text-muted-foreground" />;
  };

  const isLoading = loadingDays || loadingSales;

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Wine Family Classification</h2>
          <p className="mt-1 text-sm text-muted-foreground">Scanning sales data for product families…</p>
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">
            {loadingDays ? "Scanning business days (up to 60 days)…" : "Loading sales data…"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Wine Family Classification</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {detectedFamilies.length > 0
            ? <>We detected <span className="font-medium text-foreground">{detectedFamilies.length}</span> product families. Confirm which ones contain wine products.</>
            : "No product families detected yet."}
        </p>
      </div>

      {/* Debug info */}
      {scanStats && (
        <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Scan Results</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Days scanned</span>
            <span className="font-mono text-foreground">{scanStats.totalScanned}</span>
            <span className="text-muted-foreground">Days with sales</span>
            <span className="font-mono text-foreground">{daysWithSales.length}</span>
            <span className="text-muted-foreground">Total invoices found</span>
            <span className="font-mono text-foreground">{scanStats.totalInvoicesFound}</span>
            {selectedDay && (
              <>
                <span className="text-muted-foreground">Last day with data</span>
                <span className="font-mono text-foreground">{selectedDay}</span>
              </>
            )}
            <span className="text-muted-foreground">Families detected</span>
            <span className="font-mono text-foreground">{detectedFamilies.length}</span>
          </div>
        </div>
      )}

      {/* Empty state with historical scan button */}
      {detectedFamilies.length === 0 && (
        <div className="text-center py-8 space-y-4 rounded-lg border border-border bg-secondary/20">
          <p className="text-sm text-muted-foreground">
            {daysWithSales.length === 0
              ? "No cash closures found in the scanned period. The restaurant may not have had recent activity."
              : "No product families found in the sales data. Try scanning more history."}
          </p>
          <Button variant="secondary" onClick={onRunHistoricalScan}>
            <Search className="mr-2 h-4 w-4" />
            Run Historical Scan (90 days)
          </Button>
        </div>
      )}

      {detectedFamilies.length > 0 && (
        <>
          {/* Summary bar */}
          <div className="flex gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full bg-success" />
              <span className="text-muted-foreground"><span className="font-medium text-foreground">{wineCount}</span> wine families</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground" />
              <span className="text-muted-foreground"><span className="font-medium text-foreground">{sortedFamilies.length - wineCount}</span> non-wine</span>
            </div>
          </div>

          {/* Bulk actions */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => {
              const overrides: Record<string, boolean> = {};
              detectedFamilies.forEach((f) => { overrides[f.name] = true; });
              setFamilyOverrides(overrides);
            }}>Select All as Wine</Button>
            <Button variant="outline" size="sm" onClick={() => {
              const overrides: Record<string, boolean> = {};
              detectedFamilies.forEach((f) => { overrides[f.name] = false; });
              setFamilyOverrides(overrides);
            }}>Deselect All</Button>
            <Button variant="outline" size="sm" onClick={() => setFamilyOverrides({})}>Reset to Suggestions</Button>
          </div>

          {/* Family list */}
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-96 overflow-y-auto">
            {sortedFamilies.map((f) => {
              const isWine = f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine;
              const isOverridden = f.name in familyOverrides && familyOverrides[f.name] !== f.suggestedWine;

              return (
                <div
                  key={f.name}
                  className={`flex items-center justify-between px-4 py-3 transition-colors cursor-pointer hover:bg-secondary/30 ${isWine ? "bg-success/5" : "bg-card"}`}
                  onClick={() => setFamilyOverrides({ ...familyOverrides, [f.name]: !isWine })}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Switch
                      checked={isWine}
                      onCheckedChange={(v) => setFamilyOverrides({ ...familyOverrides, [f.name]: v })}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-foreground truncate">{f.name}</p>
                        {isOverridden && <Badge variant="outline" className="text-[10px] px-1.5 py-0">edited</Badge>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {confidenceIcon(f.confidence)}
                        <span className="text-[11px] text-muted-foreground capitalize">{f.confidence} confidence</span>
                        <span className="text-[11px] text-muted-foreground">· {f.itemCount} items</span>
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0">
                    {isWine ? (
                      <Badge variant="default" className="text-[10px]"><Wine className="mr-1 h-3 w-3" />Wine</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">Non-wine</Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Step 4: Sales & Mapping ──
function StepSalesMapping({
  daysWithSales, selectedDay, setSelectedDay, loadingDays,
  salesEvents, loadingSales,
  onFetchDay, onSaveSales,
  saving, saveResult,
  familyOverrides, detectedFamilies,
  searchMapping, setSearchMapping,
  showWineOnly, setShowWineOnly,
}: {
  daysWithSales: string[];
  selectedDay: string | null;
  setSelectedDay: (d: string) => void;
  loadingDays: boolean;
  salesEvents: SalesEvent[];
  loadingSales: boolean;
  onFetchDay: (day: string) => void;
  onSaveSales: (day: string) => void;
  saving: boolean;
  saveResult: { savedEvents: number; savedLines: number } | null;
  familyOverrides: Record<string, boolean>;
  detectedFamilies: DetectedFamily[];
  searchMapping: string;
  setSearchMapping: (v: string) => void;
  showWineOnly: boolean;
  setShowWineOnly: (v: boolean) => void;
}) {
  // Resolve family wine status from overrides or detected suggestion
  const isFamilyWine = (familyName: string) => {
    if (familyName in familyOverrides) return familyOverrides[familyName];
    const detected = detectedFamilies.find((f) => f.name === familyName);
    return detected?.suggestedWine ?? false;
  };

  const allLines = useMemo(() => {
    const lines: (SalesLineItem & { docId: string; familyIsWine: boolean })[] = [];
    for (const ev of salesEvents) {
      for (const l of ev.lines) {
        lines.push({ ...l, docId: ev.provider_doc_id, familyIsWine: isFamilyWine(l.family) });
      }
    }
    return lines;
  }, [salesEvents, familyOverrides, detectedFamilies]);

  const filteredLines = useMemo(() => {
    let result = allLines;
    if (searchMapping) {
      const q = searchMapping.toLowerCase();
      result = result.filter((l) => l.name.toLowerCase().includes(q) || l.family.toLowerCase().includes(q));
    }
    if (showWineOnly) {
      result = result.filter((l) => l.familyIsWine || l.is_wine_candidate);
    }
    return result;
  }, [allLines, searchMapping, showWineOnly]);

  const totalAmount = salesEvents.reduce((s, e) => s + e.total_amount, 0);
  const wineLines = allLines.filter((l) => l.familyIsWine || l.is_wine_candidate);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Sales & Product Mapping</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review sales data. Wine-classified items are shown by default.
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
            <span className="text-muted-foreground">Total line items</span>
            <span className="font-medium text-foreground">{allLines.length}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Total</span>
            <span className="font-medium text-foreground">€{totalAmount.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Wine candidates</span>
            <span className="font-medium text-success">{wineLines.length}</span>
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

      {/* Filters */}
      {allLines.length > 0 && (
        <>
          <div className="flex gap-3 items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search products…" value={searchMapping} onChange={(e) => setSearchMapping(e.target.value)} className="pl-10 bg-background" />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
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
              filteredLines.map((l, i) => {
                const isWine = l.familyIsWine || l.is_wine_candidate;
                return (
                  <div key={`${l.docId}-${l.provider_product_id}-${i}`} className="flex items-center justify-between px-4 py-2.5 bg-card hover:bg-secondary/30 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`h-2 w-2 rounded-full shrink-0 ${isWine ? "bg-success" : "bg-muted-foreground"}`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{l.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {l.family && <span className="mr-2">{l.family}</span>}
                          {l.format && <span className="mr-2">· {l.format}</span>}
                          <span className="font-mono">×{l.quantity}</span>
                          <span className="ml-2 font-mono">@€{l.unit_price.toFixed(2)}</span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs font-mono text-foreground">€{l.total_amount.toFixed(2)}</span>
                      {isWine ? (
                        <Badge variant="default" className="text-[10px]"><Wine className="mr-1 h-3 w-3" />Wine</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">Non-wine</Badge>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Step 5: Go Live ──
function StepGoLive({
  syncMode, frequency, backfill,
  salesEvents, selectedDay,
  onEnable, enabled,
  familyOverrides, detectedFamilies,
}: {
  syncMode: string;
  frequency: number;
  backfill: number;
  salesEvents: SalesEvent[];
  selectedDay: string | null;
  onEnable: () => void;
  enabled: boolean;
  familyOverrides: Record<string, boolean>;
  detectedFamilies: DetectedFamily[];
}) {
  const wineFamilyCount = detectedFamilies.filter((f) => {
    return f.name in familyOverrides ? familyOverrides[f.name] : f.suggestedWine;
  }).length;
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
        <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine families</span><span className="font-medium text-foreground">{wineFamilyCount}</span></div>
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
  const [searchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState(1);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [locationName, setLocationName] = useState("");
  const [syncMode, setSyncMode] = useState<"PULL_ONLY" | "BIDIRECTIONAL">("PULL_ONLY");
  const [frequency, setFrequency] = useState(15);
  const [backfill, setBackfill] = useState(30);
  const [enabled, setEnabled] = useState(false);
  const [searchMapping, setSearchMapping] = useState("");
  const [showWineOnly, setShowWineOnly] = useState(true);
  const [familyOverrides, setFamilyOverrides] = useState<Record<string, boolean>>({});

  const {
    connectionId,
    setConnectionId,
    testStatus, testError,
    testConnection, updateConnection,
    loadConnection,
    daysWithSales, selectedDay, setSelectedDay, loadingDays, findDaysWithSales, scanStats,
    salesEvents, detectedFamilies, loadingSales, fetchSalesForDay,
    saving, saveResult, saveSalesToDb,
    enableSync, saveFamilyRules,
  } = useAgoraConnection();

  // Load existing connection from URL param
  useEffect(() => {
    const connParam = searchParams.get("connection");
    if (connParam && !connectionId) {
      loadConnection(connParam).then((conn) => {
        if (conn) {
          setLocationName(conn.location_name);
          setBaseUrl(conn.base_url);
          setApiToken(conn.api_token);
          setSyncMode(conn.sync_mode as "PULL_ONLY" | "BIDIRECTIONAL");
          setFrequency(conn.sync_frequency_minutes);
          setBackfill(conn.backfill_days);
          setEnabled(conn.enabled);
          setCurrentStep(4); // Jump to Sales view
        }
      });
    }
  }, [searchParams]);

  // When entering step 3 or 4, scan for business days
  useEffect(() => {
    if ((currentStep === 3 || currentStep === 4) && connectionId && daysWithSales.length === 0 && !loadingDays) {
      findDaysWithSales(60);
    }
  }, [currentStep, connectionId]);

  // Auto-fetch first day with sales when days are found (for family detection)
  useEffect(() => {
    if (selectedDay && (currentStep === 3 || currentStep === 4)) {
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
    setCurrentStep((s) => Math.min(5, s + 1));
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
            <StepFamilies
              detectedFamilies={detectedFamilies}
              loadingDays={loadingDays}
              loadingSales={loadingSales}
              familyOverrides={familyOverrides}
              setFamilyOverrides={setFamilyOverrides}
              scanStats={scanStats}
              daysWithSales={daysWithSales}
              selectedDay={selectedDay}
              onRunHistoricalScan={() => findDaysWithSales(90)}
            />
          )}
          {currentStep === 4 && (
            <StepSalesMapping
              daysWithSales={daysWithSales} selectedDay={selectedDay} setSelectedDay={setSelectedDay} loadingDays={loadingDays}
              salesEvents={salesEvents} loadingSales={loadingSales}
              onFetchDay={fetchSalesForDay} onSaveSales={saveSalesToDb}
              saving={saving} saveResult={saveResult}
              familyOverrides={familyOverrides} detectedFamilies={detectedFamilies}
              searchMapping={searchMapping} setSearchMapping={setSearchMapping}
              showWineOnly={showWineOnly} setShowWineOnly={setShowWineOnly}
            />
          )}
          {currentStep === 5 && (
            <StepGoLive
              syncMode={syncMode} frequency={frequency} backfill={backfill}
              salesEvents={salesEvents} selectedDay={selectedDay}
              onEnable={async () => { await enableSync(); setEnabled(true); setTimeout(() => navigate("/sync-monitor"), 1000); }}
              enabled={enabled}
              familyOverrides={familyOverrides} detectedFamilies={detectedFamilies}
            />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setCurrentStep((s) => Math.max(1, s - 1))} disabled={currentStep === 1}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Previous
        </Button>
        {currentStep < 5 && (
          <Button onClick={handleNext}>Next <ArrowRight className="ml-2 h-4 w-4" /></Button>
        )}
      </div>
    </div>
  );
}
