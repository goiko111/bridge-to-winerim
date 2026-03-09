import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, XCircle, Loader2, Upload, Download,
  FileText, Settings2, Package, FolderOpen, Info, Server, Globe,
  Zap, Search, BarChart3, AlertTriangle, Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useHioposConnection, HioposIngestionMode, HioposIntegrationMode } from "@/hooks/useHioposConnection";
import ProviderReadinessPanel from "@/components/ProviderReadinessPanel";

const STEPS = ["Connection", "Sales Import", "SFTP Pull", "Catalog Import", "Generate Export", "HiOffice", "PortalRest API", "Pricing Quality"];
const STEP_ICONS = [Settings2, Upload, Server, Package, Download, Globe, Zap, BarChart3];

export default function HioposWizard() {
  const navigate = useNavigate();
  const hiopos = useHioposConnection();
  const [step, setStep] = useState(0);

  // Connection fields
  const [locationName, setLocationName] = useState("");
  const [integrationMode, setIntegrationMode] = useState<HioposIntegrationMode>("FILES");
  const [ingestionMode, setIngestionMode] = useState<HioposIngestionMode>("MANUAL_UPLOAD");
  const [storeId, setStoreId] = useState("");
  const [timezone, setTimezone] = useState("Europe/Madrid");
  const [businessDayCloseHour, setBusinessDayCloseHour] = useState(6);
  const [sftpHost, setSftpHost] = useState("");
  const [sftpPort, setSftpPort] = useState("22");
  const [sftpUser, setSftpUser] = useState("");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpPath, setSftpPath] = useState("/");
  const [useHioffice, setUseHioffice] = useState(false);

  // PortalRest fields
  const [prBaseUrl, setPrBaseUrl] = useState("");
  const [prAccountId, setPrAccountId] = useState("");
  const [prLocationId, setPrLocationId] = useState("");
  const [prApiKey, setPrApiKey] = useState("");
  const [prApiSecret, setPrApiSecret] = useState("");
  const [prHoursBack, setPrHoursBack] = useState(24);

  // Sales import fields
  const [salesDateFrom, setSalesDateFrom] = useState("");
  const [salesDateTo, setSalesDateTo] = useState("");
  const [salesStore, setSalesStore] = useState("");
  const [salesRegister, setSalesRegister] = useState("");
  const salesFileRef = useRef<HTMLInputElement>(null);
  const catalogFileRef = useRef<HTMLInputElement>(null);
  const [exportFormat, setExportFormat] = useState<"csv" | "xml">("csv");

  useEffect(() => {
    hiopos.loadExistingConnection().then((conn) => {
      if (conn) {
        setLocationName(conn.location_name || "");
        const cfg = conn.provider_config as any;
        if (cfg) {
          setIntegrationMode(cfg.integration_mode === "PORTALREST_ORDERS_API" ? "PORTALREST_ORDERS_API" : "FILES");
          setIngestionMode(cfg.ingestion_mode || "MANUAL_UPLOAD");
          setStoreId(cfg.store_id || "");
          setTimezone(cfg.timezone || "Europe/Madrid");
          setBusinessDayCloseHour(cfg.business_day_close_hour ?? 6);
          setUseHioffice(cfg.use_hioffice || false);
          if (cfg.sftp) {
            setSftpHost(cfg.sftp.host || "");
            setSftpPort(cfg.sftp.port || "22");
            setSftpUser(cfg.sftp.user || "");
            setSftpPath(cfg.sftp.path || "/");
          }
          if (cfg.portalrest) {
            setPrBaseUrl(cfg.portalrest.base_url || "");
            setPrAccountId(cfg.portalrest.account_id || "");
            setPrLocationId(cfg.portalrest.location_id || "");
          }
        }
      }
    });
  }, []);

  useEffect(() => {
    if (hiopos.connectionId && step === 7) {
      hiopos.loadPricingDiagnostics();
    }
  }, [step, hiopos.connectionId]);

  const handleSaveConnection = async () => {
    try {
      await hiopos.saveConnection({
        locationName, integrationMode, ingestionMode, storeId, timezone,
        businessDayCloseHour,
        sftpHost, sftpPort, sftpUser, sftpPassword, sftpPath, useHioffice,
        portalrestBaseUrl: prBaseUrl, portalrestAccountId: prAccountId,
        portalrestLocationId: prLocationId, portalrestApiKey: prApiKey, portalrestApiSecret: prApiSecret,
      });
      await hiopos.testConnection();
    } catch (e: any) { console.error(e); }
  };

  const handleSalesUpload = async () => {
    const files = salesFileRef.current?.files;
    if (!files || files.length === 0) return;
    await hiopos.uploadSalesFile(files[0], salesDateFrom || undefined, salesDateTo || undefined, salesStore || undefined, salesRegister || undefined);
  };

  const handleCatalogUpload = async () => {
    const files = catalogFileRef.current?.files;
    if (!files || files.length === 0) return;
    await hiopos.uploadCatalogFile(files[0]);
  };

  const ResultBox = ({ success, message, children }: { success: boolean; message: string; children?: React.ReactNode }) => (
    <div className={`rounded-lg p-4 text-sm ${success ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300" : "bg-destructive/10 text-destructive"}`}>
      <p className="font-medium">{message}</p>
      {children}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/integrations")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">HIOPOS Cloud</h1>
          <p className="text-sm text-muted-foreground">CSV/XML + PortalRest API integration</p>
        </div>
      </div>

      {/* Step navigation */}
      <div className="flex items-center gap-1 overflow-x-auto pb-2">
        {STEPS.map((s, i) => {
          const Icon = STEP_ICONS[i];
          const isActive = i === step;
          const isDone = i < step;
          return (
            <button key={s} onClick={() => setStep(i)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                isActive ? "bg-primary text-primary-foreground"
                : isDone ? "bg-primary/10 text-primary"
                : "bg-secondary text-muted-foreground hover:bg-secondary/80"
              }`}>
              <Icon className="h-3.5 w-3.5" />{s}
            </button>
          );
        })}
      </div>

      {/* ═══════════ Step 0: Connection ═══════════ */}
      {step === 0 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold">Connection Setup</h2>

          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30">
            <div className="flex gap-2">
              <Info className="h-4 w-4 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0" />
              <div className="text-xs text-blue-700 dark:text-blue-300 space-y-1">
                <p className="font-medium">HIOPOS Integration Modes</p>
                <p><strong>FILES</strong>: Export sales/articles as CSV/XML from HIOPOS and upload or auto-pull via SFTP.</p>
                <p><strong>PortalRest API</strong>: Real-time API configured in CLOUDLICENSE → PortalRest. Used by Deliverect-style integrations. Endpoints vary per installation.</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <Label>Location name *</Label>
              <Input value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder="e.g. Restaurant Madrid Centro" />
            </div>

            <div>
              <Label className="mb-2 block">Integration Mode</Label>
              <RadioGroup value={integrationMode} onValueChange={(v) => setIntegrationMode(v as HioposIntegrationMode)} className="space-y-2">
                <div className="flex items-center gap-2 rounded-lg border p-3">
                  <RadioGroupItem value="FILES" id="mode-files" />
                  <Label htmlFor="mode-files" className="cursor-pointer flex-1">
                    <span className="font-medium">FILES (CSV/XML)</span>
                    <p className="text-xs text-muted-foreground">Read sales + import items via exported files</p>
                  </Label>
                </div>
                <div className="flex items-center gap-2 rounded-lg border p-3">
                  <RadioGroupItem value="PORTALREST_ORDERS_API" id="mode-api" />
                  <Label htmlFor="mode-api" className="cursor-pointer flex-1">
                    <span className="font-medium flex items-center gap-1.5">PortalRest Orders API <Badge variant="outline" className="text-[10px]">Beta</Badge></span>
                    <p className="text-xs text-muted-foreground">Real-time API — requires CLOUDLICENSE → PortalRest → New API of Orders</p>
                  </Label>
                </div>
              </RadioGroup>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Store ID (optional)</Label>
                <Input value={storeId} onChange={(e) => setStoreId(e.target.value)} placeholder="HIOPOS store identifier" />
              </div>
              <div>
                <Label>Business Day Close Hour</Label>
                <Input type="number" min={0} max={23} value={businessDayCloseHour} onChange={(e) => setBusinessDayCloseHour(parseInt(e.target.value) || 6)} />
              </div>
            </div>

            <div>
              <Label>Timezone</Label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Europe/Madrid">Europe/Madrid</SelectItem>
                  <SelectItem value="Europe/Rome">Europe/Rome</SelectItem>
                  <SelectItem value="America/Mexico_City">America/Mexico_City</SelectItem>
                  <SelectItem value="America/New_York">America/New_York</SelectItem>
                  <SelectItem value="UTC">UTC</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {integrationMode === "FILES" && (
              <>
                <div>
                  <Label className="mb-2 block">Ingestion Method</Label>
                  <RadioGroup value={ingestionMode} onValueChange={(v) => setIngestionMode(v as HioposIngestionMode)} className="space-y-2">
                    <div className="flex items-center gap-2 rounded-lg border p-3">
                      <RadioGroupItem value="MANUAL_UPLOAD" id="manual" />
                      <Label htmlFor="manual" className="cursor-pointer flex-1">
                        <span className="font-medium">Manual Upload</span>
                        <p className="text-xs text-muted-foreground">Upload CSV/XML files exported from HIOPOS</p>
                      </Label>
                    </div>
                    <div className="flex items-center gap-2 rounded-lg border p-3">
                      <RadioGroupItem value="SFTP_PULL" id="sftp" />
                      <Label htmlFor="sftp" className="cursor-pointer flex-1">
                        <span className="font-medium">Scheduled SFTP Pull</span>
                        <p className="text-xs text-muted-foreground">Auto-fetch from SFTP — ideal with HiOffice automated exports</p>
                      </Label>
                    </div>
                  </RadioGroup>
                </div>

                {ingestionMode === "SFTP_PULL" && (
                  <div className="space-y-3 rounded-lg border p-4 bg-secondary/30">
                    <div className="grid grid-cols-2 gap-3">
                      <div><Label>SFTP Host *</Label><Input value={sftpHost} onChange={(e) => setSftpHost(e.target.value)} placeholder="sftp.example.com" /></div>
                      <div><Label>Port</Label><Input value={sftpPort} onChange={(e) => setSftpPort(e.target.value)} /></div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div><Label>Username *</Label><Input value={sftpUser} onChange={(e) => setSftpUser(e.target.value)} /></div>
                      <div><Label>Password *</Label><Input type="password" value={sftpPassword} onChange={(e) => setSftpPassword(e.target.value)} /></div>
                    </div>
                    <div><Label>Remote Path</Label><Input value={sftpPath} onChange={(e) => setSftpPath(e.target.value)} placeholder="/" /></div>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Switch checked={useHioffice} onCheckedChange={setUseHioffice} />
                  <Label>We use HiOffice Import/Export module</Label>
                </div>
              </>
            )}

            {integrationMode === "PORTALREST_ORDERS_API" && (
              <div className="space-y-3 rounded-lg border p-4 bg-secondary/30">
                <p className="text-xs font-medium text-muted-foreground">PortalRest API Credentials</p>
                <div><Label>Base URL *</Label><Input value={prBaseUrl} onChange={(e) => setPrBaseUrl(e.target.value)} placeholder="https://your-hiopos.cloud/portalrest" /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Account ID</Label><Input value={prAccountId} onChange={(e) => setPrAccountId(e.target.value)} /></div>
                  <div><Label>Location ID</Label><Input value={prLocationId} onChange={(e) => setPrLocationId(e.target.value)} /></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>API Key *</Label><Input value={prApiKey} onChange={(e) => setPrApiKey(e.target.value)} /></div>
                  <div><Label>API Secret</Label><Input type="password" value={prApiSecret} onChange={(e) => setPrApiSecret(e.target.value)} /></div>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                  <p className="text-[11px] text-amber-700 dark:text-amber-300">
                    <strong>Where to find:</strong> CLOUDLICENSE → PortalRest → New API of Orders. Endpoints vary by installation and may require partner enablement.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 pt-4 border-t">
            {!hiopos.connectionId ? (
              <Button onClick={handleSaveConnection} disabled={!locationName.trim()}>Save & Validate</Button>
            ) : (
              <div className="flex items-center gap-2">
                {hiopos.testStatus === "success" && <CheckCircle2 className="h-5 w-5 text-green-500" />}
                {hiopos.testStatus === "error" && <XCircle className="h-5 w-5 text-destructive" />}
                <span className="text-sm">{hiopos.testStatus === "success" ? "Connection saved" : hiopos.testStatus === "error" ? hiopos.testError : "Saved"}</span>
              </div>
            )}
            <div className="flex-1" />
            <Button onClick={() => setStep(integrationMode === "PORTALREST_ORDERS_API" ? 6 : 1)} disabled={!hiopos.connectionId}>
              Next <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 1: Sales Import (manual) ═══════════ */}
      {step === 1 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Upload className="h-5 w-5" /> Upload Sales Export</h2>
          <p className="text-sm text-muted-foreground">Export sales from HIOPOS (CSV or XML) and upload here.</p>

          <div className="grid grid-cols-2 gap-4">
            <div><Label>Date from</Label><Input type="date" value={salesDateFrom} onChange={(e) => setSalesDateFrom(e.target.value)} /></div>
            <div><Label>Date to</Label><Input type="date" value={salesDateTo} onChange={(e) => setSalesDateTo(e.target.value)} /></div>
            <div><Label>Store</Label><Input value={salesStore} onChange={(e) => setSalesStore(e.target.value)} placeholder="Filter by store" /></div>
            <div><Label>Register</Label><Input value={salesRegister} onChange={(e) => setSalesRegister(e.target.value)} placeholder="Filter by register" /></div>
          </div>

          <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 p-8 text-center">
            <FileText className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground mb-3">Drag & drop or click to select CSV/XML sales export</p>
            <input ref={salesFileRef} type="file" accept=".csv,.xml" className="hidden" id="sales-file" />
            <Button variant="outline" onClick={() => salesFileRef.current?.click()}><FolderOpen className="h-4 w-4 mr-1" /> Choose File</Button>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSalesUpload} disabled={hiopos.salesImporting}>
              {hiopos.salesImporting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Importing...</> : "Import Sales"}
            </Button>
            {hiopos.lastImportedFile && <span className="text-xs text-muted-foreground">Last: {hiopos.lastImportedFile}</span>}
          </div>

          {hiopos.salesImportResult && (
            <ResultBox success={hiopos.salesImportResult.success} message={hiopos.salesImportResult.message}>
              {hiopos.salesImportResult.success && (
                <p className="text-xs mt-1">{hiopos.salesImportResult.totalEvents} tickets · {hiopos.salesImportResult.totalLines} lines · {hiopos.salesImportResult.duplicatesSkipped} dupes skipped{hiopos.salesImportResult.rowsFailed ? ` · ${hiopos.salesImportResult.rowsFailed} failed` : ""}</p>
              )}
              {hiopos.salesImportResult.failReasons && hiopos.salesImportResult.failReasons.length > 0 && (
                <div className="mt-2 text-xs space-y-0.5 opacity-80">{hiopos.salesImportResult.failReasons.map((r, i) => <p key={i}>• {r}</p>)}</div>
              )}
            </ResultBox>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(0)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button onClick={() => setStep(2)}>Next <ArrowRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 2: SFTP Pull Status ═══════════ */}
      {step === 2 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Server className="h-5 w-5" /> SFTP Automated Pull</h2>

          {ingestionMode !== "SFTP_PULL" ? (
            <div className="rounded-lg border border-muted p-6 text-center text-sm text-muted-foreground">
              <p>SFTP Pull not enabled. Go to Connection step and select "Scheduled SFTP Pull" to activate.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30">
                <div className="flex gap-2">
                  <Info className="h-4 w-4 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0" />
                  <div className="text-xs text-blue-700 dark:text-blue-300 space-y-1">
                    <p className="font-medium">HiOffice/HIOPOS → SFTP → Auto-import</p>
                    <p>Configure HiOffice to export reports to your SFTP server. We'll periodically pull new files and parse them.</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">SFTP Host</p>
                  <p className="font-medium">{sftpHost || "—"}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Remote Path</p>
                  <p className="font-medium">{sftpPath || "/"}</p>
                </div>
              </div>

              <Button onClick={hiopos.triggerSftpPull} disabled={hiopos.sftpPulling}>
                {hiopos.sftpPulling ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Pulling...</> : <><Wifi className="h-4 w-4 mr-1" /> Trigger Manual Pull</>}
              </Button>

              {hiopos.sftpPullStatus && (
                <div className="rounded-lg border p-4 space-y-2 text-sm">
                  <div className="grid grid-cols-2 gap-3">
                    <div><p className="text-xs text-muted-foreground">Last File Pulled</p><p className="font-medium">{hiopos.sftpPullStatus.lastFilePulled || "None yet"}</p></div>
                    <div><p className="text-xs text-muted-foreground">Last Successful Import</p><p className="font-medium">{hiopos.sftpPullStatus.lastSuccessfulImport || "—"}</p></div>
                    <div><p className="text-xs text-muted-foreground">Failures</p><p className="font-medium">{hiopos.sftpPullStatus.failures}</p></div>
                    {hiopos.sftpPullStatus.lastError && (
                      <div><p className="text-xs text-muted-foreground">Last Error</p><p className="font-medium text-destructive">{hiopos.sftpPullStatus.lastError}</p></div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(1)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button onClick={() => setStep(3)}>Next <ArrowRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 3: Catalog Import ═══════════ */}
      {step === 3 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Package className="h-5 w-5" /> Upload Articles Export</h2>
          <p className="text-sm text-muted-foreground">Export articles/items from HIOPOS and upload for matching with Winerim wines.</p>

          <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 p-8 text-center">
            <FileText className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground mb-3">CSV/XML articles export</p>
            <input ref={catalogFileRef} type="file" accept=".csv,.xml" className="hidden" id="catalog-file" />
            <Button variant="outline" onClick={() => catalogFileRef.current?.click()}><FolderOpen className="h-4 w-4 mr-1" /> Choose File</Button>
          </div>

          <Button onClick={handleCatalogUpload} disabled={hiopos.catalogImporting}>
            {hiopos.catalogImporting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Importing...</> : "Import Catalog"}
          </Button>

          {hiopos.catalogImportResult && (
            <ResultBox success={hiopos.catalogImportResult.success} message={hiopos.catalogImportResult.message}>
              {hiopos.catalogImportResult.success && <p className="text-xs mt-1">{hiopos.catalogImportResult.inserted} new · {hiopos.catalogImportResult.updated} updated</p>}
            </ResultBox>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(2)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button onClick={() => setStep(4)}>Next <ArrowRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 4: Generate Export ═══════════ */}
      {step === 4 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Download className="h-5 w-5" /> Generate HIOPOS Import File</h2>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
            <div className="flex gap-2">
              <Info className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="text-xs text-amber-700 dark:text-amber-300 space-y-1">
                <p className="font-medium">Safe read-only export</p>
                <p>Only wines with <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded">pricing_status = READY</code> included. One row per sellable format (BOT/COPA/MAGNUM). No automatic writes.</p>
              </div>
            </div>
          </div>

          <div>
            <Label>Export Format</Label>
            <RadioGroup value={exportFormat} onValueChange={(v) => setExportFormat(v as "csv" | "xml")} className="flex gap-4 mt-2">
              <div className="flex items-center gap-2"><RadioGroupItem value="csv" id="csv" /><Label htmlFor="csv">CSV (semicolon)</Label></div>
              <div className="flex items-center gap-2"><RadioGroupItem value="xml" id="xml" /><Label htmlFor="xml">XML</Label></div>
            </RadioGroup>
          </div>

          <Button onClick={() => hiopos.generateImportFile(exportFormat, false)} disabled={hiopos.exporting}>
            {hiopos.exporting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Generating...</> : <><Download className="h-4 w-4 mr-1" /> Generate File</>}
          </Button>

          {hiopos.exportResult && (
            <ResultBox success={hiopos.exportResult.success} message={hiopos.exportResult.message}>
              {hiopos.exportResult.success && hiopos.exportResult.downloadUrl && (
                <a href={hiopos.exportResult.downloadUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-2 text-xs underline"><Download className="h-3 w-3" /> Download</a>
              )}
            </ResultBox>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(3)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button onClick={() => setStep(5)}>Next <ArrowRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 5: HiOffice ═══════════ */}
      {step === 5 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Globe className="h-5 w-5" /> HiOffice B2B Import/Export</h2>

          {!useHioffice ? (
            <div className="rounded-lg border border-muted p-6 text-center text-sm text-muted-foreground">
              <p>HiOffice not enabled. Enable it in Connection step.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div><Label>Format</Label>
                <RadioGroup value={exportFormat} onValueChange={(v) => setExportFormat(v as "csv" | "xml")} className="flex gap-4 mt-2">
                  <div className="flex items-center gap-2"><RadioGroupItem value="csv" id="ho-csv" /><Label htmlFor="ho-csv">CSV</Label></div>
                  <div className="flex items-center gap-2"><RadioGroupItem value="xml" id="ho-xml" /><Label htmlFor="ho-xml">XML</Label></div>
                </RadioGroup>
              </div>

              <Button onClick={() => hiopos.generateImportFile(exportFormat, true)} disabled={hiopos.exporting}>
                {hiopos.exporting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Generating...</> : <><Download className="h-4 w-4 mr-1" /> Generate HiOffice Bundle</>}
              </Button>

              {hiopos.exportResult?.success && (
                <ResultBox success message={hiopos.exportResult.message}>
                  <a href={hiopos.exportResult.downloadUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-2 text-xs underline"><Download className="h-3 w-3" /> Download bundle</a>
                  <div className="flex gap-2 pt-2">
                    <Badge variant={hiopos.bundleStatus === "sent" ? "default" : "secondary"}>{hiopos.bundleStatus === "ready" ? "Ready to import" : hiopos.bundleStatus === "sent" ? "Marked as sent" : hiopos.bundleStatus}</Badge>
                    {hiopos.bundleStatus === "ready" && <Button size="sm" variant="outline" onClick={hiopos.markBundleSent}>Mark as imported</Button>}
                  </div>
                </ResultBox>
              )}

              <div className="rounded-lg bg-muted/50 p-4 text-xs text-muted-foreground space-y-1">
                <p className="font-medium">Instructions:</p>
                <ol className="list-decimal list-inside space-y-0.5">
                  <li>Generate HiOffice Bundle</li>
                  <li>Download the file</li>
                  <li>Open HiOffice → Import/Export module</li>
                  <li>Import and verify products in HIOPOS</li>
                  <li>Mark as imported here</li>
                </ol>
              </div>
            </div>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(4)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button onClick={() => setStep(6)}>Next <ArrowRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 6: PortalRest API (Beta) ═══════════ */}
      {step === 6 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="h-5 w-5" /> PortalRest Orders API
            <Badge variant="outline" className="text-[10px]">Beta</Badge>
          </h2>

          {integrationMode !== "PORTALREST_ORDERS_API" ? (
            <div className="rounded-lg border border-muted p-6 text-center text-sm text-muted-foreground">
              <p>PortalRest API not enabled. Select it in Connection step.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
                <div className="flex gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
                  <div className="text-xs text-amber-700 dark:text-amber-300 space-y-1">
                    <p className="font-medium">Beta: API endpoints vary by installation</p>
                    <p>HIOPOS PortalRest API endpoints are not publicly documented. Use "Discover Endpoints" to probe your installation. Partner enablement in CLOUDLICENSE may be required.</p>
                  </div>
                </div>
              </div>

              {/* Discovery */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Endpoint Discovery</h3>
                <Button onClick={hiopos.discoverPortalRestEndpoints} disabled={hiopos.portalRestDiscovering} variant="outline">
                  {hiopos.portalRestDiscovering ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Probing...</> : <><Search className="h-4 w-4 mr-1" /> Discover Endpoints</>}
                </Button>

                {hiopos.portalRestDiscovery && (
                  <div className="space-y-2">
                    <ResultBox success={hiopos.portalRestDiscovery.success} message={hiopos.portalRestDiscovery.message} />
                    {hiopos.portalRestDiscovery.endpoints.length > 0 && (
                      <div className="rounded-lg border overflow-hidden">
                        <table className="w-full text-xs">
                          <thead><tr className="bg-muted"><th className="text-left p-2">Path</th><th className="text-left p-2">Status</th><th className="text-left p-2">Snippet</th></tr></thead>
                          <tbody>
                            {hiopos.portalRestDiscovery.endpoints.map((ep, i) => (
                              <tr key={i} className="border-t">
                                <td className="p-2 font-mono">{ep.path}</td>
                                <td className="p-2"><Badge variant={ep.status >= 200 && ep.status < 400 ? "default" : ep.status >= 400 && ep.status < 500 ? "secondary" : "destructive"} className="text-[10px]">{ep.status || "ERR"}</Badge></td>
                                <td className="p-2 max-w-[200px] truncate text-muted-foreground">{ep.snippet.slice(0, 80)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Fetch Sales */}
              <div className="space-y-3 pt-4 border-t">
                <h3 className="text-sm font-semibold">Fetch Recent Orders</h3>
                <div className="flex items-center gap-3">
                  <div className="w-32">
                    <Label className="text-xs">Hours back</Label>
                    <Input type="number" min={1} max={168} value={prHoursBack} onChange={(e) => setPrHoursBack(parseInt(e.target.value) || 24)} />
                  </div>
                  <Button onClick={() => hiopos.fetchPortalRestSales(prHoursBack)} disabled={hiopos.portalRestFetching} className="mt-5">
                    {hiopos.portalRestFetching ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Fetching...</> : "Fetch Orders"}
                  </Button>
                </div>

                {hiopos.portalRestSalesResult && (
                  <ResultBox success={hiopos.portalRestSalesResult.success} message={hiopos.portalRestSalesResult.message}>
                    {hiopos.portalRestSalesResult.success && (
                      <p className="text-xs mt-1">{hiopos.portalRestSalesResult.totalEvents} orders · {hiopos.portalRestSalesResult.totalLines} lines · {hiopos.portalRestSalesResult.duplicatesSkipped} dupes</p>
                    )}
                  </ResultBox>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(integrationMode === "PORTALREST_ORDERS_API" ? 0 : 5)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button onClick={() => setStep(7)}>Next <ArrowRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 7: Go Live ═══════════ */}
      {step === 7 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2"><BarChart3 className="h-5 w-5" /> Go Live & Diagnostics</h2>

          {/* Checklist */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Pre-flight Checklist</h3>
            <div className="space-y-2">
              {[
                { label: "Connection saved", pass: !!hiopos.connectionId },
                { label: "Connection tested", pass: hiopos.testStatus === "success" },
                { label: integrationMode === "PORTALREST_ORDERS_API" ? "PortalRest API configured" : "Files integration configured", pass: !!hiopos.connectionId },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-2 text-sm">
                  {item.pass ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <XCircle className="h-4 w-4 text-muted-foreground" />}
                  <span className={item.pass ? "text-foreground" : "text-muted-foreground"}>{item.label}</span>
                </div>
              ))}
            </div>
          </div>

          <Button onClick={hiopos.loadPricingDiagnostics} disabled={hiopos.pricingLoading} variant="outline" size="sm">
            {hiopos.pricingLoading ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Loading...</> : "Refresh Diagnostics"}
          </Button>

          {hiopos.pricingDiagnostics ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold text-foreground">{hiopos.pricingDiagnostics.total}</p>
                  <p className="text-xs text-muted-foreground">Total Wines</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold text-green-600">{hiopos.pricingDiagnostics.ready}</p>
                  <p className="text-xs text-muted-foreground">READY</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <p className="text-2xl font-bold text-amber-600">{hiopos.pricingDiagnostics.missing}</p>
                  <p className="text-xs text-muted-foreground">Missing / Not Ready</p>
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Format Coverage</h3>
                <div className="space-y-2">
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Bottle (BOT)</span><span>{hiopos.pricingDiagnostics.bottleCoverage}%</span></div>
                    <Progress value={hiopos.pricingDiagnostics.bottleCoverage} className="h-2" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Glass (COPA)</span><span>{hiopos.pricingDiagnostics.glassCoverage}%</span></div>
                    <Progress value={hiopos.pricingDiagnostics.glassCoverage} className="h-2" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>Magnum</span><span>{hiopos.pricingDiagnostics.magnumCoverage}%</span></div>
                    <Progress value={hiopos.pricingDiagnostics.magnumCoverage} className="h-2" />
                  </div>
                </div>
              </div>

              {hiopos.pricingDiagnostics.ready === 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
                  <div className="flex gap-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
                    <p className="text-xs text-amber-700 dark:text-amber-300">No wines are READY for export. Ensure wines have at least one price format (bottle, glass, or magnum) set.</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No data yet. Click "Refresh Diagnostics" to load.</p>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(6)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button 
              onClick={hiopos.enableSync}
              disabled={!hiopos.connectionId || hiopos.testStatus !== "success"}
            >
              <CheckCircle2 className="h-4 w-4 mr-1" /> Enable Sync
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
