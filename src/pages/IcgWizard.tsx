import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, XCircle, Loader2, Database, Globe, Info,
  Code, RefreshCw, Calendar, Settings2, Package, ShieldCheck, ShieldAlert, Eye, Check, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useIcgConnection, IcgConnectionMode } from "@/hooks/useIcgConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";

const STEPS = ["Connection Mode", "Credentials", "Test & Save", "Sales Sync", "Catalog & Write", "Go Live"];

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

  // Write fields
  const [writeProductId, setWriteProductId] = useState("");
  const [writePrice, setWritePrice] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [verifyProductId, setVerifyProductId] = useState("");

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

  // Load mapping/catalog data when reaching steps
  useEffect(() => {
    if ((step === 3 || step === 4) && icg.connectionId) {
      icg.fetchSqlMapping();
    }
    if (step === 4 && icg.connectionId) {
      icg.previewCatalogQueries();
      icg.loadPendingWrites();
    }
  }, [step, icg.connectionId]);

  useEffect(() => {
    if (icg.sqlMapping) setMappingJson(JSON.stringify(icg.sqlMapping, null, 2));
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
    try { await icg.updateSqlMapping(JSON.parse(mappingJson)); } catch { /* invalid JSON */ }
  };

  /* ── Step 0: Mode Selection ── */
  const stepMode = (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Connection Mode</h2>
        <p className="text-sm text-muted-foreground mt-1">ICG FrontRest supports two integration paths.</p>
      </div>
      <RadioGroup value={mode} onValueChange={(v) => setMode(v as IcgConnectionMode)} className="grid gap-4 sm:grid-cols-2">
        <label className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-all ${mode === "SQL_SERVER" ? "border-primary bg-primary/5 shadow-sm" : "border-border hover:border-primary/30"}`}>
          <RadioGroupItem value="SQL_SERVER" className="mt-1" />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <span className="font-medium text-sm text-foreground">SQL Server</span>
              <Badge variant="default" className="text-[10px]">Recommended</Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">Direct read access to the FrontRest SQL Server database.</p>
          </div>
        </label>
        <label className="flex items-start gap-3 rounded-xl border p-4 cursor-not-allowed opacity-60 border-border">
          <RadioGroupItem value="WEB_SERVICE" disabled className="mt-1" />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-sm text-muted-foreground">Web Service</span>
              <Badge variant="outline" className="text-[10px]">Coming Soon</Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">REST/SOAP endpoints via ICG partners (Sinqro, Ordatic).</p>
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
        <p className="text-sm text-muted-foreground mt-1">Enter the SQL Server connection details for FrontRest.</p>
      </div>
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-xs text-muted-foreground space-y-2">
        <div className="flex items-center gap-2 font-medium text-foreground"><Info className="h-4 w-4 text-primary" /> Pre-requisites</div>
        <ul className="list-disc ml-6 space-y-1">
          <li>SQL Server must allow TCP/IP connections on the configured port</li>
          <li>A read-only DB user is strongly recommended</li>
          <li>The firewall must allow inbound connections from our servers</li>
          <li>Default database name is usually <code className="bg-muted px-1 rounded">FrontRest</code></li>
        </ul>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><Label>Location Name</Label><Input value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder="e.g. Restaurante Madrid Centro" /></div>
        <div><Label>Host / IP</Label><Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.100" /></div>
        <div><Label>Port</Label><Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="1433" /></div>
        <div><Label>Database Name</Label><Input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="FrontRest" /></div>
        <div><Label>Username</Label><Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="sa or read-only user" /></div>
        <div className="sm:col-span-2"><Label>Password</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></div>
      </div>
    </div>
  );

  /* ── Step 2: Test & Save ── */
  const stepTest = (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Test & Save Connection</h2>
        <p className="text-sm text-muted-foreground mt-1">Verify that the SQL Server is reachable.</p>
      </div>
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <span className="text-muted-foreground">Host</span><span className="font-mono text-foreground">{host}:{port}</span>
          <span className="text-muted-foreground">Database</span><span className="font-mono text-foreground">{database}</span>
          <span className="text-muted-foreground">User</span><span className="font-mono text-foreground">{username}</span>
          <span className="text-muted-foreground">Mode</span><span className="text-foreground">{mode}</span>
        </div>
      </div>
      <Button onClick={handleTest} disabled={icg.testStatus === "testing"} className="w-full">
        {icg.testStatus === "testing" ? <><Loader2 className="h-4 w-4 animate-spin" /> Testing…</> : <><Database className="h-4 w-4" /> Test DB Connection</>}
      </Button>
      {icg.testStatus === "success" && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 p-4 space-y-2">
          <div className="flex items-center gap-2 text-primary font-medium text-sm"><CheckCircle2 className="h-4 w-4" /> Connection successful</div>
          {icg.testResult?.message && <p className="text-xs text-muted-foreground">{icg.testResult.message}</p>}
        </div>
      )}
      {icg.testStatus === "error" && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <div className="flex items-center gap-2 text-destructive font-medium text-sm"><XCircle className="h-4 w-4" /> Connection failed</div>
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
        <p className="text-sm text-muted-foreground mt-1">Configure and preview SQL queries for sales extraction.</p>
      </div>

      {/* SQL Mapping Editor */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Settings2 className="h-4 w-4 text-primary" /><span className="text-sm font-medium text-foreground">Table / Field Mapping</span></div>
          <Button variant="ghost" size="sm" onClick={() => setShowMappingEditor(!showMappingEditor)}><Code className="h-3 w-3" /> {showMappingEditor ? "Hide" : "Edit"}</Button>
        </div>
        {!showMappingEditor && icg.sqlMapping && (
          <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-2">
            <div className="grid grid-cols-2 gap-1">
              <span className="text-muted-foreground">Header table:</span><span className="font-mono text-foreground">{icg.sqlMapping.sales_header.table}</span>
              <span className="text-muted-foreground">Line table:</span><span className="font-mono text-foreground">{icg.sqlMapping.sales_line.table}</span>
              <span className="text-muted-foreground">Product table:</span><span className="font-mono text-foreground">{icg.sqlMapping.catalog_product?.table || "—"}</span>
              <span className="text-muted-foreground">Family table:</span><span className="font-mono text-foreground">{icg.sqlMapping.catalog_family?.table || "—"}</span>
            </div>
          </div>
        )}
        {showMappingEditor && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Edit the JSON mapping. Changes saved per connection.</p>
            <Textarea value={mappingJson} onChange={(e) => setMappingJson(e.target.value)} className="font-mono text-xs h-48" />
            <Button size="sm" onClick={handleSaveMappingJson}>Save Mapping</Button>
          </div>
        )}
        {icg.loadingMapping && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</div>}
      </div>

      {/* Query Preview */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center gap-2"><Code className="h-4 w-4 text-primary" /><span className="text-sm font-medium text-foreground">Preview Queries</span></div>
        <div className="flex gap-2">
          <Input type="date" value={salesDay} onChange={(e) => setSalesDay(e.target.value)} className="w-44" />
          <Button size="sm" variant="outline" onClick={() => icg.previewQueries(salesDay)} disabled={icg.loadingQueryPreview}>
            {icg.loadingQueryPreview ? <Loader2 className="h-3 w-3 animate-spin" /> : <Code className="h-3 w-3" />} Preview SQL
          </Button>
        </div>
        {icg.queryPreview && (
          <div className="space-y-2">
            <div><span className="text-xs font-medium text-muted-foreground">Header:</span><pre className="mt-1 rounded-lg bg-muted p-3 text-xs font-mono overflow-x-auto text-foreground">{icg.queryPreview.header}</pre></div>
            <div><span className="text-xs font-medium text-muted-foreground">Lines:</span><pre className="mt-1 rounded-lg bg-muted p-3 text-xs font-mono overflow-x-auto text-foreground">{icg.queryPreview.lines}</pre></div>
          </div>
        )}
      </div>

      {/* Fetch Sales */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center gap-2"><Calendar className="h-4 w-4 text-primary" /><span className="text-sm font-medium text-foreground">Fetch Sales (Single Day)</span></div>
        <div className="flex gap-2">
          <Input type="date" value={salesDay} onChange={(e) => setSalesDay(e.target.value)} className="w-44" />
          <Button size="sm" onClick={() => icg.fetchSales(salesDay)} disabled={icg.loadingSales}>
            {icg.loadingSales ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />} Fetch
          </Button>
        </div>
        {icg.salesPreview && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <p className="text-xs text-foreground">{icg.salesPreview.message}</p>
            {icg.salesPreview.generatedSQL && <pre className="rounded bg-muted p-2 text-xs font-mono overflow-x-auto text-muted-foreground">{icg.salesPreview.generatedSQL}</pre>}
          </div>
        )}
      </div>

      {/* Incremental */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><RefreshCw className="h-4 w-4 text-primary" /><span className="text-sm font-medium text-foreground">Incremental Sync</span></div>
          <Button size="sm" onClick={() => icg.runIncrementalSync()} disabled={icg.incrementalSyncing}>
            {icg.incrementalSyncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Run
          </Button>
        </div>
        {icg.incrementalResult && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <p className="text-xs text-foreground">{icg.incrementalResult.message}</p>
            <pre className="rounded bg-muted p-2 text-xs font-mono overflow-x-auto text-muted-foreground">{icg.incrementalResult.generatedSQL}</pre>
          </div>
        )}
      </div>

      {/* Backfill */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center gap-2"><Calendar className="h-4 w-4 text-primary" /><span className="text-sm font-medium text-foreground">Historical Backfill</span></div>
        <div className="flex gap-2 items-center">
          <Input type="number" min="1" max="365" value={backfillDays} onChange={(e) => setBackfillDays(e.target.value)} className="w-24" />
          <span className="text-xs text-muted-foreground">days</span>
          <Button size="sm" onClick={() => icg.runBackfill(parseInt(backfillDays) || 30)} disabled={icg.backfilling}>
            {icg.backfilling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />} Generate
          </Button>
        </div>
        {icg.backfillResult && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <p className="text-xs text-foreground">{icg.backfillResult.message}</p>
            {icg.backfillResult.sampleQuery && <pre className="mt-1 rounded bg-muted p-2 text-xs font-mono overflow-x-auto text-muted-foreground">{icg.backfillResult.sampleQuery}</pre>}
          </div>
        )}
      </div>
    </div>
  );

  /* ── Step 4: Catalog & Write ── */
  const stepCatalog = (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Catalog & Write</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Read products/prices from ICG and optionally write price updates with safety gates.
        </p>
      </div>

      {/* Catalog Query Preview */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Catalog Queries</span>
        </div>
        {icg.catalogQueryPreview && (
          <div className="space-y-2">
            <div><span className="text-xs font-medium text-muted-foreground">Products:</span><pre className="mt-1 rounded-lg bg-muted p-3 text-xs font-mono overflow-x-auto text-foreground">{icg.catalogQueryPreview.products}</pre></div>
            <div><span className="text-xs font-medium text-muted-foreground">Families:</span><pre className="mt-1 rounded-lg bg-muted p-3 text-xs font-mono overflow-x-auto text-foreground">{icg.catalogQueryPreview.families}</pre></div>
          </div>
        )}
        <Button size="sm" onClick={() => icg.syncCatalog()} disabled={icg.syncingCatalog}>
          {icg.syncingCatalog ? <><Loader2 className="h-3 w-3 animate-spin" /> Syncing…</> : <><RefreshCw className="h-3 w-3" /> Sync Catalog</>}
        </Button>
        {icg.catalogResult && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
            <p className="text-xs text-foreground">{icg.catalogResult.message || `${icg.catalogResult.upserted} products, ${icg.catalogResult.totalFamilies} families`}</p>
            {icg.catalogResult.generatedSQL && <pre className="rounded bg-muted p-2 text-xs font-mono overflow-x-auto text-muted-foreground">{JSON.stringify(icg.catalogResult.generatedSQL, null, 2)}</pre>}
            {icg.catalogResult.errors.length > 0 && <p className="text-xs text-destructive">{icg.catalogResult.errors.join("; ")}</p>}
          </div>
        )}
      </div>

      {/* Write Control Gates */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Write Controls</span>
        </div>

        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Enable Price Writes</p>
              <p className="text-xs text-muted-foreground">Allow UPDATE queries against the ICG database</p>
            </div>
            <Switch checked={icg.writeEnabled} onCheckedChange={(v) => icg.updateWriteSettings(v, icg.requireApproval)} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Require Manual Approval</p>
              <p className="text-xs text-muted-foreground">Queue writes for review before execution</p>
            </div>
            <Switch checked={icg.requireApproval} onCheckedChange={(v) => icg.updateWriteSettings(icg.writeEnabled, v)} />
          </div>

          {!icg.writeEnabled && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldAlert className="h-3 w-3" /> Writes are currently disabled — all write actions will be blocked.
            </div>
          )}
        </div>
      </div>

      {/* Price Write Form */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Write Price Update</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label className="text-xs">Product ID (CodArticulo)</Label>
            <Input value={writeProductId} onChange={(e) => setWriteProductId(e.target.value)} placeholder="ART001" />
          </div>
          <div>
            <Label className="text-xs">New Price</Label>
            <Input type="number" step="0.01" value={writePrice} onChange={(e) => setWritePrice(e.target.value)} placeholder="12.50" />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex items-center gap-2">
              <Switch checked={dryRun} onCheckedChange={setDryRun} />
              <Label className="text-xs">{dryRun ? "Dry Run" : "Live"}</Label>
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant={dryRun ? "outline" : "default"}
            onClick={() => icg.writePrice(writeProductId, parseFloat(writePrice) || 0, dryRun)}
            disabled={icg.writingPrice || !writeProductId || !writePrice}
          >
            {icg.writingPrice ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
            {dryRun ? "Preview SQL" : "Execute Write"}
          </Button>
        </div>

        {icg.writeResult && (
          <div className={`rounded-lg border p-3 space-y-2 ${
            icg.writeResult.blocked ? "border-destructive/30 bg-destructive/10" :
            icg.writeResult.dryRun ? "border-primary/30 bg-primary/5" :
            icg.writeResult.pendingApproval ? "border-accent bg-accent/10" :
            "bg-muted/30"
          }`}>
            {icg.writeResult.blocked && (
              <div className="flex items-center gap-2 text-destructive text-xs font-medium">
                <ShieldAlert className="h-3 w-3" /> Blocked: {icg.writeResult.reason}
              </div>
            )}
            {icg.writeResult.dryRun && (
              <div className="flex items-center gap-2 text-primary text-xs font-medium">
                <Eye className="h-3 w-3" /> DRY RUN — No changes made
              </div>
            )}
            {icg.writeResult.pendingApproval && (
              <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                <ShieldCheck className="h-3 w-3 text-primary" /> Queued for approval (Task: {icg.writeResult.taskId})
              </div>
            )}
            <p className="text-xs text-muted-foreground">{icg.writeResult.message}</p>
            {icg.writeResult.generatedSQL && (
              <pre className="rounded bg-muted p-2 text-xs font-mono overflow-x-auto text-muted-foreground">{icg.writeResult.generatedSQL}</pre>
            )}
          </div>
        )}
      </div>

      {/* Pending Approval Queue */}
      {icg.requireApproval && (
        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium text-foreground">Pending Approvals</span>
              {icg.pendingWrites.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">{icg.pendingWrites.length}</Badge>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => icg.loadPendingWrites()} disabled={icg.loadingPending}>
              <RefreshCw className={`h-3 w-3 ${icg.loadingPending ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {icg.pendingWrites.length === 0 && (
            <p className="text-xs text-muted-foreground">No pending write tasks.</p>
          )}

          {icg.pendingWrites.map((task) => (
            <div key={task.id} className="rounded-lg border bg-card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs">
                  <span className="font-medium text-foreground">Product: </span>
                  <span className="font-mono text-foreground">{task.productId}</span>
                  <span className="text-muted-foreground"> → </span>
                  <span className="font-medium text-foreground">€{task.price}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => icg.approveWrite(task.id)}>
                    <Check className="h-3 w-3 text-primary" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => icg.rejectWrite(task.id)}>
                    <X className="h-3 w-3 text-destructive" />
                  </Button>
                </div>
              </div>
              <pre className="rounded bg-muted p-2 text-xs font-mono overflow-x-auto text-muted-foreground">{task.sql}</pre>
              <span className="text-[10px] text-muted-foreground">{task.createdAt}</span>
            </div>
          ))}
        </div>
      )}

      {/* Verify Product */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Post-Write Verification</span>
        </div>
        <div className="flex gap-2">
          <Input value={verifyProductId} onChange={(e) => setVerifyProductId(e.target.value)} placeholder="Product ID to verify" className="w-48" />
          <Button size="sm" variant="outline" onClick={() => { /* icg.verifyProduct placeholder */ }}>
            <CheckCircle2 className="h-3 w-3" /> Verify
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Generates a SELECT to confirm the product exists in ICG and has a price {">"} 0.
        </p>
      </div>
    </div>
  );

  /* ── Step 5: Go Live ── */
  const stepGoLive = (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Go Live</h2>
        <p className="text-sm text-muted-foreground mt-1">Review and enable sync.</p>
      </div>

      {/* Checklist */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Pre-flight Checklist</h3>
        <div className="space-y-2">
          {[
            { label: "Connection saved", pass: !!icg.connectionId },
            { label: "Connection tested", pass: icg.testStatus === "success" },
            { label: "SQL mapping configured", pass: !!icg.sqlMapping },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-2 text-sm">
              {item.pass ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <XCircle className="h-4 w-4 text-muted-foreground" />}
              <span className={item.pass ? "text-foreground" : "text-muted-foreground"}>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Write mode summary */}
      <div className="rounded-lg border p-4 space-y-2">
        <p className="text-xs text-muted-foreground">Write mode:</p>
        <p className="text-sm font-medium">{icg.writeEnabled ? "Enabled" : "Disabled (read-only)"}</p>
        {icg.writeEnabled && (
          <p className="text-xs text-muted-foreground">
            {icg.requireApproval ? "Writes require manual approval" : "Writes execute immediately"}
          </p>
        )}
      </div>

      <Button
        onClick={() => icg.enableSync()}
        disabled={!icg.connectionId || icg.testStatus !== "success"}
        className="w-full"
      >
        <CheckCircle2 className="h-4 w-4 mr-2" /> Enable Sync
      </Button>
    </div>
  );

  const stepsContent = [stepMode, stepCredentials, stepTest, stepSales, stepCatalog, stepGoLive];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/integrations")}><ArrowLeft className="h-4 w-4" /></Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">ICG FrontRest</h1>
          <p className="text-xs text-muted-foreground">On-prem POS — SQL Server integration</p>
        </div>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 flex-wrap">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-colors ${i <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{i + 1}</div>
            <span className={`text-xs hidden sm:inline ${i <= step ? "text-foreground" : "text-muted-foreground"}`}>{s}</span>
            {i < STEPS.length - 1 && <div className="w-4 h-px bg-border" />}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="rounded-xl border bg-card p-6">{stepsContent[step]}</div>

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setStep((s) => s - 1)} disabled={step === 0}><ArrowLeft className="h-4 w-4" /> Back</Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!canAdvance()}>Next <ArrowRight className="h-4 w-4" /></Button>
        ) : (
          <Button onClick={() => navigate("/integrations")}>Finish</Button>
        )}
      </div>
    </div>
  );
}
