import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle,
  Link2, Settings2, Map, Power, Wine, Calendar, Download,
  Package, RefreshCw, Database, Store,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/hooks/use-toast";
import { useCassaConnection, CassaSalesPoint } from "@/hooks/useCassaConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Sales Points", icon: Store },
  { id: 3, label: "Sync Settings", icon: Settings2 },
  { id: 4, label: "Backfill", icon: Calendar },
  { id: 5, label: "Products", icon: Package },
  { id: 6, label: "Go Live", icon: Power },
];

export default function CassaWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(1);

  // Form state
  const [locationName, setLocationName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [winerimApiToken, setWinerimApiToken] = useState("");
  const [syncMode, setSyncMode] = useState<"WEBHOOKS" | "POLLING">("WEBHOOKS");
  const [frequency, setFrequency] = useState(15);
  const [backfillDays, setBackfillDays] = useState(30);
  const [selectedSalesPointIds, setSelectedSalesPointIds] = useState<string[]>([]);

  const hook = useCassaConnection();

  // Load existing connection
  useEffect(() => {
    const connId = searchParams.get("connectionId");
    if (connId) {
      hook.loadConnection(connId).then((conn: any) => {
        if (conn) {
          setLocationName(conn.location_name || "");
          setApiKey(conn.api_token || "");
          setWinerimApiToken(conn.winerim_api_token || "");
          setSyncMode(conn.sync_mode === "WEBHOOKS" ? "WEBHOOKS" : "POLLING");
          setFrequency(conn.sync_frequency_minutes || 15);
          setBackfillDays(conn.backfill_days || 30);
        }
      });
    }
  }, [searchParams]);

  const webhookUrl = hook.connectionId
    ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cassa-proxy/webhook`
    : "";

  const canNext = () => {
    if (step === 1) return hook.testStatus === "success";
    return true;
  };

  const handleNext = async () => {
    if (step === 3 && hook.connectionId) {
      await hook.updateConnection(hook.connectionId, {
        location_name: locationName,
        sync_mode: syncMode,
        sync_frequency_minutes: frequency,
        backfill_days: backfillDays,
      });
    }
    setStep((s) => Math.min(s + 1, steps.length));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/integrations")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">Cassa in Cloud</h1>
          <p className="text-xs text-muted-foreground">TeamSystem Cassanova connector</p>
        </div>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-1">
        {steps.map((s) => {
          const Icon = s.icon;
          const active = step === s.id;
          const done = step > s.id;
          return (
            <button
              key={s.id}
              onClick={() => s.id <= step && setStep(s.id)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
                active ? "bg-primary text-primary-foreground" : done ? "bg-primary/10 text-primary" : "text-muted-foreground"
              }`}
            >
              {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{s.label}</span>
            </button>
          );
        })}
      </div>

      {/* Step content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.2 }}
          className="rounded-xl border border-border bg-card p-6 shadow-card"
        >
          {/* Step 1: Connection */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Connection Details</h2>
                <p className="mt-1 text-sm text-muted-foreground">Enter your Cassa in Cloud API Key to authenticate.</p>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Location Name</label>
                  <Input placeholder="e.g. Ristorante Da Mario" value={locationName} onChange={(e) => setLocationName(e.target.value)} className="bg-background text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">API Key</label>
                  <Input type="password" placeholder="Enter your Cassa in Cloud API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="bg-background font-mono text-sm" />
                  <p className="mt-1 text-[11px] text-muted-foreground">Obtain from TeamSystem Cassa in Cloud admin panel.</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Winerim API Token</label>
                  <Input type="password" placeholder="Enter your Winerim API token" value={winerimApiToken} onChange={(e) => setWinerimApiToken(e.target.value)} className="bg-background font-mono text-sm" />
                </div>
                <Button onClick={() => hook.testConnection(apiKey, winerimApiToken)} disabled={hook.testStatus === "testing" || !apiKey} variant="secondary" className="w-full">
                  {hook.testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {hook.testStatus === "success" && <CheckCircle2 className="mr-2 h-4 w-4 text-success" />}
                  {hook.testStatus === "error" && <XCircle className="mr-2 h-4 w-4 text-destructive" />}
                  {hook.testStatus === "idle" && "Test Connection"}
                  {hook.testStatus === "testing" && "Authenticating…"}
                  {hook.testStatus === "success" && "Connected"}
                  {hook.testStatus === "error" && "Failed – see details below"}
                </Button>

                {/* Diagnostics panel */}
                {hook.diagnostics && hook.diagnostics.length > 0 && (
                  <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
                    <p className="text-xs font-medium text-foreground">Connection Diagnostics</p>
                    {hook.diagnostics.map((d: any, i: number) => (
                      <div key={i} className="rounded border border-border bg-background p-2 text-xs space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={d.status >= 200 && d.status < 300 ? "default" : "destructive"} className="text-[10px]">{d.method}</Badge>
                          <span className="font-mono text-muted-foreground">{d.url}</span>
                          <Badge variant={d.status >= 200 && d.status < 300 ? "default" : "destructive"} className="text-[10px]">HTTP {d.status}</Badge>
                        </div>
                        <pre className="whitespace-pre-wrap text-[11px] text-muted-foreground max-h-24 overflow-auto">{d.body}</pre>
                      </div>
                    ))}
                  </div>
                )}

                {hook.testStatus === "error" && hook.testError && !hook.diagnostics?.length && (
                  <p className="text-xs text-destructive">{hook.testError}</p>
                )}
              </div>
            </div>
          )}

          {/* Step 2: Sales Points */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Select Sales Points</h2>
                <p className="mt-1 text-sm text-muted-foreground">Choose which sales points to sync.</p>
              </div>
              {hook.salesPoints.length === 0 ? (
                <div className="text-center py-8">
                  <Store className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">No sales points found. They were loaded during connection test.</p>
                  <Button variant="secondary" size="sm" className="mt-3" onClick={hook.fetchSalesPoints}>
                    <RefreshCw className="mr-2 h-4 w-4" /> Refresh
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {hook.salesPoints.map((sp) => (
                    <label key={sp.id} className="flex items-center gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-secondary/30 transition-colors">
                      <Checkbox
                        checked={selectedSalesPointIds.includes(sp.id)}
                        onCheckedChange={(checked) => {
                          setSelectedSalesPointIds((prev) =>
                            checked ? [...prev, sp.id] : prev.filter((id) => id !== sp.id)
                          );
                        }}
                      />
                      <div>
                        <p className="text-sm font-medium text-foreground">{sp.name || sp.id}</p>
                        <p className="text-xs text-muted-foreground">ID: {sp.id}</p>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Sync Settings */}
          {step === 3 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Sync Settings</h2>
                <p className="mt-1 text-sm text-muted-foreground">Configure sync mode and frequency.</p>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">Sync Mode</label>
                  <div className="grid grid-cols-2 gap-3">
                    {(["WEBHOOKS", "POLLING"] as const).map((mode) => (
                      <button key={mode} onClick={() => setSyncMode(mode)} className={`rounded-lg border p-3 text-left transition-all ${syncMode === mode ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}>
                        <span className="text-sm font-medium text-foreground">{mode === "WEBHOOKS" ? "Webhooks" : "Polling"}</span>
                        <p className="mt-0.5 text-xs text-muted-foreground">{mode === "WEBHOOKS" ? "Real-time via HMAC-signed webhooks (recommended)" : "Periodic pull of documents"}</p>
                        {mode === "WEBHOOKS" && <Badge variant="default" className="mt-1 text-[10px]">Recommended</Badge>}
                      </button>
                    ))}
                  </div>
                </div>

                {syncMode === "WEBHOOKS" && webhookUrl && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                    <p className="text-xs font-medium text-foreground">Webhook URL</p>
                    <p className="text-xs text-muted-foreground">Paste this URL in your Cassa in Cloud admin → Webhooks configuration:</p>
                    <div className="flex gap-2">
                      <Input value={webhookUrl} readOnly className="bg-background font-mono text-xs flex-1" />
                      <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(webhookUrl); toast({ title: "Copied!" }); }}>Copy</Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">Signature header: <code className="text-foreground">x-cn-signature</code> (HMAC SHA-1)</p>
                  </div>
                )}

                {syncMode === "POLLING" && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-2 block">Poll Frequency</label>
                    <div className="flex gap-2">
                      {[5, 10, 15, 30, 60].map((f) => (
                        <button key={f} onClick={() => setFrequency(f)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${frequency === f ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                          {f} min
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 4: Backfill */}
          {step === 4 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Historical Backfill</h2>
                <p className="mt-1 text-sm text-muted-foreground">Import historical sales data.</p>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">Backfill Period</label>
                  <div className="flex gap-2">
                    {[7, 30, 90].map((d) => (
                      <button key={d} onClick={() => setBackfillDays(d)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${backfillDays === d ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                        Last {d} days
                      </button>
                    ))}
                  </div>
                </div>
                <Button variant="secondary" onClick={() => hook.runBackfill(backfillDays)} disabled={hook.backfilling} className="w-full">
                  {hook.backfilling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Calendar className="mr-2 h-4 w-4" />}
                  {hook.backfilling ? "Importing…" : `Import Last ${backfillDays} Days`}
                </Button>
                {hook.backfillResult && (
                  <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs space-y-1">
                    <p className="font-medium text-foreground flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> Backfill complete</p>
                    <p className="text-muted-foreground">{hook.backfillResult.totalSaved} documents, {hook.backfillResult.totalLines} line items.</p>
                    {hook.backfillResult.errors.length > 0 && (
                      <p className="text-muted-foreground">{hook.backfillResult.errors.length} errors (first: {hook.backfillResult.errors[0]})</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 5: Products */}
          {step === 5 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Product Catalog</h2>
                <p className="mt-1 text-sm text-muted-foreground">Sync the product catalog from Cassa in Cloud.</p>
              </div>
              <Button variant="secondary" onClick={hook.syncProducts} disabled={hook.syncingProducts} className="w-full">
                {hook.syncingProducts ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                {hook.syncingProducts ? "Syncing Products…" : "Sync Product Catalog"}
              </Button>
              {hook.productSyncResult && (
                <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs space-y-1">
                  <p className="font-medium text-foreground flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> Catalog synced</p>
                  <p className="text-muted-foreground">{hook.productSyncResult.totalProducts} products, {hook.productSyncResult.wineCandidates} wine candidates.</p>
                </div>
              )}
            </div>
          )}

          {/* Step 6: Go Live */}
          {step === 6 && (
            <div className="space-y-5 text-center">
              <div className="flex flex-col items-center gap-3">
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Power className="h-8 w-8 text-primary" />
                </div>
                <h2 className="text-lg font-semibold text-foreground">Ready to Go Live</h2>
                <p className="text-sm text-muted-foreground max-w-md">
                  Enable the connection to start syncing sales and products from Cassa in Cloud automatically.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/30 p-4 text-left space-y-2">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <span className="text-muted-foreground">Location</span>
                  <span className="font-medium text-foreground">{locationName || "—"}</span>
                  <span className="text-muted-foreground">Sync Mode</span>
                  <span className="font-medium text-foreground">{syncMode}</span>
                  <span className="text-muted-foreground">Sales Points</span>
                  <span className="font-medium text-foreground">{selectedSalesPointIds.length || "All"}</span>
                </div>
              </div>
              <Button
                onClick={async () => {
                  await hook.enableSync();
                  toast({ title: "Cassa in Cloud connection activated!" });
                  navigate("/integrations");
                }}
                className="w-full"
              >
                <Power className="mr-2 h-4 w-4" /> Activate Connection
              </Button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={() => setStep((s) => Math.max(s - 1, 1))} disabled={step === 1}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        {step < steps.length && (
          <Button onClick={handleNext} disabled={!canNext()}>
            Next <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
