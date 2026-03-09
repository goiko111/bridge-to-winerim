import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle, Link2, Settings2,
  Power, Calendar, RefreshCw, Package, Download, Zap, ExternalLink, ShieldCheck,
  Webhook, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useRevoConnection } from "@/hooks/useRevoConnection";
import { useOutboundSync } from "@/hooks/useOutboundSync";

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Sync Mode", icon: Settings2 },
  { id: 3, label: "Webhooks", icon: Webhook },
  { id: 4, label: "Backfill", icon: Calendar },
  { id: 5, label: "Catalog", icon: Package },
  { id: 6, label: "Go Live", icon: Power },
];

export default function RevoWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState(1);

  const [locationName, setLocationName] = useState("");
  const [tenant, setTenant] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [clientToken, setClientToken] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [winerimApiToken, setWinerimApiToken] = useState("");

  const [syncMode, setSyncMode] = useState<"WEBHOOKS" | "POLLING">("WEBHOOKS");
  const [frequency, setFrequency] = useState(15);
  const [backfill, setBackfill] = useState(30);
  const [enabled, setEnabled] = useState(false);

  const {
    connectionId, setConnectionId,
    testStatus, testError, testConnection, updateConnection, loadConnection,
    salesEvents, loadingSales, fetchOrders,
    saving, saveResult, saveSalesToDb,
    syncingCatalog, catalogSyncResult, syncCatalog,
    backfilling, backfillResult, runBackfill,
    writeVerification, verifying, verifyWrite,
    depValidation, validatingDeps, validateWriteDeps,
    enableSync,
  } = useRevoConnection();

  const [verifyItemId, setVerifyItemId] = useState("");
  const [depCheckCategoryId, setDepCheckCategoryId] = useState("");
  const [depCheckPrice, setDepCheckPrice] = useState("");

  const outbound = useOutboundSync(connectionId);

  // Deep-link: load existing connection
  useEffect(() => {
    const connParam = searchParams.get("connection");
    if (connParam && !connectionId) {
      loadConnection(connParam).then((conn) => {
        if (conn) {
          setLocationName(conn.location_name);
          const parts = conn.api_token.split("|");
          setTenant(parts[0] || "");
          setAccessToken(parts[1] || "");
          setClientToken(parts[2] || "");
          setWebhookSecret(parts[3] || "");
          setWinerimApiToken(conn.winerim_api_token || "");
          setEnabled(conn.enabled);
          setCurrentStep(4);
        }
      });
    }
  }, [searchParams]);

  const webhookUrl = connectionId
    ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/revo-proxy/webhook`
    : "Save connection first to generate webhook URL";

  const handleNext = async () => {
    if (currentStep === 2 && connectionId) {
      await updateConnection(connectionId, {
        sync_mode: syncMode === "WEBHOOKS" ? "BIDIRECTIONAL" : "PULL_ONLY",
        sync_frequency_minutes: frequency,
        backfill_days: backfill,
        location_name: locationName || "New Location",
      });
    }
    setCurrentStep((s) => Math.min(steps.length, s + 1));
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <button onClick={() => navigate("/integrations")} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Integrations
      </button>

      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-lg">R</div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connect Revo XEF</h1>
          <p className="text-sm text-muted-foreground">Set up your Revo integration in a few steps.</p>
        </div>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-1">
        {steps.map((step, i) => {
          const isActive = step.id === currentStep;
          const isDone = step.id < currentStep;
          return (
            <div key={step.id} className="flex items-center gap-1 flex-1">
              <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-semibold transition-all ${isDone ? "bg-success text-success-foreground" : isActive ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>
                {isDone ? <CheckCircle2 className="h-3 w-3" /> : step.id}
              </div>
              <span className={`text-[10px] font-medium hidden lg:block ${isActive ? "text-foreground" : "text-muted-foreground"}`}>{step.label}</span>
              {i < steps.length - 1 && <div className={`h-px flex-1 ${isDone ? "bg-success" : "bg-border"}`} />}
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
                <p className="mt-1 text-sm text-muted-foreground">
                  Enter your Revo XEF credentials. You need: Tenant (account username), Bearer Access Token, and Integrator Client Token.
                </p>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Location Name</label>
                  <Input placeholder="e.g. Mi Restaurante" value={locationName} onChange={(e) => setLocationName(e.target.value)} className="bg-background text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Tenant (account username)</label>
                  <Input placeholder="e.g. mirestaurante" value={tenant} onChange={(e) => setTenant(e.target.value)} className="bg-background font-mono text-sm" />
                  <p className="mt-1 text-[11px] text-muted-foreground">El nombre de usuario de tu cuenta Revo.</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Access Token (Bearer)</label>
                  <Input type="password" placeholder="Token from Account Management" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} className="bg-background font-mono text-sm" />
                  <p className="mt-1 text-[11px] text-muted-foreground">Generado en el back-office de Revo: Account management → crear token.</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Client Token (Integrator)</label>
                  <Input type="password" placeholder="Token from Revo" value={clientToken} onChange={(e) => setClientToken(e.target.value)} className="bg-background font-mono text-sm" />
                  <p className="mt-1 text-[11px] text-muted-foreground">Solicitar a Revo: "Contact us to get your client-token".</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Winerim API Token</label>
                  <Input type="password" placeholder="Enter your Winerim API token" value={winerimApiToken} onChange={(e) => setWinerimApiToken(e.target.value)} className="bg-background font-mono text-sm" />
                </div>
                <Button
                  onClick={() => testConnection(tenant, accessToken, clientToken, webhookSecret, winerimApiToken)}
                  disabled={testStatus === "testing" || !tenant || !accessToken || !clientToken}
                  variant="secondary" className="w-full"
                >
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
          )}

          {/* ── Step 2: Sync Mode ── */}
          {currentStep === 2 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Sync Mode</h2>
                <p className="mt-1 text-sm text-muted-foreground">Choose how to receive sales data from Revo.</p>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">Mode</label>
                  <div className="grid grid-cols-2 gap-3">
                    {([
                      { id: "WEBHOOKS" as const, label: "Webhooks + Nightly", desc: "Real-time order events + nightly backfill reports" },
                      { id: "POLLING" as const, label: "Nightly Reports Only", desc: "Fetch reports/orders once per day (recommended for nightly closes)" },
                    ]).map((m) => (
                      <button key={m.id} onClick={() => setSyncMode(m.id)} className={`rounded-lg border p-3 text-left transition-all ${syncMode === m.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}>
                        <span className="text-sm font-medium text-foreground">{m.label}</span>
                        <p className="mt-0.5 text-xs text-muted-foreground">{m.desc}</p>
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
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
                  <p className="text-xs text-warning">
                    <strong>Note:</strong> Revo recommends running reports at night (after cash register closes). The business day depends on Revo's register opening time, not midnight.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 3: Webhooks ── */}
          {currentStep === 3 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Webhook Setup</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {syncMode === "WEBHOOKS"
                    ? "Configure webhooks for real-time order events."
                    : "Webhooks are optional in polling mode. You can skip this step."}
                </p>
              </div>
              <div className="space-y-4">
                <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
                  <p className="text-xs font-medium text-muted-foreground">1. Paste this URL into your Revo back-office (Accounts → Webhooks):</p>
                  <div className="flex items-center gap-2">
                    <Input value={webhookUrl} readOnly className="bg-background font-mono text-xs flex-1" />
                    <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(webhookUrl); }}>Copy</Button>
                  </div>
                  <p className="text-xs font-medium text-muted-foreground mt-3">2. Subscribe to these events:</p>
                  <div className="flex flex-wrap gap-1">
                    {["order.created", "order.updated", "order.closed", "order.deleted"].map((e) => (
                      <Badge key={e} variant="secondary" className="text-[10px] font-mono">{e}</Badge>
                    ))}
                  </div>
                  <p className="text-xs font-medium text-muted-foreground mt-3">3. Enter the Webhook Secret generated by Revo:</p>
                  <Input type="password" placeholder="Webhook secret from Revo" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} className="bg-background font-mono text-sm" />
                  {webhookSecret && connectionId && (
                    <Button variant="secondary" size="sm" onClick={async () => {
                      const parts = [tenant, accessToken, clientToken, webhookSecret].join("|");
                      await updateConnection(connectionId, { api_token: parts });
                    }}>
                      <CheckCircle2 className="mr-2 h-4 w-4" /> Save Webhook Secret
                    </Button>
                  )}
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">
                    Webhooks are verified using <code className="text-foreground">X-Revo-Hmac-SHA256</code> header with your webhook secret. Our middleware will validate every incoming event.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 4: Backfill ── */}
          {currentStep === 4 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Historical Backfill</h2>
                <p className="mt-1 text-sm text-muted-foreground">Pull the last {backfill} days of order history from Revo Reports.</p>
              </div>
              <Button variant="secondary" onClick={() => runBackfill(backfill)} disabled={backfilling} className="w-full">
                {backfilling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Calendar className="mr-2 h-4 w-4" />}
                {backfilling ? "Backfilling…" : `Backfill Last ${backfill} Days`}
              </Button>
              {backfillResult && (
                <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs space-y-1">
                  <p className="font-medium text-foreground flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-success" /> Backfill complete
                  </p>
                  <p className="text-muted-foreground">
                    {backfillResult.totalSaved} orders saved, {backfillResult.totalLines} line items.
                  </p>
                  {backfillResult.errors.length > 0 && (
                    <div className="mt-1 text-destructive">
                      {backfillResult.errors.slice(0, 5).map((e, i) => <p key={i}>{e}</p>)}
                    </div>
                  )}
                </div>
              )}
              <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
                <p className="text-xs font-medium text-muted-foreground">Test: Fetch a specific day</p>
                <div className="flex gap-2">
                  <Input type="date" defaultValue={new Date().toISOString().split("T")[0]} id="revo-test-day" className="bg-background text-sm flex-1" />
                  <Button variant="outline" size="sm" onClick={() => {
                    const input = document.getElementById("revo-test-day") as HTMLInputElement;
                    if (input?.value) fetchOrders(input.value);
                  }} disabled={loadingSales}>
                    {loadingSales ? <Loader2 className="h-4 w-4 animate-spin" /> : "Fetch"}
                  </Button>
                  {salesEvents.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => {
                      const input = document.getElementById("revo-test-day") as HTMLInputElement;
                      if (input?.value) saveSalesToDb(input.value);
                    }} disabled={saving}>
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    </Button>
                  )}
                </div>
                {salesEvents.length > 0 && (
                  <p className="text-xs text-muted-foreground">{salesEvents.length} orders found, {salesEvents.reduce((s, e) => s + e.line_count, 0)} line items.</p>
                )}
                {saveResult && (
                  <p className="text-xs text-success">Saved {saveResult.savedEvents} events, {saveResult.savedLines} lines.</p>
                )}
              </div>
            </div>
          )}

          {/* ── Step 5: Catalog ── */}
          {currentStep === 5 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Catalog Sync</h2>
                <p className="mt-1 text-sm text-muted-foreground">Fetch Groups, Categories, and Items from the Revo v2 Catalog API.</p>
              </div>
              <Button variant="secondary" onClick={syncCatalog} disabled={syncingCatalog} className="w-full">
                {syncingCatalog ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Package className="mr-2 h-4 w-4" />}
                {syncingCatalog ? "Syncing Catalog…" : "Sync Catalog Now"}
              </Button>
              {catalogSyncResult && (
                <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs space-y-1">
                  <p className="font-medium text-foreground flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-success" /> Catalog synced
                  </p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
                    <span className="text-muted-foreground">Groups</span>
                    <span className="font-mono text-foreground">{catalogSyncResult.groups}</span>
                    <span className="text-muted-foreground">Categories</span>
                    <span className="font-mono text-foreground">{catalogSyncResult.categories}</span>
                    <span className="text-muted-foreground">Products</span>
                    <span className="font-mono text-foreground">{catalogSyncResult.totalProducts}</span>
                    <span className="text-muted-foreground">Wine candidates</span>
                    <span className="font-mono text-success">{catalogSyncResult.wineCandidates}</span>
                  </div>
                </div>
              )}
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">
                  <strong>Important:</strong> In Revo, Items depend on Categories and Groups. 
                  To write products (Winerim → Revo), ensure the target Group/Category exist first.
                </p>
              </div>

              {/* Post-write verification */}
              <div className="space-y-3 border-t border-border pt-4">
                <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-primary" /> Post-Write Verification
                </h3>
                <p className="text-[11px] text-muted-foreground">Verify a created/updated item exists with correct price and category.</p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Revo Item ID (from upsert result)"
                    value={verifyItemId}
                    onChange={(e) => setVerifyItemId(e.target.value)}
                    className="bg-background text-sm flex-1 font-mono"
                  />
                  <Button size="sm" variant="outline" onClick={() => verifyWrite({ revo_item_id: verifyItemId })} disabled={verifying || !verifyItemId}>
                    {verifying ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <ShieldCheck className="mr-1.5 h-3 w-3" />}
                    Verify
                  </Button>
                </div>
                {writeVerification && (
                  <div className={`rounded-lg border p-3 text-xs space-y-2 ${writeVerification.success ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5"}`}>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-1.5">
                        {writeVerification.verified_exists ? <CheckCircle2 className="h-3 w-3 text-success" /> : <XCircle className="h-3 w-3 text-destructive" />}
                        <span className={writeVerification.verified_exists ? "text-success" : "text-destructive"}>Exists</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {writeVerification.verified_prices ? <CheckCircle2 className="h-3 w-3 text-success" /> : <XCircle className="h-3 w-3 text-destructive" />}
                        <span className={writeVerification.verified_prices ? "text-success" : "text-destructive"}>Price &gt; 0</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {writeVerification.verified_scope ? <CheckCircle2 className="h-3 w-3 text-success" /> : <XCircle className="h-3 w-3 text-destructive" />}
                        <span className={writeVerification.verified_scope ? "text-success" : "text-destructive"}>Scope</span>
                      </div>
                    </div>
                    {writeVerification.errors.length > 0 && (
                      <div className="space-y-1">
                        {writeVerification.errors.map((e, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-destructive">
                            <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                            <span><code className="bg-destructive/10 px-1 rounded text-[10px]">{e.code}</code> {e.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {writeVerification.warnings.length > 0 && (
                      <div className="space-y-1">
                        {writeVerification.warnings.map((w, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-warning">
                            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                            <span><code className="bg-warning/10 px-1 rounded text-[10px]">{w.code}</code> {w.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 6: Go Live ── */}
          {currentStep === 6 && (
            <div className="space-y-6 text-center py-4">
              <div className="flex justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                  <Power className="h-8 w-8 text-primary" />
                </div>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Ready to Go Live</h2>
                <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
                  Enable sync to start ingesting sales data from Revo XEF.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/30 p-4 text-left max-w-sm mx-auto space-y-2">
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Mode</span><span className="font-medium text-foreground">{syncMode === "WEBHOOKS" ? "Webhooks + Nightly" : "Nightly Reports"}</span></div>
                <div className="flex justify-between text-xs"><span className="text-muted-foreground">Backfill</span><span className="font-medium text-foreground">Last {backfill} days</span></div>
                {backfillResult && (
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground">Orders imported</span><span className="font-medium text-foreground">{backfillResult.totalSaved}</span></div>
                )}
                {catalogSyncResult && (
                  <>
                    <div className="border-t border-border pt-2 mt-2" />
                    <div className="flex justify-between text-xs"><span className="text-muted-foreground">Catalog products</span><span className="font-medium text-foreground">{catalogSyncResult.totalProducts}</span></div>
                    <div className="flex justify-between text-xs"><span className="text-muted-foreground">Wine candidates</span><span className="font-medium text-success">{catalogSyncResult.wineCandidates}</span></div>
                  </>
                )}
              </div>
              <Button size="lg" onClick={async () => { await enableSync(); setEnabled(true); setTimeout(() => navigate("/integrations"), 2000); }} className="shadow-glow">
                {enabled ? (<><CheckCircle2 className="mr-2 h-4 w-4" /> Sync Enabled — Redirecting…</>) : "Enable Sync"}
              </Button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={() => setCurrentStep((s) => Math.max(1, s - 1))} disabled={currentStep === 1}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Previous
        </Button>
        {currentStep < steps.length && (
          <Button onClick={handleNext} disabled={currentStep === 1 && testStatus !== "success"}>
            Next <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
