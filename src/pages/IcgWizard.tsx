import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, CheckCircle2, XCircle, Loader2, Database, Globe, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { useIcgConnection, IcgConnectionMode } from "@/hooks/useIcgConnection";

const STEPS = ["Connection Mode", "Credentials", "Test & Save"];

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

  const canAdvance = () => {
    if (step === 0) return true;
    if (step === 1) {
      if (mode === "SQL_SERVER") return locationName && host && port && database && username && password;
      return locationName;
    }
    return true;
  };

  const handleTest = () => {
    icg.testConnection({ locationName, mode, host, port, database, username, password });
  };

  /* ── Step 0: Mode Selection ── */
  const StepMode = () => (
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
  const StepCredentials = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">SQL Server Credentials</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Enter the SQL Server connection details for the FrontRest database.
        </p>
      </div>

      {/* Info panel */}
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
  const StepTest = () => (
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
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 space-y-2">
          <div className="flex items-center gap-2 text-green-600 font-medium text-sm">
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

  const steps = [<StepMode />, <StepCredentials />, <StepTest />];

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
      <div className="rounded-xl border bg-card p-6">{steps[step]}</div>

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
          <Button onClick={() => navigate("/integrations")} disabled={icg.testStatus !== "success"}>
            Finish
          </Button>
        )}
      </div>
    </div>
  );
}
