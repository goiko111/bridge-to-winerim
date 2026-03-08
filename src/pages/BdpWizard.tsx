import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle, Link2,
  Power, Server, Eye, Send, HelpCircle, ChevronDown, ChevronUp,
  Calendar, Download, RefreshCw, Database,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/hooks/use-toast";
import { useBdpConnection, BdpTestResult, BdpSalesEvent } from "@/hooks/useBdpConnection";

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Diagnostics", icon: Server },
  { id: 3, label: "Sales Sync", icon: Database },
  { id: 4, label: "Go Live", icon: Power },
];

// ── Step 1: Connection ──
function StepConnection({
  locationName, setLocationName,
  baseUrl, setBaseUrl,
  port, setPort,
  userKey, setUserKey,
  password, setPassword,
  exportProfileCode, setExportProfileCode,
  testStatus, testError, testResult,
  onTest,
}: {
  locationName: string; setLocationName: (v: string) => void;
  baseUrl: string; setBaseUrl: (v: string) => void;
  port: string; setPort: (v: string) => void;
  userKey: string; setUserKey: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  exportProfileCode: string; setExportProfileCode: (v: string) => void;
  testStatus: string; testError: string | null; testResult: BdpTestResult | null;
  onTest: () => void;
}) {
  const [showHelper, setShowHelper] = useState(false);
  const [checks, setChecks] = useState({
    portOpen: false,
    ipAny: false,
    loginRequired: false,
    exportTemplateExists: false,
  });

  const toggleCheck = (key: keyof typeof checks) => {
    setChecks((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const allChecked = Object.values(checks).every(Boolean);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">BDP NET Connection</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter your BDP NET Weblink Rest API credentials and endpoint.
        </p>
      </div>

      {/* Helper Panel */}
      <div className="rounded-lg border border-border bg-muted/20">
        <button
          onClick={() => setShowHelper(!showHelper)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <HelpCircle className="h-4 w-4 text-primary" />
            How to obtain these values
          </div>
          {showHelper ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>
        {showHelper && (
          <div className="border-t border-border px-4 pb-4 pt-3 space-y-4">
            <ol className="list-decimal list-inside space-y-2.5 text-xs text-muted-foreground leading-relaxed">
              <li>Open <span className="font-semibold text-foreground">BDP NET → Configuración → Servicio Web</span> and enable the REST API service.</li>
              <li>In the <span className="font-semibold text-foreground">Weblink Rest API</span> section, note the <span className="font-mono text-foreground">Base URL</span> and <span className="font-mono text-foreground">Port</span>.</li>
              <li>Create or verify a <span className="font-semibold text-foreground">User Key</span> and <span className="font-semibold text-foreground">Password</span> with read permissions.</li>
              <li>Go to <span className="font-semibold text-foreground">Configuración → Exportación → Plantillas</span> and create an export template named <span className="font-mono text-foreground">WEBLINK</span>.</li>
              <li>Copy the template <span className="font-semibold text-foreground">Code</span> and paste it below.</li>
            </ol>
            <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
              <p className="text-[11px] text-primary font-medium mb-0.5">💡 Tip</p>
              <p className="text-[11px] text-muted-foreground">
                Ensure the BDP server port is forwarded and the firewall allows external access. Use "IP ANY" to allow any origin IP.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Pre-flight Checklist */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Pre-flight Checklist</p>
        <div className="space-y-2">
          {([
            { key: "portOpen" as const, label: "Port is open in firewall (accessible from outside)" },
            { key: "ipAny" as const, label: 'IP filter set to "ANY" (or Winerim IP whitelisted)' },
            { key: "loginRequired" as const, label: "User Key & Password created with read permissions" },
            { key: "exportTemplateExists" as const, label: "Export template (WEBLINK) exists in BDP" },
          ]).map((item) => (
            <label key={item.key} className="flex items-start gap-2.5 cursor-pointer group">
              <Checkbox checked={checks[item.key]} onCheckedChange={() => toggleCheck(item.key)} className="mt-0.5" />
              <span className={`text-xs leading-relaxed transition-colors ${checks[item.key] ? "text-foreground" : "text-muted-foreground"}`}>
                {item.label}
              </span>
            </label>
          ))}
        </div>
        {allChecked && (
          <div className="flex items-center gap-1.5 text-[11px] text-success font-medium">
            <CheckCircle2 className="h-3 w-3" />
            All prerequisites verified
          </div>
        )}
      </div>

      {/* Form fields */}
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Location Name</label>
          <Input placeholder="e.g. Ristorante Roma" value={locationName} onChange={(e) => setLocationName(e.target.value)} className="bg-background text-sm" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Base URL</label>
            <Input placeholder="http://192.168.1.50" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="bg-background font-mono text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Port</label>
            <Input placeholder="8080" value={port} onChange={(e) => setPort(e.target.value)} className="bg-background font-mono text-sm" />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">User Key</label>
          <Input type="password" placeholder="BDP user key" value={userKey} onChange={(e) => setUserKey(e.target.value)} className="bg-background font-mono text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Password</label>
          <Input type="password" placeholder="BDP password" value={password} onChange={(e) => setPassword(e.target.value)} className="bg-background font-mono text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Export Profile Code</label>
          <Input placeholder="e.g. WINERIM_EXPORT" value={exportProfileCode} onChange={(e) => setExportProfileCode(e.target.value)} className="bg-background font-mono text-sm" />
          <p className="mt-1 text-[11px] text-muted-foreground">Profile code configured in BDP for data export.</p>
        </div>

        <Button onClick={onTest} disabled={testStatus === "testing" || !baseUrl || !userKey} variant="secondary" className="w-full">
          {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {testStatus === "success" && <CheckCircle2 className="mr-2 h-4 w-4 text-success" />}
          {testStatus === "error" && <XCircle className="mr-2 h-4 w-4 text-destructive" />}
          {testStatus === "idle" && "Test Connection"}
          {testStatus === "testing" && "Testing…"}
          {testStatus === "success" && "Connection Successful"}
          {testStatus === "error" && (testError ? testError.substring(0, 60) : "Connection Failed")}
        </Button>

        {testResult && (
          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-foreground">
              <Eye className="h-3.5 w-3.5" />
              Raw Response Diagnostics
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded border border-border bg-card p-2">
                <span className="text-muted-foreground">Status</span>
                <p className={`font-mono font-bold ${testResult.success ? "text-success" : "text-destructive"}`}>
                  {testResult.status} {testResult.statusText}
                </p>
              </div>
              <div className="rounded border border-border bg-card p-2">
                <span className="text-muted-foreground">Content-Type</span>
                <p className="font-mono truncate">{testResult.contentType || "—"}</p>
              </div>
              <div className="rounded border border-border bg-card p-2">
                <span className="text-muted-foreground">Result</span>
                <Badge variant={testResult.success ? "default" : "destructive"} className="text-[10px]">
                  {testResult.success ? "OK" : "FAIL"}
                </Badge>
              </div>
            </div>
            {testResult.bodyPreview && (
              <div>
                <span className="text-[11px] text-muted-foreground">Body Preview (first 2 KB)</span>
                <pre className="mt-1 max-h-48 overflow-auto rounded border border-border bg-card p-2 text-[11px] font-mono text-foreground whitespace-pre-wrap break-all">
                  {testResult.bodyPreview}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 2: Diagnostics ──
function StepDiagnostics({
  connectionId, testCustomEndpoint,
}: {
  connectionId: string | null;
  testCustomEndpoint: (path: string, method?: string) => Promise<any>;
}) {
  const [path, setPath] = useState("/api/v1/status");
  const [method, setMethod] = useState("GET");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const run = async () => {
    setLoading(true);
    setResult(null);
    const r = await testCustomEndpoint(path, method);
    setResult(r);
    setLoading(false);
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">API Diagnostics</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Test any BDP endpoint to explore the API and verify access.
        </p>
      </div>
      <div className="flex gap-2">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        >
          <option>GET</option>
          <option>POST</option>
        </select>
        <Input placeholder="/api/v1/..." value={path} onChange={(e) => setPath(e.target.value)} className="bg-background font-mono text-sm flex-1" />
        <Button onClick={run} disabled={loading || !connectionId} size="sm">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>

      {result && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center gap-3 text-xs">
            <Badge variant={result.success ? "default" : "destructive"}>{result.status || "ERR"}</Badge>
            <span className="font-mono text-muted-foreground truncate">{result.url || ""}</span>
          </div>
          {result.bodyPreview && (
            <pre className="max-h-64 overflow-auto rounded border border-border bg-card p-2 text-[11px] font-mono text-foreground whitespace-pre-wrap break-all">
              {result.bodyPreview}
            </pre>
          )}
          {result.message && !result.bodyPreview && (
            <p className="text-sm text-destructive">{result.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Step 3: Sales Sync ──
function StepSalesSync({
  connectionId,
  salesEvents, loadingSales, fetchSales,
  savingSales, saveResult, saveSalesToDb,
  backfilling, backfillResult, runBackfill,
  incrementalSyncing, incrementalResult, runIncrementalSync,
}: {
  connectionId: string | null;
  salesEvents: BdpSalesEvent[];
  loadingSales: boolean;
  fetchSales: (day: string) => Promise<void>;
  savingSales: boolean;
  saveResult: { savedEvents: number; savedLines: number; errors: string[] } | null;
  saveSalesToDb: (day: string) => Promise<void>;
  backfilling: boolean;
  backfillResult: { totalSaved: number; totalLines: number; daysProcessed: number; errors: string[] } | null;
  runBackfill: (days?: number) => Promise<void>;
  incrementalSyncing: boolean;
  incrementalResult: { savedEvents: number; savedLines: number; dateRange: { from: string; to: string }; errors: string[] } | null;
  runIncrementalSync: () => Promise<void>;
}) {
  const today = new Date().toISOString().substring(0, 10);
  const [selectedDay, setSelectedDay] = useState(today);
  const [backfillDays, setBackfillDays] = useState("30");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Sales Sync</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Fetch and persist BDP sales documents. BDP uses the <strong>closure day</strong> (cierre) as business day — the actual ticket timestamp is preserved when available.
        </p>
      </div>

      {/* Info: business day vs ticket time */}
      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-1">
        <p className="text-[11px] text-primary font-semibold">📅 Business Day vs Ticket Time</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          BDP groups sales by <strong>closure day</strong> (ClosureDate). A ticket created at 23:45 may belong to the next day's closure.
          The raw ticket timestamp is stored separately so you can always reconcile.
        </p>
      </div>

      {/* ── Fetch & Preview single day ── */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Calendar className="h-3.5 w-3.5" />
          Fetch Day Preview
        </p>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground mb-1 block">Business Day</label>
            <Input type="date" value={selectedDay} onChange={(e) => setSelectedDay(e.target.value)} className="bg-background font-mono text-sm" />
          </div>
          <Button onClick={() => fetchSales(selectedDay)} disabled={loadingSales || !connectionId} variant="secondary" size="sm">
            {loadingSales ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            <span className="ml-1.5">Preview</span>
          </Button>
          <Button onClick={() => saveSalesToDb(selectedDay)} disabled={savingSales || !connectionId} size="sm">
            {savingSales ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            <span className="ml-1.5">Save</span>
          </Button>
        </div>

        {/* Preview results */}
        {salesEvents.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{salesEvents.length} document(s) found</p>
            <div className="max-h-64 overflow-auto space-y-2">
              {salesEvents.map((evt) => (
                <div key={evt.provider_doc_id} className="rounded border border-border bg-card p-3 space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-medium text-foreground">{evt.provider_doc_id}</span>
                    <Badge variant="secondary" className="text-[10px]">{evt.doc_type}</Badge>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-[11px]">
                    <div>
                      <span className="text-muted-foreground">Business Day</span>
                      <p className="font-mono text-foreground">{evt.business_day}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Ticket Time</span>
                      <p className="font-mono text-foreground">{evt.ticket_time || "—"}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Total</span>
                      <p className="font-mono font-semibold text-foreground">€{evt.total_amount.toFixed(2)}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Lines</span>
                      <p className="font-mono text-foreground">{evt.line_count}</p>
                    </div>
                  </div>
                  {evt.lines.length > 0 && (
                    <div className="border-t border-border pt-1.5 mt-1.5">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="text-muted-foreground text-left">
                            <th className="py-0.5">Product</th>
                            <th className="py-0.5 text-right">Qty</th>
                            <th className="py-0.5 text-right">Price</th>
                            <th className="py-0.5 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {evt.lines.slice(0, 5).map((l) => (
                            <tr key={l.line_index} className="text-foreground">
                              <td className="py-0.5 truncate max-w-[140px]">{l.name}</td>
                              <td className="py-0.5 text-right font-mono">{l.quantity}</td>
                              <td className="py-0.5 text-right font-mono">€{l.unit_price.toFixed(2)}</td>
                              <td className="py-0.5 text-right font-mono">€{l.total_amount.toFixed(2)}</td>
                            </tr>
                          ))}
                          {evt.lines.length > 5 && (
                            <tr><td colSpan={4} className="text-muted-foreground text-center py-0.5">+{evt.lines.length - 5} more lines</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {saveResult && (
          <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-foreground">
            ✅ Saved {saveResult.savedEvents} events, {saveResult.savedLines} lines
            {saveResult.errors.length > 0 && (
              <p className="text-destructive mt-1">{saveResult.errors.length} error(s): {saveResult.errors[0]}</p>
            )}
          </div>
        )}
      </div>

      {/* ── Backfill ── */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Download className="h-3.5 w-3.5" />
          Backfill Historical Data
        </p>
        <div className="flex gap-2 items-end">
          <div className="w-28">
            <label className="text-xs text-muted-foreground mb-1 block">Days Back</label>
            <Input type="number" value={backfillDays} onChange={(e) => setBackfillDays(e.target.value)} min="1" max="365" className="bg-background font-mono text-sm" />
          </div>
          <Button onClick={() => runBackfill(Number(backfillDays) || 30)} disabled={backfilling || !connectionId} variant="secondary">
            {backfilling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            {backfilling ? "Backfilling…" : "Run Backfill"}
          </Button>
        </div>
        {backfillResult && (
          <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-foreground space-y-0.5">
            <p>✅ {backfillResult.totalSaved} events, {backfillResult.totalLines} lines across {backfillResult.daysProcessed} days</p>
            {backfillResult.errors.length > 0 && (
              <p className="text-destructive">{backfillResult.errors.length} error(s)</p>
            )}
          </div>
        )}
      </div>

      {/* ── Incremental Sync ── */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          Incremental Sync
        </p>
        <p className="text-xs text-muted-foreground">
          Fetches all documents since the last synced business day until today.
        </p>
        <Button onClick={runIncrementalSync} disabled={incrementalSyncing || !connectionId} variant="secondary">
          {incrementalSyncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          {incrementalSyncing ? "Syncing…" : "Sync Now"}
        </Button>
        {incrementalResult && (
          <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-foreground space-y-0.5">
            <p>✅ {incrementalResult.savedEvents} events, {incrementalResult.savedLines} lines</p>
            <p className="text-muted-foreground">Range: {incrementalResult.dateRange.from} → {incrementalResult.dateRange.to}</p>
            {incrementalResult.errors.length > 0 && (
              <p className="text-destructive">{incrementalResult.errors.length} error(s)</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 4: Go Live ──
function StepGoLive({ connectionId }: { connectionId: string | null }) {
  return (
    <div className="space-y-5 text-center py-8">
      <CheckCircle2 className="h-12 w-12 text-success mx-auto" />
      <h2 className="text-lg font-semibold text-foreground">BDP NET Connected</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        Your BDP NET connection is configured with sales sync. Enable automatic sync or continue using manual backfill/incremental sync.
      </p>
      {connectionId && (
        <p className="text-xs font-mono text-muted-foreground">Connection ID: {connectionId}</p>
      )}
    </div>
  );
}

// ── Main Wizard ──
export default function BdpWizard() {
  const navigate = useNavigate();
  const {
    connectionId, testStatus, testError, testResult,
    testConnection, testCustomEndpoint, loadExistingConnection,
    updateConnection,
    salesEvents, loadingSales, fetchSales,
    savingSales, saveResult, saveSalesToDb,
    backfilling, backfillResult, runBackfill,
    incrementalSyncing, incrementalResult, runIncrementalSync,
  } = useBdpConnection();

  const [step, setStep] = useState(1);
  const [locationName, setLocationName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [port, setPort] = useState("");
  const [userKey, setUserKey] = useState("");
  const [password, setPassword] = useState("");
  const [exportProfileCode, setExportProfileCode] = useState("");

  useEffect(() => {
    loadExistingConnection().then((conn) => {
      if (conn) {
        setLocationName(conn.location_name || "");
        setBaseUrl(conn.base_url || "");
        const cfg = (conn as any).provider_config || {};
        setPort(cfg.port || "");
        setUserKey(cfg.user_key || "");
        setPassword(cfg.password || "");
        setExportProfileCode(cfg.export_profile_code || "");
      }
    });
  }, []);

  const handleTest = () => {
    testConnection({ locationName, baseUrl, port, userKey, password, exportProfileCode });
  };

  const canAdvance = step === 1 ? testStatus === "success" : true;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/integrations")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connect BDP NET</h1>
          <p className="text-xs text-muted-foreground">Weblink Rest API · España</p>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {steps.map((s) => {
          const Icon = s.icon;
          const active = s.id === step;
          const done = s.id < step;
          return (
            <button
              key={s.id}
              onClick={() => { if (done || active) setStep(s.id); }}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
                active
                  ? "bg-primary text-primary-foreground"
                  : done
                  ? "bg-primary/10 text-primary cursor-pointer"
                  : "bg-secondary text-muted-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {s.label}
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-border bg-card shadow-card p-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
          >
            {step === 1 && (
              <StepConnection
                locationName={locationName} setLocationName={setLocationName}
                baseUrl={baseUrl} setBaseUrl={setBaseUrl}
                port={port} setPort={setPort}
                userKey={userKey} setUserKey={setUserKey}
                password={password} setPassword={setPassword}
                exportProfileCode={exportProfileCode} setExportProfileCode={setExportProfileCode}
                testStatus={testStatus} testError={testError} testResult={testResult}
                onTest={handleTest}
              />
            )}
            {step === 2 && (
              <StepDiagnostics connectionId={connectionId} testCustomEndpoint={testCustomEndpoint} />
            )}
            {step === 3 && (
              <StepSalesSync
                connectionId={connectionId}
                salesEvents={salesEvents} loadingSales={loadingSales} fetchSales={fetchSales}
                savingSales={savingSales} saveResult={saveResult} saveSalesToDb={saveSalesToDb}
                backfilling={backfilling} backfillResult={backfillResult} runBackfill={runBackfill}
                incrementalSyncing={incrementalSyncing} incrementalResult={incrementalResult} runIncrementalSync={runIncrementalSync}
              />
            )}
            {step === 4 && (
              <StepGoLive connectionId={connectionId} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex justify-between">
        <Button variant="outline" onClick={() => step > 1 ? setStep(step - 1) : navigate("/integrations")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {step === 1 ? "Back to Integrations" : "Previous"}
        </Button>
        {step < steps.length && (
          <Button onClick={() => setStep(step + 1)} disabled={!canAdvance}>
            Next
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
