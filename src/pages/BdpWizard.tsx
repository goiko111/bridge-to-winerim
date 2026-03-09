import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle, Link2,
  Power, Server, Eye, Send, HelpCircle, ChevronDown, ChevronUp,
  Calendar, Download, RefreshCw, Database, Package, Upload, ShieldCheck,
  AlertTriangle, RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/hooks/use-toast";
import {
  useBdpConnection, BdpTestResult, BdpSalesEvent,
  BdpCatalogResult, BdpWriteResult, BdpVerifyResult,
} from "@/hooks/useBdpConnection";

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Diagnostics", icon: Server },
  { id: 3, label: "Sales Sync", icon: Database },
  { id: 4, label: "Catalog & Write", icon: Package },
  { id: 5, label: "Go Live", icon: Power },
];

// ── Step 1: Connection ──
function StepConnection({
  locationName, setLocationName,
  baseUrl, setBaseUrl,
  port, setPort,
  userKey, setUserKey,
  password, setPassword,
  exportProfileCode, setExportProfileCode,
  catalogProfileCode, setCatalogProfileCode,
  importProfileCode, setImportProfileCode,
  testStatus, testError, testResult,
  onTest,
}: {
  locationName: string; setLocationName: (v: string) => void;
  baseUrl: string; setBaseUrl: (v: string) => void;
  port: string; setPort: (v: string) => void;
  userKey: string; setUserKey: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  exportProfileCode: string; setExportProfileCode: (v: string) => void;
  catalogProfileCode: string; setCatalogProfileCode: (v: string) => void;
  importProfileCode: string; setImportProfileCode: (v: string) => void;
  testStatus: string; testError: string | null; testResult: BdpTestResult | null;
  onTest: () => void;
}) {
  const [showHelper, setShowHelper] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
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
        <button onClick={() => setShowHelper(!showHelper)} className="flex w-full items-center justify-between px-4 py-3 text-left">
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
              <li>Create or verify a <span className="font-semibold text-foreground">User Key</span> and <span className="font-semibold text-foreground">Password</span> with read/write permissions.</li>
              <li>Go to <span className="font-semibold text-foreground">Configuración → Exportación → Plantillas</span> and create export templates as needed.</li>
              <li>Optionally create an <strong>import template</strong> for writing products back to BDP.</li>
            </ol>
            <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
              <p className="text-[11px] text-primary font-medium mb-0.5">💡 Tip</p>
              <p className="text-[11px] text-muted-foreground">
                You can use separate template codes for sales export, catalog export, and product import. If left blank, the main Export Profile Code is used as fallback.
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
            { key: "loginRequired" as const, label: "User Key & Password created with read/write permissions" },
            { key: "exportTemplateExists" as const, label: "Export template (WEBLINK) exists in BDP" },
          ]).map((item) => (
            <label key={item.key} className="flex items-start gap-2.5 cursor-pointer group">
              <Checkbox checked={checks[item.key]} onCheckedChange={() => toggleCheck(item.key)} className="mt-0.5" />
              <span className={`text-xs leading-relaxed transition-colors ${checks[item.key] ? "text-foreground" : "text-muted-foreground"}`}>{item.label}</span>
            </label>
          ))}
        </div>
        {allChecked && (
          <div className="flex items-center gap-1.5 text-[11px] text-success font-medium">
            <CheckCircle2 className="h-3 w-3" /> All prerequisites verified
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
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Export Profile Code (Sales)</label>
          <Input placeholder="e.g. WINERIM_EXPORT" value={exportProfileCode} onChange={(e) => setExportProfileCode(e.target.value)} className="bg-background font-mono text-sm" />
          <p className="mt-1 text-[11px] text-muted-foreground">Primary template for sales document export.</p>
        </div>

        {/* Additional template codes */}
        <div className="rounded-lg border border-border bg-muted/20">
          <button onClick={() => setShowTemplates(!showTemplates)} className="flex w-full items-center justify-between px-4 py-2.5 text-left">
            <span className="text-xs font-medium text-foreground">Additional Template Codes (optional)</span>
            {showTemplates ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
          </button>
          {showTemplates && (
            <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Catalog Profile Code</label>
                <Input placeholder="Defaults to Export Profile Code" value={catalogProfileCode} onChange={(e) => setCatalogProfileCode(e.target.value)} className="bg-background font-mono text-sm" />
                <p className="mt-1 text-[11px] text-muted-foreground">Template for fetching articles/products catalog.</p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Import Profile Code</label>
                <Input placeholder="Defaults to Export Profile Code" value={importProfileCode} onChange={(e) => setImportProfileCode(e.target.value)} className="bg-background font-mono text-sm" />
                <p className="mt-1 text-[11px] text-muted-foreground">Template for writing/importing products back to BDP.</p>
              </div>
            </div>
          )}
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
              <Eye className="h-3.5 w-3.5" /> Raw Response Diagnostics
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded border border-border bg-card p-2">
                <span className="text-muted-foreground">Status</span>
                <p className={`font-mono font-bold ${testResult.success ? "text-success" : "text-destructive"}`}>{testResult.status} {testResult.statusText}</p>
              </div>
              <div className="rounded border border-border bg-card p-2">
                <span className="text-muted-foreground">Content-Type</span>
                <p className="font-mono truncate">{testResult.contentType || "—"}</p>
              </div>
              <div className="rounded border border-border bg-card p-2">
                <span className="text-muted-foreground">Result</span>
                <Badge variant={testResult.success ? "default" : "destructive"} className="text-[10px]">{testResult.success ? "OK" : "FAIL"}</Badge>
              </div>
            </div>
            {testResult.bodyPreview && (
              <div>
                <span className="text-[11px] text-muted-foreground">Body Preview (first 2 KB)</span>
                <pre className="mt-1 max-h-48 overflow-auto rounded border border-border bg-card p-2 text-[11px] font-mono text-foreground whitespace-pre-wrap break-all">{testResult.bodyPreview}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 2: Diagnostics (Discovery + Custom endpoint) ──
function StepDiagnostics({
  connectionId, testCustomEndpoint, runDiscover, discovering, discoveryResult,
}: {
  connectionId: string | null;
  testCustomEndpoint: (path: string, method?: string) => Promise<any>;
  runDiscover: () => Promise<any>;
  discovering: boolean;
  discoveryResult: any;
}) {
  const [path, setPath] = useState("/api/v1/status");
  const [method, setMethod] = useState("GET");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [expandedFailure, setExpandedFailure] = useState<string | null>(null);

  const run = async () => {
    setLoading(true); setResult(null);
    const r = await testCustomEndpoint(path, method);
    setResult(r); setLoading(false);
  };

  const roleColors: Record<string, string> = {
    auth: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    sales: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    catalog: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    write: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">API Discovery & Diagnostics</h2>
        <p className="mt-1 text-sm text-muted-foreground">Auto-detect BDP capabilities with retry/backoff. Discovered routes are persisted per connection.</p>
      </div>

      {/* Auto-discovery */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Server className="h-3.5 w-3.5" /> Endpoint Discovery
        </p>
        <p className="text-xs text-muted-foreground">Probes auth, sales, catalog, and write endpoints with automatic retry (2 retries, exponential backoff).</p>
        <Button onClick={runDiscover} disabled={discovering || !connectionId} variant="secondary" size="sm">
          {discovering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Server className="mr-2 h-4 w-4" />}
          {discovering ? "Discovering…" : "Run Discovery"}
        </Button>
        {discoveryResult && (
          <div className="space-y-3">
            {/* Endpoint grid */}
            <div className="space-y-2">
              {discoveryResult.endpoints && Object.entries(discoveryResult.endpoints).map(([key, val]: [string, any]) => (
                <div key={key} className={`rounded-lg border p-3 text-xs ${val.ok ? "border-success/30 bg-success/5" : val.critical ? "border-destructive/30 bg-destructive/5" : "border-border bg-card"}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {val.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" /> : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
                      <span className="font-medium text-foreground">{val.label || key}</span>
                      <Badge variant="outline" className={`text-[9px] ${roleColors[val.role] || "border-border"}`}>{val.role}</Badge>
                      {val.critical && <Badge variant="outline" className="text-[9px] border-destructive/30 text-destructive">required</Badge>}
                    </div>
                    <div className="flex items-center gap-2">
                      {val.attempts > 1 && (
                        <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                          <RotateCcw className="h-2.5 w-2.5" /> {val.attempts} tries
                        </span>
                      )}
                      <Badge variant={val.ok ? "default" : "destructive"} className="text-[10px]">
                        {val.ok ? `${val.status} OK` : val.status || "FAIL"}
                      </Badge>
                    </div>
                  </div>
                  <p className="font-mono text-[10px] text-muted-foreground mt-1 truncate">{val.path}</p>
                  {/* Show body preview on failure */}
                  {!val.ok && (val.bodyPreview || val.lastError) && (
                    <div className="mt-2">
                      <button
                        onClick={() => setExpandedFailure(expandedFailure === key ? null : key)}
                        className="flex items-center gap-1 text-[10px] text-destructive hover:underline"
                      >
                        <AlertTriangle className="h-2.5 w-2.5" />
                        {expandedFailure === key ? "Hide error details" : "Show error details"}
                      </button>
                      {expandedFailure === key && (
                        <div className="mt-1.5 space-y-1">
                          {val.lastError && <p className="text-[10px] text-destructive">{val.lastError}</p>}
                          {val.bodyPreview && (
                            <pre className="max-h-32 overflow-auto rounded border border-destructive/20 bg-destructive/5 p-2 text-[10px] font-mono text-foreground whitespace-pre-wrap break-all">{val.bodyPreview}</pre>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Capabilities summary */}
            {discoveryResult.capabilities && (
              <div className="rounded-lg border border-border bg-card p-3 text-xs space-y-2">
                <p className="font-medium text-foreground">Detected Capabilities</p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded border border-border bg-muted/30 p-2 text-center">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Sales</span>
                    <p className={`font-bold mt-0.5 ${discoveryResult.capabilities.canReadSales ? "text-success" : "text-destructive"}`}>
                      {discoveryResult.capabilities.canReadSales ? "YES" : "NO"}
                    </p>
                  </div>
                  <div className="rounded border border-border bg-muted/30 p-2 text-center">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Catalog</span>
                    <p className={`font-bold mt-0.5 ${discoveryResult.capabilities.canReadCatalog ? "text-success" : "text-muted-foreground"}`}>
                      {discoveryResult.capabilities.canReadCatalog ? "YES" : "NO"}
                    </p>
                  </div>
                  <div className="rounded border border-border bg-muted/30 p-2 text-center">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Write</span>
                    <p className={`font-bold mt-0.5 ${discoveryResult.capabilities.canWrite ? "text-success" : "text-muted-foreground"}`}>
                      {discoveryResult.capabilities.canWrite ? discoveryResult.capabilities.writeMode : "NO"}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Persisted routes */}
            {discoveryResult.discoveredRoutes && Object.keys(discoveryResult.discoveredRoutes).length > 0 && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs space-y-2">
                <p className="font-medium text-foreground flex items-center gap-1.5">
                  <Database className="h-3.5 w-3.5 text-primary" /> Persisted Routes
                </p>
                <p className="text-[10px] text-muted-foreground">These verified routes are saved to this connection and used for all subsequent operations.</p>
                <div className="space-y-1">
                  {Object.entries(discoveryResult.discoveredRoutes).map(([key, route]: [string, any]) => (
                    <div key={key} className="flex items-center justify-between rounded border border-primary/10 bg-background px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-3 w-3 text-success" />
                        <span className="font-medium text-foreground">{key}</span>
                        <span className="font-mono text-[10px] text-muted-foreground truncate max-w-[200px]">{route.path}</span>
                      </div>
                      <span className="text-[9px] text-muted-foreground">{new Date(route.verified_at).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Manual endpoint test */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Custom Endpoint Test</p>
        <div className="flex gap-2">
          <select value={method} onChange={(e) => setMethod(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm font-mono">
            <option>GET</option>
            <option>POST</option>
            <option>PUT</option>
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
              <pre className="max-h-64 overflow-auto rounded border border-border bg-card p-2 text-[11px] font-mono text-foreground whitespace-pre-wrap break-all">{result.bodyPreview}</pre>
            )}
            {result.message && !result.bodyPreview && <p className="text-sm text-destructive">{result.message}</p>}
          </div>
        )}
      </div>
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
          Fetch and persist BDP sales documents. BDP uses the <strong>closure day</strong> (cierre) as business day.
        </p>
      </div>

      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-1">
        <p className="text-[11px] text-primary font-semibold">📅 Business Day vs Ticket Time</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          BDP groups sales by <strong>closure day</strong> (ClosureDate). A ticket created at 23:45 may belong to the next day's closure.
          The raw ticket timestamp is stored separately so you can always reconcile.
        </p>
      </div>

      {/* Fetch & Preview */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Calendar className="h-3.5 w-3.5" /> Fetch Day Preview
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
                    <div><span className="text-muted-foreground">Business Day</span><p className="font-mono text-foreground">{evt.business_day}</p></div>
                    <div><span className="text-muted-foreground">Ticket Time</span><p className="font-mono text-foreground">{evt.ticket_time || "—"}</p></div>
                    <div><span className="text-muted-foreground">Total</span><p className="font-mono font-semibold text-foreground">€{evt.total_amount.toFixed(2)}</p></div>
                    <div><span className="text-muted-foreground">Lines</span><p className="font-mono text-foreground">{evt.line_count}</p></div>
                  </div>
                  {evt.lines.length > 0 && (
                    <div className="border-t border-border pt-1.5 mt-1.5">
                      <table className="w-full text-[10px]">
                        <thead><tr className="text-muted-foreground text-left">
                          <th className="py-0.5">Product</th><th className="py-0.5 text-right">Qty</th><th className="py-0.5 text-right">Price</th><th className="py-0.5 text-right">Total</th>
                        </tr></thead>
                        <tbody>
                          {evt.lines.slice(0, 5).map((l) => (
                            <tr key={l.line_index} className="text-foreground">
                              <td className="py-0.5 truncate max-w-[140px]">{l.name}</td>
                              <td className="py-0.5 text-right font-mono">{l.quantity}</td>
                              <td className="py-0.5 text-right font-mono">€{l.unit_price.toFixed(2)}</td>
                              <td className="py-0.5 text-right font-mono">€{l.total_amount.toFixed(2)}</td>
                            </tr>
                          ))}
                          {evt.lines.length > 5 && <tr><td colSpan={4} className="text-muted-foreground text-center py-0.5">+{evt.lines.length - 5} more</td></tr>}
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
            {saveResult.errors.length > 0 && <p className="text-destructive mt-1">{saveResult.errors.length} error(s): {saveResult.errors[0]}</p>}
          </div>
        )}
      </div>

      {/* Backfill */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5"><Download className="h-3.5 w-3.5" /> Backfill Historical Data</p>
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
            {backfillResult.errors.length > 0 && <p className="text-destructive">{backfillResult.errors.length} error(s)</p>}
          </div>
        )}
      </div>

      {/* Incremental */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5"><RefreshCw className="h-3.5 w-3.5" /> Incremental Sync</p>
        <p className="text-xs text-muted-foreground">Fetches all documents since the last synced business day until today.</p>
        <Button onClick={runIncrementalSync} disabled={incrementalSyncing || !connectionId} variant="secondary">
          {incrementalSyncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          {incrementalSyncing ? "Syncing…" : "Sync Now"}
        </Button>
        {incrementalResult && (
          <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-foreground space-y-0.5">
            <p>✅ {incrementalResult.savedEvents} events, {incrementalResult.savedLines} lines</p>
            <p className="text-muted-foreground">Range: {incrementalResult.dateRange.from} → {incrementalResult.dateRange.to}</p>
            {incrementalResult.errors.length > 0 && <p className="text-destructive">{incrementalResult.errors.length} error(s)</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 4: Catalog & Write ──
function StepCatalogWrite({
  connectionId,
  syncingCatalog, catalogResult, syncCatalog,
  writingProduct, writeResult, writeProduct,
  verifying, verifyResult, verifyProduct,
}: {
  connectionId: string | null;
  syncingCatalog: boolean;
  catalogResult: BdpCatalogResult | null;
  syncCatalog: () => Promise<void>;
  writingProduct: boolean;
  writeResult: BdpWriteResult | null;
  writeProduct: (p: any) => Promise<BdpWriteResult | null>;
  verifying: boolean;
  verifyResult: BdpVerifyResult | null;
  verifyProduct: (id: string) => Promise<BdpVerifyResult | null>;
}) {
  // Write form
  const [wName, setWName] = useState("");
  const [wPrice, setWPrice] = useState("");
  const [wVat, setWVat] = useState("10");
  const [wFamily, setWFamily] = useState("");
  const [wFormat, setWFormat] = useState("");
  const [wId, setWId] = useState("");

  // Verify
  const [verifyId, setVerifyId] = useState("");

  const handleWrite = async () => {
    if (!wName || !wPrice) return;
    const result = await writeProduct({
      provider_product_id: wId || undefined,
      name: wName,
      price: Number(wPrice),
      vat_rate: Number(wVat) || 0,
      family: wFamily || undefined,
      format: wFormat || undefined,
    });
    if (result?.success) {
      toast({ title: "Product written", description: `${wName} sent to BDP successfully.` });
      // Auto-verify after write
      if (wId) {
        setTimeout(() => verifyProduct(wId), 1500);
        setVerifyId(wId);
      }
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Catalog & Write</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sync the BDP product catalog and push new/updated products with price propagation and verification.
        </p>
      </div>

      {/* ── Catalog Sync ── */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5" /> Catalog Sync
        </p>
        <p className="text-xs text-muted-foreground">
          Fetches articles/products and departments/families from BDP. Uses the catalog profile code if configured, otherwise falls back to the export profile.
        </p>
        <Button onClick={syncCatalog} disabled={syncingCatalog || !connectionId} variant="secondary">
          {syncingCatalog ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          {syncingCatalog ? "Syncing Catalog…" : "Sync Catalog"}
        </Button>
        {catalogResult && (
          <div className="space-y-2">
            <div className={`rounded border p-2 text-xs ${catalogResult.success ? "border-success/30 bg-success/5 text-foreground" : "border-destructive/30 bg-destructive/5 text-destructive"}`}>
              {catalogResult.success ? (
                <>✅ {catalogResult.totalProducts} products synced ({catalogResult.upserted} upserted), {catalogResult.totalFamilies} families found</>
              ) : (
                <>❌ {catalogResult.message || "Catalog sync failed"}</>
              )}
              {catalogResult.errors.length > 0 && <p className="text-destructive mt-1">{catalogResult.errors.length} error(s)</p>}
            </div>
            {catalogResult.families.length > 0 && (
              <div>
                <p className="text-[11px] text-muted-foreground mb-1">Families / Departments:</p>
                <div className="flex flex-wrap gap-1">
                  {catalogResult.families.map((f) => (
                    <Badge key={f.id} variant="secondary" className="text-[10px]">{f.name || f.id}</Badge>
                  ))}
                </div>
              </div>
            )}
            {catalogResult.rawProductsPreview && (
              <div>
                <p className="text-[11px] text-muted-foreground">Raw Preview (first 2 KB)</p>
                <pre className="mt-1 max-h-32 overflow-auto rounded border border-border bg-card p-2 text-[10px] font-mono text-foreground whitespace-pre-wrap break-all">
                  {catalogResult.rawProductsPreview}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Write Product ── */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Upload className="h-3.5 w-3.5" /> Write / Update Product
        </p>
        <p className="text-xs text-muted-foreground">
          Create or update a product in BDP. Prices are propagated directly. Uses import profile code if configured.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Product ID (blank = new)</label>
            <Input placeholder="e.g. ART001" value={wId} onChange={(e) => setWId(e.target.value)} className="bg-background font-mono text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Name *</label>
            <Input placeholder="e.g. Rioja Reserva 2019" value={wName} onChange={(e) => setWName(e.target.value)} className="bg-background text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Price (€) *</label>
            <Input type="number" step="0.01" placeholder="25.00" value={wPrice} onChange={(e) => setWPrice(e.target.value)} className="bg-background font-mono text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">VAT %</label>
            <Input type="number" placeholder="10" value={wVat} onChange={(e) => setWVat(e.target.value)} className="bg-background font-mono text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Family / Department</label>
            <Input placeholder="e.g. Vinos Tintos" value={wFamily} onChange={(e) => setWFamily(e.target.value)} className="bg-background text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Format</label>
            <Input placeholder="e.g. BOT" value={wFormat} onChange={(e) => setWFormat(e.target.value)} className="bg-background font-mono text-sm" />
          </div>
        </div>
        <Button onClick={handleWrite} disabled={writingProduct || !connectionId || !wName || !wPrice}>
          {writingProduct ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
          {writingProduct ? "Writing…" : wId ? "Update Product" : "Create Product"}
        </Button>
        {writeResult && (
          <div className={`rounded border p-2 text-xs ${writeResult.success ? "border-success/30 bg-success/5 text-foreground" : "border-destructive/30 bg-destructive/5 text-destructive"}`}>
            {writeResult.success ? (
              <>✅ Product {writeResult.method === "create" ? "created" : writeResult.method === "import" ? "imported" : "updated"} — HTTP {writeResult.status}</>
            ) : (
              <>❌ {writeResult.message || `Write failed (HTTP ${writeResult.status})`}</>
            )}
            {writeResult.bodyPreview && (
              <pre className="mt-1 max-h-24 overflow-auto rounded border border-border bg-card p-1.5 text-[10px] font-mono whitespace-pre-wrap break-all">{writeResult.bodyPreview}</pre>
            )}
          </div>
        )}
      </div>

      {/* ── Verify Product ── */}
      <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" /> Post-Write Verification
        </p>
        <p className="text-xs text-muted-foreground">
          Confirm a product exists in BDP and has a valid price (&gt; 0), similar to Agora verification.
        </p>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground mb-1 block">Product ID to verify</label>
            <Input placeholder="e.g. ART001" value={verifyId} onChange={(e) => setVerifyId(e.target.value)} className="bg-background font-mono text-sm" />
          </div>
          <Button onClick={() => verifyProduct(verifyId)} disabled={verifying || !connectionId || !verifyId} variant="secondary" size="sm">
            {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            <span className="ml-1.5">Verify</span>
          </Button>
        </div>
        {verifyResult && (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded border border-border bg-card p-2">
                <span className="text-muted-foreground">Exists</span>
                <p className={`font-bold ${verifyResult.exists ? "text-success" : "text-destructive"}`}>
                  {verifyResult.exists ? "YES" : "NO"}
                </p>
              </div>
              <div className="rounded border border-border bg-card p-2">
                <span className="text-muted-foreground">Price Valid</span>
                <p className={`font-bold ${verifyResult.priceValid ? "text-success" : "text-destructive"}`}>
                  {verifyResult.priceValid ? `€${verifyResult.price?.toFixed(2)}` : verifyResult.exists ? "€0.00 ⚠️" : "—"}
                </p>
              </div>
              <div className="rounded border border-border bg-card p-2">
                <span className="text-muted-foreground">Name</span>
                <p className="font-mono truncate text-foreground">{verifyResult.name || "—"}</p>
              </div>
            </div>
            {verifyResult.exists && !verifyResult.priceValid && (
              <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                ⚠️ Product exists but price is 0 or missing. Update the price in BDP or re-push with a valid price.
              </div>
            )}
            {!verifyResult.exists && (
              <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                ⚠️ Product not found in BDP. The write may have failed or the product ID doesn't match.
              </div>
            )}
            {verifyResult.exists && verifyResult.priceValid && (
              <div className="rounded border border-success/30 bg-success/5 p-2 text-xs text-foreground">
                ✅ Product verified: exists with valid price.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 5: Go Live ──
function StepGoLive({ connectionId, onEnable }: { connectionId: string | null; onEnable: () => void }) {
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(false);

  const handleEnable = async () => {
    setEnabling(true);
    await onEnable();
    setEnabled(true);
    setEnabling(false);
  };

  return (
    <div className="space-y-5 text-center py-8">
      <CheckCircle2 className="h-12 w-12 text-success mx-auto" />
      <h2 className="text-lg font-semibold text-foreground">BDP NET Fully Connected</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        Your BDP NET connection is configured with sales sync, catalog sync, and product write capabilities.
        Enable automatic sync to start processing data.
      </p>
      {connectionId && (
        <p className="text-xs font-mono text-muted-foreground">Connection ID: {connectionId}</p>
      )}
      <Button onClick={handleEnable} disabled={enabling || enabled || !connectionId} className="mx-auto">
        {enabling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Power className="mr-2 h-4 w-4" />}
        {enabled ? "Sync Enabled ✓" : enabling ? "Enabling…" : "Enable Sync"}
      </Button>
    </div>
  );
}

// ── Main Wizard ──
export default function BdpWizard() {
  const navigate = useNavigate();
  const {
    connectionId, testStatus, testError, testResult,
    testConnection, testCustomEndpoint, loadExistingConnection,
    updateConnection, runDiscover, discovering, discoveryResult,
    salesEvents, loadingSales, fetchSales,
    savingSales, saveResult, saveSalesToDb,
    backfilling, backfillResult, runBackfill,
    incrementalSyncing, incrementalResult, runIncrementalSync,
    syncingCatalog, catalogResult, syncCatalog,
    writingProduct, writeResult, writeProduct,
    verifying, verifyResult, verifyProduct,
    verifyProductV2,
  } = useBdpConnection();

  const [step, setStep] = useState(1);
  const [locationName, setLocationName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [port, setPort] = useState("");
  const [userKey, setUserKey] = useState("");
  const [password, setPassword] = useState("");
  const [exportProfileCode, setExportProfileCode] = useState("");
  const [catalogProfileCode, setCatalogProfileCode] = useState("");
  const [importProfileCode, setImportProfileCode] = useState("");

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
        setCatalogProfileCode(cfg.catalog_profile_code || "");
        setImportProfileCode(cfg.import_profile_code || "");
      }
    });
  }, []);

  const handleTest = () => {
    testConnection({ locationName, baseUrl, port, userKey, password, exportProfileCode });
  };

  // Save template codes when advancing past step 1
  const handleAdvance = async () => {
    if (step === 1 && connectionId) {
      const cfg = {
        port, user_key: userKey, password,
        export_profile_code: exportProfileCode,
        catalog_profile_code: catalogProfileCode,
        import_profile_code: importProfileCode,
      };
      await updateConnection(connectionId, { provider_config: cfg });
    }
    setStep(step + 1);
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

      <div className="flex items-center gap-1 flex-wrap">
        {steps.map((s) => {
          const Icon = s.icon;
          const active = s.id === step;
          const done = s.id < step;
          return (
            <button
              key={s.id}
              onClick={() => { if (done || active) setStep(s.id); }}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
                active ? "bg-primary text-primary-foreground"
                  : done ? "bg-primary/10 text-primary cursor-pointer"
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
                catalogProfileCode={catalogProfileCode} setCatalogProfileCode={setCatalogProfileCode}
                importProfileCode={importProfileCode} setImportProfileCode={setImportProfileCode}
                testStatus={testStatus} testError={testError} testResult={testResult}
                onTest={handleTest}
              />
            )}
            {step === 2 && (
              <StepDiagnostics connectionId={connectionId} testCustomEndpoint={testCustomEndpoint} runDiscover={runDiscover} />
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
              <StepCatalogWrite
                connectionId={connectionId}
                syncingCatalog={syncingCatalog} catalogResult={catalogResult} syncCatalog={syncCatalog}
                writingProduct={writingProduct} writeResult={writeResult} writeProduct={writeProduct}
                verifying={verifying} verifyResult={verifyResult} verifyProduct={verifyProduct}
              />
            )}
            {step === 5 && <StepGoLive connectionId={connectionId} onEnable={async () => { if (connectionId) await updateConnection(connectionId, { enabled: true }); }} />}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex justify-between">
        <Button variant="outline" onClick={() => step > 1 ? setStep(step - 1) : navigate("/integrations")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {step === 1 ? "Back to Integrations" : "Previous"}
        </Button>
        {step < steps.length && (
          <Button onClick={handleAdvance} disabled={!canAdvance}>
            Next
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
