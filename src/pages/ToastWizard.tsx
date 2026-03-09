import { useEffect, useState } from "react";
import { getToastConfig } from "@/utils/providerConfig";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, XCircle, Loader2,
  Settings2, ShieldCheck, Globe, Download, Utensils, Bell,
  HelpCircle, Activity, BarChart3, Zap, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToastConnection, ToastSyncMode } from "@/hooks/useToastConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";

const STEPS = [
  "Connection", "Preflight", "Scopes", "Sales Sync",
  "Business Date", "Menus", "Webhooks", "Webhook Guide",
  "Resilience",
];
const STEP_ICONS = [Settings2, ShieldCheck, ShieldCheck, Download, Globe, Utensils, Bell, HelpCircle, Activity];

type HealthLevel = "green" | "amber" | "red";

export default function ToastWizard() {
  const navigate = useNavigate();
  const toast = useToastConnection();
  const [step, setStep] = useState(0);

  // Connection fields
  const [locationName, setLocationName] = useState("");
  const [apiHostname, setApiHostname] = useState("https://ws-api.toasttab.com");
  const [restaurantGuid, setRestaurantGuid] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [closeoutHour, setCloseoutHour] = useState(4);
  const [syncMode, setSyncMode] = useState<ToastSyncMode>("DATE_RANGE");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookConfigured, setWebhookConfigured] = useState(false);
  const [healthChecking, setHealthChecking] = useState(false);

  // Sync params
  const [startDate, setStartDate] = useState(() => new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [businessDate, setBusinessDate] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    toast.loadExistingConnection().then((conn) => {
      if (conn) {
        setLocationName(conn.location_name || "");
        setApiHostname(conn.base_url || "https://ws-api.toasttab.com");
        setRestaurantGuid((conn as any).restaurant_guid || "");
        const cfg = getToastConfig(conn.provider_config);
        setTimezone(cfg.timezone || "America/New_York");
        setCloseoutHour(cfg.closeout_hour ?? 4);
        setSyncMode(cfg.sync_mode || "DATE_RANGE");
        setWebhookConfigured(Boolean(cfg.webhook_secret));
      }
    });
  }, []);

  useEffect(() => {
    if (toast.connectionId && step === 8) toast.loadSyncStatus();
    if (toast.connectionId && step === 6) toast.loadWebhookStatus();
  }, [step, toast.connectionId]);

  const handleSave = async () => {
    await toast.saveConnection({
      locationName, apiHostname, restaurantGuid,
      clientId, clientSecret, timezone, closeoutHour, syncMode, webhookSecret,
    });
    await toast.testConnection();
  };

  const renderStep = () => {
    switch (step) {
      // ── Step 0: Connection (T1 + T2) ──
      case 0:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-4 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Connect Toast POS</h3>

              {/* Helper panel */}
              <div className="rounded-lg bg-secondary/50 p-4 space-y-2">
                <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <HelpCircle className="h-3.5 w-3.5 text-primary" /> Before You Start
                </h4>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                  <li>You need <strong>RMS Essentials</strong> (or higher) plan</li>
                  <li>Your user must have <strong>Manage Integrations</strong> permission</li>
                  <li>Create credentials in <strong>Toast Web → Integrations → Toast API access</strong> (Standard API access)</li>
                  <li>Copy your <strong>Client ID</strong>, <strong>Client Secret</strong>, and <strong>Restaurant GUID</strong></li>
                </ul>
              </div>

              <div className="space-y-2">
                <Label>Location Name</Label>
                <Input value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder="My Restaurant" />
              </div>
              <div className="space-y-2">
                <Label>Toast API Hostname</Label>
                <Input value={apiHostname} onChange={(e) => setApiHostname(e.target.value)} />
                <p className="text-xs text-muted-foreground">Default: https://ws-api.toasttab.com</p>
              </div>
              <div className="space-y-2">
                <Label>Restaurant / Location GUID</Label>
                <Input value={restaurantGuid} onChange={(e) => setRestaurantGuid(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Client ID</Label>
                  <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Client Secret</Label>
                  <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
                </div>
              </div>

              <Button onClick={handleSave} disabled={!locationName || !restaurantGuid || !clientId || !clientSecret} className="w-full">
                {toast.testStatus === "testing" ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save & Test Connection
              </Button>
              {toast.testStatus === "success" && <div className="flex items-center gap-2 text-success text-sm"><CheckCircle2 className="h-4 w-4" /> Connected</div>}
              {toast.testStatus === "error" && <div className="flex items-center gap-2 text-destructive text-sm"><XCircle className="h-4 w-4" /> {toast.testError}</div>}
            </div>
          </div>
        );

      // ── Step 1: Preflight (T4) ──
      case 1:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Preflight Checks</h3>
              <p className="text-xs text-muted-foreground">Verify auth, fetch restaurant info, and detect timezone + closeout hour.</p>
              <Button onClick={() => toast.testConnection()} disabled={!toast.connectionId || toast.testStatus === "testing"}>
                {toast.testStatus === "testing" ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ShieldCheck className="h-4 w-4 mr-2" />}
                Run Preflight
              </Button>
              {toast.preflight && (
                <div className={`rounded p-3 text-xs ${toast.preflight.success ? "bg-success/10" : "bg-destructive/10"}`}>
                  <p className="font-medium">{toast.preflight.message}</p>
                  {toast.preflight.success && (
                    <div className="mt-2 space-y-1 text-foreground">
                      <div className="flex items-center gap-2"><CheckCircle2 className="h-3 w-3 text-success" /> Restaurant: <strong>{toast.preflight.restaurantName}</strong></div>
                      <div className="flex items-center gap-2"><CheckCircle2 className="h-3 w-3 text-success" /> Timezone: <strong>{toast.preflight.timezone}</strong></div>
                      <div className="flex items-center gap-2"><CheckCircle2 className="h-3 w-3 text-success" /> Closeout Hour: <strong>{toast.preflight.closeoutHour}:00</strong></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );

      // ── Step 2: Scopes (T5) ──
      case 2:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Scopes Checklist</h3>
              <p className="text-xs text-muted-foreground">Verify your credentials have the required API scopes.</p>
              <Button onClick={() => toast.checkScopes()} disabled={!toast.connectionId}>
                <ShieldCheck className="h-4 w-4 mr-2" /> Check Scopes
              </Button>
              {toast.scopeChecks.length > 0 && (
                <div className="space-y-2">
                  {toast.scopeChecks.map((s, i) => (
                    <div key={i} className="flex items-center justify-between rounded border border-border/50 p-2 text-xs">
                      <div className="flex items-center gap-2">
                        <code className="bg-secondary px-1.5 rounded">{s.scope}</code>
                        {s.required && <Badge variant="outline" className="text-[10px]">Required</Badge>}
                      </div>
                      <div className="flex items-center gap-1">
                        {s.status === "ok" && <><CheckCircle2 className="h-3 w-3 text-success" /><span className="text-success">OK</span></>}
                        {s.status === "missing" && <><XCircle className="h-3 w-3 text-destructive" /><span className="text-destructive">Missing</span></>}
                        {s.status === "unknown" && <span className="text-muted-foreground">Unknown</span>}
                      </div>
                    </div>
                  ))}
                  {toast.scopeChecks.some((s) => s.status === "missing" && s.required) && (
                    <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">
                      Missing required scopes. Update your Toast API credentials to include them.
                    </div>
                  )}
                </div>
              )}
              <div className="rounded bg-secondary/50 p-3 text-xs text-muted-foreground space-y-1">
                <p className="font-semibold text-foreground">Available Scopes:</p>
                <p>• <strong>orders:read</strong> — Required for sales sync</p>
                <p>• <strong>restaurants:read</strong> — Required for preflight</p>
                <p>• <strong>menus:read</strong> — Optional, for menu item matching</p>
                <p>• <strong>guest.pi:read</strong> — Optional, for guest details</p>
              </div>
            </div>
          </div>
        );

      // ── Step 3: Sales Sync by Date Range (T6) ──
      case 3:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Sales Sync (Date Range)</h3>
              <p className="text-xs text-muted-foreground">Pull orders using startDate/endDate with pagination.</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1"><Label className="text-xs">Start Date</Label><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">End Date</Label><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
              </div>
              <Button
                onClick={() => toast.syncSales("DATE_RANGE", { startDate: `${startDate}T00:00:00.000+0000`, endDate: `${endDate}T23:59:59.999+0000` })}
                disabled={toast.salesSyncing || !toast.connectionId}
              >
                {toast.salesSyncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
                Sync Orders
              </Button>
              {toast.salesResult && (
                <div className={`rounded p-3 text-xs ${toast.salesResult.success ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                  <p className="font-medium">{toast.salesResult.message}</p>
                  <div className="grid grid-cols-4 gap-2 mt-2 text-foreground">
                    <div><span className="font-semibold">{toast.salesResult.totalOrders}</span> orders</div>
                    <div><span className="font-semibold">{toast.salesResult.totalLines}</span> lines</div>
                    <div><span className="font-semibold">{toast.salesResult.duplicatesSkipped}</span> dupes</div>
                    <div><span className="font-semibold">{toast.salesResult.pagesProcessed}</span> pages</div>
                  </div>
                </div>
              )}
              {/* Polling sync diagnostics */}
              {toast.salesDiagnostics && (
                <div className="rounded border border-border/50 p-3 text-xs space-y-2">
                  <p className="font-semibold text-foreground flex items-center gap-1.5"><BarChart3 className="h-3 w-3 text-primary" /> Sync Diagnostics</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
                    <span>Mode:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.mode}</span>
                    <span>Timezone:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.timezone}</span>
                    <span>Closeout Hour:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.closeoutHour}:00</span>
                    {toast.salesDiagnostics.startDate && <><span>Start Date:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.startDate}</span></>}
                    {toast.salesDiagnostics.endDate && <><span>End Date:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.endDate}</span></>}
                    {toast.salesDiagnostics.businessDate && <><span>Business Date:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.businessDate}</span></>}
                    <span>Pages Processed:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.pagesProcessed}</span>
                    <span>Orders Fetched:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.totalOrdersFetched}</span>
                  </div>
                  {toast.salesDiagnostics.cursorSaved && (
                    <div className="mt-1 pt-1 border-t border-border/30">
                      <p className="text-muted-foreground mb-0.5">Last Cursor Saved:</p>
                      <pre className="bg-secondary/50 rounded p-1.5 text-[10px] text-foreground overflow-x-auto">{JSON.stringify(toast.salesDiagnostics.cursorSaved, null, 2)}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );

      // ── Step 4: Business Date mode (T7) ──
      case 4:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Sales Sync (Business Date)</h3>
              <div className="rounded bg-secondary/50 p-3 text-xs text-muted-foreground">
                <strong>Note:</strong> Business day depends on your restaurant's <strong>closeout hour ({closeoutHour}:00)</strong>.
                Orders after midnight but before closeout belong to the previous business day.
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Business Date (YYYY-MM-DD)</Label>
                <Input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
              </div>
              <Button
                onClick={() => toast.syncSales("BUSINESS_DATE", { businessDate: businessDate.replace(/-/g, "") })}
                disabled={toast.salesSyncing || !toast.connectionId}
              >
                {toast.salesSyncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
                Sync by Business Date
              </Button>
              {toast.salesResult && (
                <div className={`rounded p-3 text-xs ${toast.salesResult.success ? "bg-success/10" : "bg-destructive/10"}`}>
                  <p className="font-medium">{toast.salesResult.message}</p>
                  {toast.salesResult.success && (
                    <div className="grid grid-cols-4 gap-2 mt-2 text-foreground">
                      <div><span className="font-semibold">{toast.salesResult.totalOrders}</span> orders</div>
                      <div><span className="font-semibold">{toast.salesResult.totalLines}</span> lines</div>
                      <div><span className="font-semibold">{toast.salesResult.duplicatesSkipped}</span> dupes</div>
                      <div><span className="font-semibold">{toast.salesResult.pagesProcessed}</span> pages</div>
                    </div>
                  )}
                </div>
              )}
              {/* Polling sync diagnostics for business date mode */}
              {toast.salesDiagnostics && (
                <div className="rounded border border-border/50 p-3 text-xs space-y-2">
                  <p className="font-semibold text-foreground flex items-center gap-1.5"><BarChart3 className="h-3 w-3 text-primary" /> Sync Diagnostics</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
                    <span>Mode:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.mode}</span>
                    <span>Timezone:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.timezone}</span>
                    <span>Closeout Hour:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.closeoutHour}:00</span>
                    {toast.salesDiagnostics.businessDate && <><span>Business Date:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.businessDate}</span></>}
                    <span>Pages Processed:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.pagesProcessed}</span>
                    <span>Orders Fetched:</span><span className="text-foreground font-medium">{toast.salesDiagnostics.totalOrdersFetched}</span>
                  </div>
                  {toast.salesDiagnostics.cursorSaved && (
                    <div className="mt-1 pt-1 border-t border-border/30">
                      <p className="text-muted-foreground mb-0.5">Last Cursor Saved:</p>
                      <pre className="bg-secondary/50 rounded p-1.5 text-[10px] text-foreground overflow-x-auto">{JSON.stringify(toast.salesDiagnostics.cursorSaved, null, 2)}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );

      // ── Step 5: Menus (T9) ──
      case 5:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Menus Sync (Read-only)</h3>
              <p className="text-xs text-muted-foreground">Pull menu items from Toast Menus API V2 for matching. Requires <code>menus:read</code> scope.</p>
              <Button onClick={() => toast.syncMenus()} disabled={toast.menusSyncing || !toast.connectionId}>
                {toast.menusSyncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Utensils className="h-4 w-4 mr-2" />}
                Sync Menus
              </Button>
              {toast.menusResult && (
                <div className={`rounded p-3 text-xs ${toast.menusResult.success ? "bg-success/10" : "bg-destructive/10"}`}>
                  <p className="font-medium">{toast.menusResult.message}</p>
                  {toast.menusResult.success && (
                    <div className="mt-2 text-foreground">
                      {toast.menusResult.totalMenus} menus · {toast.menusResult.totalItems} items
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );

      // ── Step 6: Webhooks (T10) ──
      case 6:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Bell className="h-4 w-4 text-primary" /> Orders Webhook
              </h3>
              <p className="text-xs text-muted-foreground">Receive near real-time order updates via webhook. Payloads can exceed 600KB.</p>
              <div className="space-y-2">
                <Label className="text-xs">Webhook Secret (from Toast)</Label>
                <Input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="Paste your webhook secret" />
              </div>
              <div className="rounded bg-secondary/50 p-3 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground">Your Webhook URL:</p>
                <code className="block mt-1 break-all text-primary">
                  {`https://${import.meta.env.VITE_SUPABASE_PROJECT_ID || 'csiertktrefwewsmequr'}.supabase.co/functions/v1/toast-proxy?webhook=true`}
                </code>
              </div>
              {toast.webhookLastEvent && (
                <div className="flex items-center gap-2 text-xs text-success">
                  <CheckCircle2 className="h-3 w-3" /> Last event: {toast.webhookLastEvent}
                </div>
              )}
              <Button onClick={handleSave} variant="outline" className="w-full">Save Webhook Secret</Button>
            </div>
          </div>
        );

      // ── Step 7: Webhook Guide (T11) ──
      case 7:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-primary" /> Enable Toast Orders Webhook
              </h3>
              <div className="space-y-3">
                <ol className="text-xs text-muted-foreground space-y-2 list-decimal list-inside">
                  <li>Go to <strong>Toast Web → Integrations → Toast API access</strong></li>
                  <li>Select your API credentials (Standard API access)</li>
                  <li>Click <strong>Manage webhooks</strong></li>
                  <li>Add a new webhook subscription for <strong>Orders</strong></li>
                  <li>Paste the webhook URL from the previous step</li>
                  <li>If prompted for a secret, paste it and also enter it in the previous step</li>
                </ol>
                <div className="rounded bg-warning/10 p-3 text-xs text-warning">
                  <strong>Requirements:</strong>
                  <ul className="mt-1 space-y-0.5 list-disc list-inside">
                    <li>Manage Integrations permission</li>
                    <li>RMS Essentials+ per location linked to credentials</li>
                    <li>Webhooks only fire for locations linked to those credentials</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        );

      // ── Step 8: Resilience & Status (enhanced with cursor + webhook diagnostics) ──
      case 8:
        return (
          <div className="space-y-6">
            <ProviderReadinessPanel connectionId={toast.connectionId} provider="toast" />
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" /> Sync Status & Resilience
              </h3>
              <Button onClick={() => toast.loadSyncStatus()} disabled={!toast.connectionId} variant="outline">
                Refresh Status
              </Button>
              {toast.syncStatus && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded border border-border/50 p-3 space-y-1">
                      <p className="text-xs text-muted-foreground">Last Successful Sync</p>
                      <p className="text-sm font-medium text-foreground">{toast.syncStatus.lastSuccessfulSync || "Never"}</p>
                    </div>
                    <div className="rounded border border-border/50 p-3 space-y-1">
                      <p className="text-xs text-muted-foreground">Orders Processed</p>
                      <p className="text-sm font-medium text-foreground">{toast.syncStatus.ordersProcessed}</p>
                    </div>
                    <div className="rounded border border-border/50 p-3 space-y-1">
                      <p className="text-xs text-muted-foreground">New Orders (last hour)</p>
                      <p className="text-sm font-medium text-foreground">{toast.syncStatus.newOrders}</p>
                    </div>
                    <div className="rounded border border-border/50 p-3 space-y-1">
                      <p className="text-xs text-muted-foreground">Circuit Breaker</p>
                      <p className={`text-sm font-medium ${toast.syncStatus.circuitBreakerOpen ? "text-destructive" : "text-success"}`}>
                        {toast.syncStatus.circuitBreakerOpen ? `OPEN until ${toast.syncStatus.circuitBreakerUntil}` : "Closed (healthy)"}
                      </p>
                    </div>
                  </div>
                  {toast.syncStatus.lastError && (
                    <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">
                      Last Error: {toast.syncStatus.lastError}
                    </div>
                  )}

                  {/* Item 10: Last cursor diagnostics */}
                  {(toast.syncStatus.lastCursor || toast.syncStatus.timezone) && (
                    <div className="rounded border border-border/50 p-3 text-xs space-y-1">
                      <p className="font-semibold text-foreground flex items-center gap-1.5"><BarChart3 className="h-3 w-3 text-primary" /> Last Sync Cursor</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
                        {toast.syncStatus.timezone && <><span>Timezone:</span><span className="text-foreground font-medium">{toast.syncStatus.timezone}</span></>}
                        {toast.syncStatus.closeoutHour != null && <><span>Closeout Hour:</span><span className="text-foreground font-medium">{toast.syncStatus.closeoutHour}:00</span></>}
                        {toast.syncStatus.lastCursor && Object.entries(toast.syncStatus.lastCursor).map(([k, v]) => (
                          v != null ? <><span key={k}>{k}:</span><span className="text-foreground font-medium">{String(v)}</span></> : null
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Item 9: Webhook diagnostics */}
                  {toast.syncStatus.webhook && (
                    <div className="rounded border border-border/50 p-3 text-xs space-y-1">
                      <p className="font-semibold text-foreground flex items-center gap-1.5"><Zap className="h-3 w-3 text-primary" /> Webhook Diagnostics</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
                        <span>Last Event:</span><span className="text-foreground font-medium">{toast.syncStatus.webhook.lastEvent || "None"}</span>
                        <span>Last Status:</span><span className="text-foreground font-medium">{toast.syncStatus.webhook.lastStatus || "—"}</span>
                        <span>Total Events:</span><span className="text-foreground font-medium">{toast.syncStatus.webhook.totalEvents}</span>
                        <span>Processed:</span><span className="text-success font-medium">{toast.syncStatus.webhook.processedEvents}</span>
                        <span>Rejected:</span>
                        <span className={`font-medium ${toast.syncStatus.webhook.rejectedEvents > 0 ? "text-destructive" : "text-foreground"}`}>
                          {toast.syncStatus.webhook.rejectedEvents}
                        </span>
                        <span>Signature Mode:</span><span className="text-foreground font-medium">{toast.syncStatus.webhook.signatureEnforcement}</span>
                        {toast.syncStatus.webhook.lastSignatureFailure && (
                          <><span>Last Sig Failure:</span><span className="text-destructive font-medium">{new Date(toast.syncStatus.webhook.lastSignatureFailure).toLocaleString()}</span></>
                        )}
                        {toast.syncStatus.webhook.lastParseFailure && (
                          <><span>Last Parse Failure:</span><span className="text-destructive font-medium">{new Date(toast.syncStatus.webhook.lastParseFailure).toLocaleString()}</span></>
                        )}
                        {toast.syncStatus.webhook.lastSuccessfulEvent && (
                          <><span>Last Success:</span><span className="text-success font-medium">{new Date(toast.syncStatus.webhook.lastSuccessfulEvent).toLocaleString()}</span></>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="rounded bg-secondary/50 p-3 text-xs text-muted-foreground space-y-1">
                <p className="font-semibold text-foreground">Resilience Features:</p>
                <p>• Automatic retry with exponential backoff for 429/503</p>
                <p>• Respects Retry-After headers</p>
                <p>• Circuit breaker pauses sync after repeated failures (5 min cooldown)</p>
                <p>• HMAC signature verification for webhooks (when secret configured)</p>
                <p>• Payload size limit (2 MB) and parse error tracking</p>
                <p>• Strong dedupe by eventGuid + orderGuid</p>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/integrations")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connect Toast POS</h1>
          <p className="text-xs text-muted-foreground">Standard API access — sales, menus, webhooks</p>
        </div>
      </div>

      {/* Step navigation */}
      <div className="flex items-center gap-1 overflow-x-auto pb-2">
        {STEPS.map((s, i) => {
          const Icon = STEP_ICONS[i];
          const active = i === step;
          return (
            <button
              key={s}
              onClick={() => setStep(i)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {s}
            </button>
          );
        })}
      </div>

      {/* Step content */}
      {renderStep()}

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <Button onClick={() => setStep(Math.min(STEPS.length - 1, step + 1))} disabled={step === STEPS.length - 1}>
          Next <ArrowRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
