import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, CheckCircle2, XCircle, Loader2, Database, Globe, Info, Code, RefreshCw, Calendar, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useIcgConnection, IcgConnectionMode } from "@/hooks/useIcgConnection";

const STEPS = ["Connection Mode", "Credentials", "Test & Save", "Sales Sync"];

export default function IcgWizard() {
  const navigate = useNavigate();
  const icg = useIcgConnection();
  const [step, setStep] = useState(0);

  // Form fields
  const [locationName, setLocationName] = useState("");
  const [mode, setMode] = useState<IcgConnectionMode>("SQL_SERVER");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("1433");
  const [database, setDatabase] = useState("FrontRest");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Sales sync fields
  const [salesDay, setSalesDay] = useState(new Date().toISOString().slice(0, 10));
  const [backfillDays, setBackfillDays] = useState("30");
  const [showMappingEditor, setShowMappingEditor] = useState(false);
  const [mappingJson, setMappingJson] = useState("");

  useEffect(() => {
    icg.loadExistingConnection().then((conn) => {
      if (conn) {
        setLocationName(conn.location_name || "");
        const cfg = conn.provider_config as any;
        if (cfg) {
          setMode(cfg.connection_mode || "SQL_SERVER");
          setHost(cfg.host || "");
          setPort(cfg.port || "1433");
          setDatabase(cfg.database || "FrontRest");
          setUsername(cfg.db_username || "");
          setPassword(cfg.db_password || "");
        }
      }
    });
  }, []);

  // Load mapping when reaching step 3
  useEffect(() => {
    if (step === 3 && icg.connectionId) {
      icg.fetchSqlMapping();
    }
  }, [step, icg.connectionId]);

  // Sync mapping JSON editor with state
  useEffect(() => {
    if (icg.sqlMapping) {
      setMappingJson(JSON.stringify(icg.sqlMapping, null, 2));
    }
  }, [icg.sqlMapping]);

  const canAdvance = () => {
    if (step === 0) return true;
    if (step === 1) {
      if (mode === "SQL_SERVER") return locationName && host && port && database && username && password;
      return locationName;
    }
    if (step === 2) return icg.testStatus === "success";
    return true;
  };

  const handleTest = () => {
    icg.testConnection({ locationName, mode, host, port, database, username, password });
  };

  const handleSaveMappingJson = async () => {
    try {
      const parsed = JSON.parse(mappingJson);
      await icg.updateSqlMapping(parsed);
    } catch {
      // invalid JSON, ignore
    }
  };

  /* ── Step 0: Mode Selection ── */
  const stepMode = (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Connection Mode</h2>
        <p className="text-sm text-muted-foreground mt-1">
          ICG FrontRest supports two integration paths. Choose how to connect.
        </p>
      </div>

      <RadioGroup value={mode} onValueChange={(v) => setMode(v as IcgConnectionMode)} className="grid gap-4 sm:grid-cols-2">
        <label
          className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-all ${
            mode === "SQL_SERVER" ? "border-primary bg-primary/5 shadow-sm" : "border-border hover:border-primary/30"
          }`}
        >
          <RadioGroupItem value="SQL_SERVER" className="mt-1" />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <span className="font-medium text-sm text-foreground">SQL Server</span>
              <Badge variant="default" className="text-[10px]">Recommended</Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Direct read access to the FrontRest SQL Server database. Full sales, catalog and stock data.
            </p>
          </div>
        </label>

        <label
          className={`flex items-start gap-3 rounded-xl border p-4 cursor-not-allowed opacity-60 ${
            mode === "WEB_SERVICE" ? "border-primary bg-primary/5" : "border-border"
          }`}
        >
          <RadioGroupItem value="WEB_SERVICE" disabled className="mt-1" />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-sm text-muted-foreground">Web Service</span>
              <Badge variant="outline" className="text-[10px]">Coming Soon</Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              REST/SOAP endpoints provided by ICG partners (Sinqro, Ordatic). Not yet available.
            </p>
          </div>
        </label>
      </RadioGroup>
    </div>
  );

  /* ── Step 1: Credentials ── */
  const stepCredentials = (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">SQL Server Credentials</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Enter the SQL Server connection details for the FrontRest database.
        </p>
      </div>

      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-xs text-muted-foreground space-y-2">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Info className="h-4 w-4 text-primary" /> Pre-requisites
        </div>
        <ul className="list-disc ml-6 space-y-1">
          <li>SQL Server must allow TCP/IP connections on the configured port</li>
          <li>A read-only DB user is strongly recommended</li>
          <li>The firewall must allow inbound connections from our servers</li>
          <li>Default database name is usually <code className="bg-muted px-1 rounded">FrontRest</code></li>
        </ul>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label>Location Name</Label>
          <Input value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder="e.g. Restaurante Madrid Centro" />
        </div>
        <div>
          <Label>Host / IP</Label>
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.100 or db.example.com" />
        </div>
        <div>
          <Label>Port</Label>
          <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="1433" />
        </div>
        <div>
          <Label>Database Name</Label>
          <Input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="FrontRest" />
        </div>
        <div>
          <Label>Username</Label>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="sa or read-only user" />
        </div>
        <div className="sm:col-span-2">
          <Label>Password</Label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
      </div>
    </div>
  );

  /* ── Step 2: Test & Save ── */
  const stepTest = (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Test & Save Connection</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Verify that the SQL Server is reachable and the credentials are valid.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <span className="text-muted-foreground">Host</span>
          <span className="font-mono text-foreground">{host}:{port}</span>
          <span className="text-muted-foreground">Database</span>
          <span className="font-mono text-foreground">{database}</span>
          <span className="text-muted-foreground">User</span>
          <span className="font-mono text-foreground">{username}</span>
          <span className="text-muted-foreground">Mode</span>
          <span className="text-foreground">{mode}</span>
        </div>
      </div>

      <Button onClick={handleTest} disabled={icg.testStatus === "testing"} className="w-full">
        {icg.testStatus === "testing" ? (
          <><Loader2 className="h-4 w-4 animate-spin" /> Testing DB Connection…</>
        ) : (
          <><Database className="h-4 w-4" /> Test DB Connection</>
        )}
      </Button>

      {icg.testStatus === "success" && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 p-4 space-y-2">
          <div className="flex items-center gap-2 text-primary font-medium text-sm">
            <CheckCircle2 className="h-4 w-4" /> Connection successful
          </div>
          {icg.testResult?.version && (
            <p className="text-xs text-muted-foreground">SQL Server version: {icg.testResult.version}</p>
          )}
          {icg.testResult?.tables && icg.testResult.tables.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Found {icg.testResult.tables.length} FrontRest tables
            </p>
          )}
        </div>
      )}

      {icg.testStatus === "error" && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <div className="flex items-center gap-2 text-destructive font-medium text-sm">
            <XCircle className="h-4 w-4" /> Connection failed
          </div>
          <p className="text-xs text-muted-foreground mt-1">{icg.testError}</p>
        </div>
      )}
    </div>
  );

  /* ── Step 3: Sales Sync ── */
  const stepSales = (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Sales Sync</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure and preview SQL queries for sales extraction. A bridge agent is required to execute these against the on-prem SQL Server.
        </p>
      </div>

      {/* SQL Mapping Editor */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-foreground">Table / Field Mapping</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowMappingEditor(!showMappingEditor)}>
            <Code className="h-3 w-3" /> {showMappingEditor ? "Hide" : "Edit"}
          </Button>
        </div>

        {!showMappingEditor && icg.sqlMapping && (
          <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-2">
            <div className="grid grid-cols-2 gap-1">
              <span className="text-muted-foreground">Header table:</span>
              <span className="font-mono text-foreground">{icg.sqlMapping.sales_header.table}</span>
              <span className="text-muted-foreground">Line table:</span>
              <span className="font-mono text-foreground">{icg.sqlMapping.sales_line.table}</span>
              <span className="text-muted-foreground">Cursor field:</span>
              <span className="font-mono text-foreground">{icg.sqlMapping.incremental.cursor_field}</span>
              <span className="text-muted-foreground">Date field:</span>
              <span className="font-mono text-foreground">{icg.sqlMapping.incremental.date_field}</span>
            </div>
          </div>
        )}

        {showMappingEditor && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Edit the JSON mapping below. Changes are saved per connection and survive redeployments.
            </p>
            <Textarea
              value={mappingJson}
              onChange={(e) => setMappingJson(e.target.value)}
              className="font-mono text-xs h-48"
            />
            <Button size="sm" onClick={handleSaveMappingJson}>
              Save Mapping
            </Button>
          </div>
        )}

        {icg.loadingMapping && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading mapping…
          </div>
        )}
      </div>

      {/* Query Preview */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center gap-2">
          <Code className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Preview Queries</span>
        </div>
        <div className="flex gap-2">
          <Input
            type="date"
            value={salesDay}
            onChange={(e) => setSalesDay(e.target.value)}
            className="w-44"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => icg.previewQueries(salesDay)}
            disabled={icg.loadingQueryPreview}
          >
            {icg.loadingQueryPreview ? <Loader2 className="h-3 w-3 animate-spin" /> : <Code className="h-3 w-3" />}
            Preview SQL
          </Button>
        </div>

        {icg.queryPreview && (
          <div className="space-y-2">
            <div>
              <span className="text-xs font-medium text-muted-foreground">Header query:</span>
              <pre className="mt-1 rounded-lg bg-muted p-3 text-xs font-mono overflow-x-auto text-foreground">
                {icg.queryPreview.header}
              </pre>
            </div>
            <div>
              <span className="text-xs font-medium text-muted-foreground">Lines query:</span>
              <pre className="mt-1 rounded-lg bg-muted p-3 text-xs font-mono overflow-x-auto text-foreground">
                {icg.queryPreview.lines}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Fetch Sales */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Fetch Sales (Single Day)</span>
        </div>
        <div className="flex gap-2">
          <Input
            type="date"
            value={salesDay}
            onChange={(e) => setSalesDay(e.target.value)}
            className="w-44"
          />
          <Button
            size="sm"
            onClick={() => icg.fetchSales(salesDay)}
            disabled={icg.loadingSales}
          >
            {icg.loadingSales ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />}
            Fetch
          </Button>
        </div>

        {icg.salesPreview && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <p className="text-xs text-foreground">{icg.salesPreview.message}</p>
            {icg.salesPreview.generatedSQL && (
              <pre className="rounded bg-muted p-2 text-xs font-mono overflow-x-auto text-muted-foreground">
                {icg.salesPreview.generatedSQL}
              </pre>
            )}
            {icg.salesPreview.salesEvents.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {icg.salesPreview.salesEvents.length} events returned
              </p>
            )}
          </div>
        )}
      </div>

      {/* Incremental Sync */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-foreground">Incremental Sync</span>
          </div>
          <Button
            size="sm"
            onClick={() => icg.runIncrementalSync()}
            disabled={icg.incrementalSyncing}
          >
            {icg.incrementalSyncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Run Incremental
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Generates a query from the last synced ticket ID / closure date forward.
        </p>

        {icg.incrementalResult && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <p className="text-xs text-foreground">{icg.incrementalResult.message}</p>
            <div className="grid grid-cols-2 gap-1 text-xs">
              <span className="text-muted-foreground">Last ticket ID:</span>
              <span className="font-mono text-foreground">{icg.incrementalResult.cursor.last_ticket_id || "—"}</span>
              <span className="text-muted-foreground">Last close date:</span>
              <span className="font-mono text-foreground">{icg.incrementalResult.cursor.last_close_date || "—"}</span>
            </div>
            <pre className="rounded bg-muted p-2 text-xs font-mono overflow-x-auto text-muted-foreground">
              {icg.incrementalResult.generatedSQL}
            </pre>
          </div>
        )}
      </div>

      {/* Backfill */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Historical Backfill</span>
        </div>
        <div className="flex gap-2 items-center">
          <Input
            type="number"
            min="1"
            max="365"
            value={backfillDays}
            onChange={(e) => setBackfillDays(e.target.value)}
            className="w-24"
          />
          <span className="text-xs text-muted-foreground">days</span>
          <Button
            size="sm"
            onClick={() => icg.runBackfill(parseInt(backfillDays) || 30)}
            disabled={icg.backfilling}
          >
            {icg.backfilling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />}
            Generate Backfill
          </Button>
        </div>

        {icg.backfillResult && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <p className="text-xs text-foreground">{icg.backfillResult.message}</p>
            <p className="text-xs text-muted-foreground">
              {icg.backfillResult.queriesGenerated} queries for {icg.backfillResult.daysBack} days
            </p>
            {icg.backfillResult.sampleQuery && (
              <div>
                <span className="text-xs text-muted-foreground">Sample query (day 1):</span>
                <pre className="mt-1 rounded bg-muted p-2 text-xs font-mono overflow-x-auto text-muted-foreground">
                  {icg.backfillResult.sampleQuery}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const stepsContent = [stepMode, stepCredentials, stepTest, stepSales];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/integrations")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">ICG FrontRest</h1>
          <p className="text-xs text-muted-foreground">On-prem POS — SQL Server integration</p>
        </div>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                i <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}
            >
              {i + 1}
            </div>
            <span className={`text-xs hidden sm:inline ${i <= step ? "text-foreground" : "text-muted-foreground"}`}>{s}</span>
            {i < STEPS.length - 1 && <div className="w-6 h-px bg-border" />}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="rounded-xl border bg-card p-6">{stepsContent[step]}</div>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!canAdvance()}>
            Next <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button onClick={() => navigate("/integrations")}>
            Finish
          </Button>
        )}
      </div>
    </div>
  );
}
