import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Loader2, XCircle, Link2,
  Settings2, Power, Server, Eye, Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { useBdpConnection, BdpTestResult } from "@/hooks/useBdpConnection";

const steps = [
  { id: 1, label: "Connection", icon: Link2 },
  { id: 2, label: "Diagnostics", icon: Server },
  { id: 3, label: "Go Live", icon: Power },
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
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">BDP NET Connection</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter your BDP NET Weblink Rest API credentials and endpoint.
        </p>
      </div>
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

        {/* Raw diagnostics panel */}
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
        <Input
          placeholder="/api/v1/..."
          value={path}
          onChange={(e) => setPath(e.target.value)}
          className="bg-background font-mono text-sm flex-1"
        />
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

// ── Step 3: Go Live ──
function StepGoLive({ connectionId }: { connectionId: string | null }) {
  return (
    <div className="space-y-5 text-center py-8">
      <CheckCircle2 className="h-12 w-12 text-success mx-auto" />
      <h2 className="text-lg font-semibold text-foreground">BDP NET Connected</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        Your BDP NET connection is saved. Once the full integration is built out,
        sales pull and catalog sync will be available from this wizard.
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
  } = useBdpConnection();

  const [step, setStep] = useState(1);
  const [locationName, setLocationName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [port, setPort] = useState("");
  const [userKey, setUserKey] = useState("");
  const [password, setPassword] = useState("");
  const [exportProfileCode, setExportProfileCode] = useState("");

  // Load existing BDP connection on mount
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
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/integrations")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">Connect BDP NET</h1>
          <p className="text-xs text-muted-foreground">Weblink Rest API · España</p>
        </div>
      </div>

      {/* Step indicators */}
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

      {/* Content */}
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
              <StepGoLive connectionId={connectionId} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Navigation */}
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
