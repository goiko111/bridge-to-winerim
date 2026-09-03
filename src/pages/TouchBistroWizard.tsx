import { useEffect, useState, useRef } from "react";
import { ConnectionHealthPanel } from "@/components/ConnectionHealthPanel";
import { getTouchBistroConfig } from "@/utils/providerConfig";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, XCircle, Loader2, Upload, Download,
  FileText, Settings2, Package, Info, Server, Globe, Zap, Search,
  BarChart3, AlertTriangle, Bug, HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTouchBistroConnection, TBIntegrationMode, TBIngestionMethod, TBDetectedFile } from "@/hooks/useTouchBistroConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";

const STEPS = [
  "Connection", "Export Guide", "Upload & Detect", "Sales Import",
  "Bills & Payments", "Catalog Items", "Automation", "Format Rules",
  "Private API", "Debug Bundle", "Go Live",
];
const STEP_ICONS = [Settings2, HelpCircle, Upload, FileText, Globe, Package, Server, BarChart3, Zap, Bug, CheckCircle2];

export default function TouchBistroWizard() {
  const navigate = useNavigate();
  const tb = useTouchBistroConnection();
  const [step, setStep] = useState(0);

  // Connection fields
  const [locationName, setLocationName] = useState("");
  const [integrationMode, setIntegrationMode] = useState<TBIntegrationMode>("CSV_REPORTS");
  const [ingestionMethod, setIngestionMethod] = useState<TBIngestionMethod>("MANUAL_UPLOAD");
  const [timezone, setTimezone] = useState("America/New_York");
  const [businessDayCloseHour, setBusinessDayCloseHour] = useState(4);

  // SFTP
  const [sftpHost, setSftpHost] = useState("");
  const [sftpPort, setSftpPort] = useState("22");
  const [sftpUser, setSftpUser] = useState("");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpPath, setSftpPath] = useState("/");

  // HTTPS
  const [httpsUrl, setHttpsUrl] = useState("");

  // Private API
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiClientId, setApiClientId] = useState("");
  const [apiClientSecret, setApiClientSecret] = useState("");
  const [apiLocationId, setApiLocationId] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    tb.loadExistingConnection().then((conn) => {
      if (conn) {
        setLocationName(conn.location_name || "");
        const cfg = getTouchBistroConfig(conn.provider_config);
        setIntegrationMode(cfg.integration_mode === "PRIVATE_API" ? "PRIVATE_API" : "CSV_REPORTS");
        setIngestionMethod(cfg.ingestion_method || "MANUAL_UPLOAD");
        setTimezone(cfg.timezone || "America/New_York");
        setBusinessDayCloseHour(cfg.business_day_close_hour ?? 4);
        if (cfg.sftp) {
          setSftpHost(cfg.sftp.host || "");
          setSftpPort(cfg.sftp.port || "22");
          setSftpUser(cfg.sftp.user || "");
          setSftpPath(cfg.sftp.path || "/");
        }
        if (cfg.https) setHttpsUrl(cfg.https.url || "");
        if (cfg.private_api) {
          setApiBaseUrl(cfg.private_api.base_url || "");
          setApiLocationId(cfg.private_api.location_id || "");
        }
      }
    });
  }, []);

  useEffect(() => {
    if (tb.connectionId && step === 7) tb.loadPricingDiagnostics();
  }, [step, tb.connectionId]);

  const handleSave = async () => {
    await tb.saveConnection({
      locationName, integrationMode, ingestionMethod, timezone, businessDayCloseHour,
      sftpHost, sftpPort, sftpUser, sftpPassword, sftpPath, httpsUrl,
      apiBaseUrl, apiKey, apiClientId, apiClientSecret, apiLocationId,
    });
    await tb.testConnection();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    await tb.uploadFiles(Array.from(e.target.files));
    if (fileRef.current) fileRef.current.value = "";
  };

  const salesFiles = tb.detectedFiles.filter((f) => f.reportType === "MENU_ITEM_SALES");
  const billFiles = tb.detectedFiles.filter((f) => f.reportType === "BILLS");
  const paymentFiles = tb.detectedFiles.filter((f) => f.reportType === "PAYMENTS");
  const itemFiles = tb.detectedFiles.filter((f) => f.reportType === "ITEMS");
  const unknownFiles = tb.detectedFiles.filter((f) => f.reportType === "UNKNOWN");

  const renderStep = () => {
    switch (step) {
      // ── Step 0: Connection ──
      case 0:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-4 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">TouchBistro Connection</h3>
              <div className="space-y-2">
                <Label>Location Name</Label>
                <Input value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder="My Restaurant" />
              </div>
              <div className="space-y-2">
                <Label>Integration Mode</Label>
                <RadioGroup value={integrationMode} onValueChange={(v) => setIntegrationMode(v as TBIntegrationMode)}>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="CSV_REPORTS" id="csv" />
                    <Label htmlFor="csv" className="text-sm">CSV Reports (recommended)</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="PRIVATE_API" id="api" />
                    <Label htmlFor="api" className="text-sm">Private API <Badge variant="outline" className="ml-1 text-[10px]">Beta — requires credentials</Badge></Label>
                  </div>
                </RadioGroup>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Timezone</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "Europe/London", "Europe/Madrid"].map((tz) => (
                        <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Business Day Close Hour</Label>
                  <Input type="number" min={0} max={12} value={businessDayCloseHour} onChange={(e) => setBusinessDayCloseHour(parseInt(e.target.value) || 4)} />
                </div>
              </div>
              <Button onClick={handleSave} disabled={!locationName} className="w-full mt-2">
                {tb.testStatus === "testing" ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save & Test
              </Button>
              {tb.testStatus === "success" && <div className="flex items-center gap-2 text-success text-sm"><CheckCircle2 className="h-4 w-4" /> Connected</div>}
              {tb.testStatus === "error" && <div className="flex items-center gap-2 text-destructive text-sm"><XCircle className="h-4 w-4" /> {tb.testError}</div>}
            </div>
          </div>
        );

      // ── Step 1: Export Guide (TB2) ──
      case 1:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-primary" /> What to Export from TouchBistro
              </h3>
              <p className="text-xs text-muted-foreground">
                We support several report types exported as CSV from TouchBistro. Here's how to get them:
              </p>
              <div className="space-y-3">
                <div className="rounded border border-border/50 p-3 space-y-1">
                  <h4 className="text-xs font-semibold text-foreground">📊 Menu Item Sales</h4>
                  <p className="text-xs text-muted-foreground">Line-level sales with item names, quantities, and totals. Best for analytics.</p>
                </div>
                <div className="rounded border border-border/50 p-3 space-y-1">
                  <h4 className="text-xs font-semibold text-foreground">🧾 Bills / Checks</h4>
                  <p className="text-xs text-muted-foreground">Ticket-level totals with subtotal, tax, and total per check.</p>
                </div>
                <div className="rounded border border-border/50 p-3 space-y-1">
                  <h4 className="text-xs font-semibold text-foreground">💳 Payments</h4>
                  <p className="text-xs text-muted-foreground">Payment breakdown by type (cash, card, etc.) with tips.</p>
                </div>
                <div className="rounded border border-border/50 p-3 space-y-1">
                  <h4 className="text-xs font-semibold text-foreground">📋 Items / Menu Items</h4>
                  <p className="text-xs text-muted-foreground">Your catalog: item names, categories, and prices.</p>
                </div>
              </div>
              <div className="rounded-lg bg-secondary/50 p-4 space-y-2">
                <h4 className="text-xs font-semibold text-foreground">How to Export</h4>
                <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>Open <strong>Reports</strong> in TouchBistro</li>
                  <li>Select the report you need and date range</li>
                  <li>Click <strong>Export as CSV</strong></li>
                  <li>Upload the file(s) in the next step</li>
                </ol>
              </div>
            </div>
          </div>
        );

      // ── Step 2: Upload & Detect (TB3) ──
      case 2:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Upload CSV Exports</h3>
              <p className="text-xs text-muted-foreground">Upload one or more CSV files. We'll detect the report type automatically.</p>
              <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
                <input ref={fileRef} type="file" accept=".csv,.CSV" multiple className="hidden" onChange={handleFileUpload} />
                <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={tb.uploading || !tb.connectionId}>
                  {tb.uploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Select CSV Files
                </Button>
                <p className="text-xs text-muted-foreground mt-2">Drag & drop or click to browse</p>
              </div>
              {tb.detectedFiles.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-foreground">Detected Files</h4>
                  {tb.detectedFiles.map((f, i) => (
                    <div key={i} className="flex items-center justify-between rounded border border-border/50 p-2 text-xs">
                      <div className="flex items-center gap-2">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium text-foreground">{f.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={f.reportType === "UNKNOWN" ? "destructive" : "default"} className="text-[10px]">
                          {f.reportType.replace(/_/g, " ")}
                        </Badge>
                        <span className="text-muted-foreground">{f.rowCount} rows</span>
                      </div>
                    </div>
                  ))}
                  {unknownFiles.length > 0 && (
                    <div className="rounded bg-destructive/10 p-2 text-xs text-destructive flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {unknownFiles.length} file(s) could not be detected. You may need to map columns manually.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );

      // ── Step 3: Sales Import (TB4) ──
      case 3:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Import Menu Item Sales</h3>
              {salesFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">No "Menu Item Sales" files detected. Upload them in the previous step.</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">{salesFiles.length} file(s) ready for import:</p>
                  {salesFiles.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <FileText className="h-3.5 w-3.5 text-primary" />
                      <span>{f.name} — {f.rowCount} rows</span>
                    </div>
                  ))}
                  <Button
                    onClick={() => tb.importSales(salesFiles.map((f) => f.storagePath))}
                    disabled={tb.salesImporting}
                  >
                    {tb.salesImporting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
                    Import Sales
                  </Button>
                </>
              )}
              {tb.salesImportResult && (
                <div className={`rounded p-3 text-xs ${tb.salesImportResult.success ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                  <p className="font-medium">{tb.salesImportResult.message}</p>
                  <div className="grid grid-cols-4 gap-2 mt-2 text-foreground">
                    <div><span className="font-semibold">{tb.salesImportResult.totalEvents}</span> events</div>
                    <div><span className="font-semibold">{tb.salesImportResult.totalLines}</span> lines</div>
                    <div><span className="font-semibold">{tb.salesImportResult.duplicatesSkipped}</span> dupes</div>
                    <div><span className="font-semibold">{tb.salesImportResult.rowsFailed}</span> failed</div>
                  </div>
                  {tb.salesImportResult.failReasons.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-muted-foreground">Show errors</summary>
                      <ul className="mt-1 space-y-0.5 text-destructive">
                        {tb.salesImportResult.failReasons.slice(0, 10).map((r, i) => <li key={i}>• {r}</li>)}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </div>
          </div>
        );

      // ── Step 4: Bills & Payments (TB5) ──
      case 4:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Import Bills & Payments</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-foreground">🧾 Bills</h4>
                  {billFiles.length === 0
                    ? <p className="text-xs text-muted-foreground">No bills files detected.</p>
                    : billFiles.map((f, i) => <div key={i} className="text-xs flex items-center gap-1"><FileText className="h-3 w-3" />{f.name} ({f.rowCount})</div>)
                  }
                </div>
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-foreground">💳 Payments</h4>
                  {paymentFiles.length === 0
                    ? <p className="text-xs text-muted-foreground">No payment files detected.</p>
                    : paymentFiles.map((f, i) => <div key={i} className="text-xs flex items-center gap-1"><FileText className="h-3 w-3" />{f.name} ({f.rowCount})</div>)
                  }
                </div>
              </div>
              {(billFiles.length > 0 || paymentFiles.length > 0) && (
                <Button
                  onClick={() => tb.importBillsPayments(billFiles.map((f) => f.storagePath), paymentFiles.map((f) => f.storagePath))}
                  disabled={tb.salesImporting}
                >
                  {tb.salesImporting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Import Bills & Payments
                </Button>
              )}
              {tb.reconciliation.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-foreground">Reconciliation</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-1">Date</th><th className="text-right">Bills</th><th className="text-right">Payments</th><th className="text-right">Diff</th><th></th>
                      </tr></thead>
                      <tbody>
                        {tb.reconciliation.map((r, i) => (
                          <tr key={i} className="border-b border-border/30">
                            <td className="py-1">{r.date}</td>
                            <td className="text-right">${r.billsTotal.toFixed(2)}</td>
                            <td className="text-right">${r.paymentsTotal.toFixed(2)}</td>
                            <td className="text-right">${r.diff.toFixed(2)}</td>
                            <td>{r.mismatch && <AlertTriangle className="h-3 w-3 text-warning" />}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        );

      // ── Step 5: Catalog Items (TB6) ──
      case 5:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Import Catalog Items</h3>
              {itemFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">No "Items" files detected. Upload them in step 3.</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">{itemFiles.length} file(s) ready:</p>
                  {itemFiles.map((f, i) => (
                    <div key={i} className="text-xs flex items-center gap-2"><FileText className="h-3.5 w-3.5 text-primary" />{f.name} — {f.rowCount} rows</div>
                  ))}
                  <Button
                    onClick={() => tb.importCatalog(itemFiles.map((f) => f.storagePath))}
                    disabled={tb.catalogImporting}
                  >
                    {tb.catalogImporting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Package className="h-4 w-4 mr-2" />}
                    Import Catalog
                  </Button>
                </>
              )}
              {tb.catalogImportResult && (
                <div className="rounded bg-success/10 p-3 text-xs text-success">
                  <p className="font-medium">{tb.catalogImportResult.message}</p>
                  <div className="grid grid-cols-4 gap-2 mt-2 text-foreground">
                    <div><span className="font-semibold">{tb.catalogImportResult.totalProducts}</span> total</div>
                    <div><span className="font-semibold">{tb.catalogImportResult.inserted}</span> new</div>
                    <div><span className="font-semibold">{tb.catalogImportResult.updated}</span> updated</div>
                    <div><span className="font-semibold">{tb.catalogImportResult.matched}</span> matched</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );

      // ── Step 6: Automation (TB7) ──
      case 6:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Automated Ingestion (Optional)</h3>
              <p className="text-xs text-muted-foreground">Set up automated file ingestion instead of manual uploads.</p>
              <div className="space-y-2">
                <Label>Ingestion Method</Label>
                <RadioGroup value={ingestionMethod} onValueChange={(v) => setIngestionMethod(v as TBIngestionMethod)}>
                  <div className="flex items-center gap-2"><RadioGroupItem value="MANUAL_UPLOAD" id="manual" /><Label htmlFor="manual" className="text-sm">Manual Upload</Label></div>
                  <div className="flex items-center gap-2"><RadioGroupItem value="SFTP_PULL" id="sftp" /><Label htmlFor="sftp" className="text-sm">SFTP Pull</Label></div>
                  <div className="flex items-center gap-2"><RadioGroupItem value="HTTPS_PULL" id="https" /><Label htmlFor="https" className="text-sm">HTTPS Pull (signed URL)</Label></div>
                </RadioGroup>
              </div>
              {ingestionMethod === "SFTP_PULL" && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1"><Label className="text-xs">Host</Label><Input value={sftpHost} onChange={(e) => setSftpHost(e.target.value)} placeholder="sftp.example.com" /></div>
                  <div className="space-y-1"><Label className="text-xs">Port</Label><Input value={sftpPort} onChange={(e) => setSftpPort(e.target.value)} /></div>
                  <div className="space-y-1"><Label className="text-xs">Username</Label><Input value={sftpUser} onChange={(e) => setSftpUser(e.target.value)} /></div>
                  <div className="space-y-1"><Label className="text-xs">Password</Label><Input type="password" value={sftpPassword} onChange={(e) => setSftpPassword(e.target.value)} /></div>
                  <div className="col-span-2 space-y-1"><Label className="text-xs">Remote Path</Label><Input value={sftpPath} onChange={(e) => setSftpPath(e.target.value)} /></div>
                </div>
              )}
              {ingestionMethod === "HTTPS_PULL" && (
                <div className="space-y-1">
                  <Label className="text-xs">Signed URL Template</Label>
                  <Input value={httpsUrl} onChange={(e) => setHttpsUrl(e.target.value)} placeholder="https://..." />
                  <p className="text-xs text-muted-foreground">Use <code>{"{date}"}</code> as placeholder for the business date.</p>
                </div>
              )}
              {ingestionMethod !== "MANUAL_UPLOAD" && (
                <Button onClick={handleSave} className="w-full">Save Automation Settings</Button>
              )}
            </div>
          </div>
        );

      // ── Step 7: Format Rules (TB8) ──
      case 7:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Format Normalization Rules</h3>
              <p className="text-xs text-muted-foreground">
                Line items are classified by format based on their name prefix:
              </p>
              <div className="space-y-2">
                {[
                  { prefix: 'BOT. / BOT ', format: 'BOTTLE', color: 'bg-primary/10 text-primary' },
                  { prefix: 'COPA / GLASS', format: 'GLASS', color: 'bg-accent/50 text-accent-foreground' },
                  { prefix: 'MAGNUM / MAG.', format: 'MAGNUM', color: 'bg-secondary text-secondary-foreground' },
                ].map((rule) => (
                  <div key={rule.format} className="flex items-center justify-between rounded border border-border/50 p-2">
                    <div className="text-xs"><code className="bg-secondary px-1 rounded">{rule.prefix}</code></div>
                    <Badge className={`text-[10px] ${rule.color}`}>{rule.format}</Badge>
                  </div>
                ))}
              </div>
              {tb.pricingDiagnostics && (
                <div className="space-y-3 mt-4">
                  <h4 className="text-xs font-semibold text-foreground">Pricing Coverage (Winerim)</h4>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "Bottle", pct: tb.pricingDiagnostics.bottleCoverage },
                      { label: "Glass", pct: tb.pricingDiagnostics.glassCoverage },
                      { label: "Magnum", pct: tb.pricingDiagnostics.magnumCoverage },
                    ].map((item) => (
                      <div key={item.label} className="space-y-1">
                        <div className="flex justify-between text-xs"><span>{item.label}</span><span>{item.pct}%</span></div>
                        <Progress value={item.pct} className="h-1.5" />
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{tb.pricingDiagnostics.ready} READY / {tb.pricingDiagnostics.total} total</span>
                    <span>{tb.pricingDiagnostics.missing} missing prices</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        );

      // ── Step 8: Private API (TB10-13) ──
      case 8:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" /> Private API
                <Badge variant="outline" className="text-[10px]">Beta</Badge>
              </h3>
              <div className="rounded bg-warning/10 p-3 text-xs text-warning flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>TouchBistro API endpoints vary by installation and require approved partner credentials. This module is for discovery and testing only.</span>
              </div>
              {integrationMode !== "PRIVATE_API" ? (
                <p className="text-xs text-muted-foreground">Enable "Private API" mode in step 1 to configure API access.</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1"><Label className="text-xs">API Base URL</Label><Input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://api.touchbistro.com" /></div>
                    <div className="space-y-1"><Label className="text-xs">Location ID</Label><Input value={apiLocationId} onChange={(e) => setApiLocationId(e.target.value)} /></div>
                    <div className="space-y-1"><Label className="text-xs">API Key / Bearer Token</Label><Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
                    <div className="space-y-1"><Label className="text-xs">Client ID (optional)</Label><Input value={apiClientId} onChange={(e) => setApiClientId(e.target.value)} /></div>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={handleSave} variant="outline">Save API Settings</Button>
                    <Button onClick={() => tb.discoverApi()} disabled={tb.apiDiscovering}>
                      {tb.apiDiscovering ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Search className="h-4 w-4 mr-2" />}
                      Discover Endpoints
                    </Button>
                  </div>
                  {tb.apiDiscoveryResult && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">{tb.apiDiscoveryResult.message}</p>
                      <div className="max-h-48 overflow-y-auto space-y-1">
                        {tb.apiDiscoveryResult.endpoints.map((ep, i) => (
                          <div key={i} className="flex items-center justify-between text-xs rounded border border-border/30 p-1.5">
                            <code className="text-foreground">{ep.path}</code>
                            <Badge variant={ep.status === 200 ? "default" : "secondary"} className="text-[10px]">{ep.status}</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="rounded bg-secondary/50 p-3 text-xs text-muted-foreground space-y-1">
                    <p className="font-semibold text-foreground">Feature Status:</p>
                    <p>• <strong>Sales sync via API (TB11)</strong>: Pending endpoint confirmation</p>
                    <p>• <strong>Catalog sync via API (TB12)</strong>: Pending endpoint confirmation</p>
                    <p>• <strong>Writes (TB13)</strong>: Disabled — requires confirmed write endpoints</p>
                  </div>
                </>
              )}
            </div>
          </div>
        );

      // ── Step 9: Debug Bundle (TB9) ──
      case 9:
        return (
          <div className="space-y-6">
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Bug className="h-4 w-4 text-primary" /> Debug Bundle
              </h3>
              <p className="text-xs text-muted-foreground">
                Export a sanitized diagnostics file for support. Includes imported file metadata, detected report types,
                parse error samples, and reconciliation results. <strong>No secrets or tokens are included.</strong>
              </p>
              <Button onClick={() => tb.exportDebugBundle()} disabled={!tb.connectionId}>
                <Download className="h-4 w-4 mr-2" /> Export Debug Bundle (JSON)
              </Button>
            </div>
          </div>
        );

      // ── Step 10: Go Live ──
      case 10:
        return (
           <div className="space-y-6">
            {tb.connectionId && <ConnectionHealthPanel connectionId={tb.connectionId} />}
            <ProviderReadinessPanel connectionId={tb.connectionId} provider="touchbistro" />
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" /> Go Live Checklist
              </h3>
              <div className="space-y-2">
                {[
                  { label: "Connection saved", pass: !!tb.connectionId },
                  { label: "Connection tested", pass: tb.testStatus === "success" },
                  { label: "Sales data imported", pass: !!tb.salesImportResult?.success },
                  { label: "Catalog imported (optional)", pass: !!tb.catalogImportResult?.success, optional: true },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-2 text-sm">
                    {item.pass ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : item.optional ? (
                      <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/50" />
                    ) : (
                      <XCircle className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className={item.pass ? "text-foreground" : "text-muted-foreground"}>
                      {item.label}{item.optional && !item.pass ? " (skipped)" : ""}
                    </span>
                  </div>
                ))}
              </div>
              {tb.pricingDiagnostics && (
                <div className="rounded-lg border p-3 space-y-2">
                  <p className="text-xs text-muted-foreground">Pricing coverage:</p>
                  <div className="flex gap-4 text-xs">
                    <span>Bottle: {tb.pricingDiagnostics.bottleCoverage}%</span>
                    <span>Glass: {tb.pricingDiagnostics.glassCoverage}%</span>
                    <span>Magnum: {tb.pricingDiagnostics.magnumCoverage}%</span>
                  </div>
                </div>
              )}
              <Button 
                onClick={() => tb.enableSync()} 
                disabled={!tb.connectionId || tb.testStatus !== "success"}
                className="w-full"
              >
                <CheckCircle2 className="h-4 w-4 mr-2" /> Enable Sync
              </Button>
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
          <h1 className="text-xl font-bold text-foreground">Connect TouchBistro</h1>
          <p className="text-xs text-muted-foreground">CSV Reports + optional Private API</p>
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
