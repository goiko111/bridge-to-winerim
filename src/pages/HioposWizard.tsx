import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, CheckCircle2, XCircle, Loader2, Upload, Download,
  FileText, Settings2, Package, FolderOpen, Info, Server, Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useHioposConnection, HioposIngestionMode } from "@/hooks/useHioposConnection";

const STEPS = ["Connection", "Sales Import", "Catalog Import", "Generate Export", "HiOffice"];

const STEP_ICONS = [Settings2, Upload, Package, Download, Server];

export default function HioposWizard() {
  const navigate = useNavigate();
  const hiopos = useHioposConnection();
  const [step, setStep] = useState(0);

  // Connection fields
  const [locationName, setLocationName] = useState("");
  const [ingestionMode, setIngestionMode] = useState<HioposIngestionMode>("MANUAL_UPLOAD");
  const [storeId, setStoreId] = useState("");
  const [timezone, setTimezone] = useState("Europe/Madrid");
  const [sftpHost, setSftpHost] = useState("");
  const [sftpPort, setSftpPort] = useState("22");
  const [sftpUser, setSftpUser] = useState("");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpPath, setSftpPath] = useState("/");
  const [useHioffice, setUseHioffice] = useState(false);

  // Sales import fields
  const [salesDateFrom, setSalesDateFrom] = useState("");
  const [salesDateTo, setSalesDateTo] = useState("");
  const [salesStore, setSalesStore] = useState("");
  const [salesRegister, setSalesRegister] = useState("");
  const salesFileRef = useRef<HTMLInputElement>(null);

  // Catalog import
  const catalogFileRef = useRef<HTMLInputElement>(null);

  // Export
  const [exportFormat, setExportFormat] = useState<"csv" | "xml">("csv");

  useEffect(() => {
    hiopos.loadExistingConnection().then((conn) => {
      if (conn) {
        setLocationName(conn.location_name || "");
        const cfg = conn.provider_config as any;
        if (cfg) {
          setIngestionMode(cfg.ingestion_mode || "MANUAL_UPLOAD");
          setStoreId(cfg.store_id || "");
          setTimezone(cfg.timezone || "Europe/Madrid");
          setUseHioffice(cfg.use_hioffice || false);
          if (cfg.sftp) {
            setSftpHost(cfg.sftp.host || "");
            setSftpPort(cfg.sftp.port || "22");
            setSftpUser(cfg.sftp.user || "");
            setSftpPath(cfg.sftp.path || "/");
          }
        }
      }
    });
  }, []);

  const canAdvance = () => {
    if (step === 0) return locationName.trim().length > 0;
    return true;
  };

  const handleSaveConnection = async () => {
    try {
      await hiopos.saveConnection({
        locationName, ingestionMode, storeId, timezone,
        sftpHost, sftpPort, sftpUser, sftpPassword, sftpPath,
        useHioffice,
      });
      await hiopos.testConnection();
    } catch (e: any) {
      console.error(e);
    }
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/integrations")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">HIOPOS Cloud</h1>
          <p className="text-sm text-muted-foreground">Export/Import file-based integration</p>
        </div>
      </div>

      {/* Step navigation */}
      <div className="flex items-center gap-1 overflow-x-auto pb-2">
        {STEPS.map((s, i) => {
          const Icon = STEP_ICONS[i];
          const isActive = i === step;
          const isDone = i < step;
          return (
            <button
              key={s}
              onClick={() => setStep(i)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : isDone
                  ? "bg-primary/10 text-primary"
                  : "bg-secondary text-muted-foreground hover:bg-secondary/80"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {s}
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
                <p className="font-medium">HIOPOS Cloud Export-Based Integration</p>
                <p>HIOPOS doesn't offer a public API. Instead, you can export sales & articles as CSV/XML from the POS admin panel, and upload them here.</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <Label>Location name *</Label>
              <Input value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder="e.g. Restaurant Madrid Centro" />
            </div>

            <div>
              <Label>Store ID (optional)</Label>
              <Input value={storeId} onChange={(e) => setStoreId(e.target.value)} placeholder="HIOPOS store identifier" />
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
                <div className="flex items-center gap-2 rounded-lg border p-3 opacity-60">
                  <RadioGroupItem value="SFTP_DROP" id="sftp" disabled />
                  <Label htmlFor="sftp" className="cursor-pointer flex-1">
                    <span className="font-medium">Scheduled File Drop (SFTP)</span>
                    <p className="text-xs text-muted-foreground">Coming soon — auto-fetch from SFTP/HTTPS</p>
                  </Label>
                  <Badge variant="outline" className="text-[10px]">Future</Badge>
                </div>
              </RadioGroup>
            </div>

            {ingestionMode === "SFTP_DROP" && (
              <div className="space-y-3 rounded-lg border p-4 bg-secondary/30">
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>SFTP Host</Label><Input value={sftpHost} onChange={(e) => setSftpHost(e.target.value)} /></div>
                  <div><Label>Port</Label><Input value={sftpPort} onChange={(e) => setSftpPort(e.target.value)} /></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Username</Label><Input value={sftpUser} onChange={(e) => setSftpUser(e.target.value)} /></div>
                  <div><Label>Password</Label><Input type="password" value={sftpPassword} onChange={(e) => setSftpPassword(e.target.value)} /></div>
                </div>
                <div><Label>Remote Path</Label><Input value={sftpPath} onChange={(e) => setSftpPath(e.target.value)} /></div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Switch checked={useHioffice} onCheckedChange={setUseHioffice} />
              <Label>We use HiOffice Import/Export module</Label>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-4 border-t">
            {!hiopos.connectionId ? (
              <Button onClick={handleSaveConnection} disabled={!canAdvance()}>
                Save & Validate
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                {hiopos.testStatus === "success" && <CheckCircle2 className="h-5 w-5 text-green-500" />}
                {hiopos.testStatus === "error" && <XCircle className="h-5 w-5 text-destructive" />}
                <span className="text-sm">
                  {hiopos.testStatus === "success" ? "Connection saved" : hiopos.testStatus === "error" ? hiopos.testError : "Saved"}
                </span>
              </div>
            )}
            <div className="flex-1" />
            <Button onClick={() => setStep(1)} disabled={!hiopos.connectionId}>
              Next <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 1: Sales Import ═══════════ */}
      {step === 1 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Upload className="h-5 w-5" /> Upload Sales Export
          </h2>
          <p className="text-sm text-muted-foreground">
            Export your sales from HIOPOS (CSV or XML) and upload them here. We'll parse and store them as canonical events.
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div><Label>Date from (optional)</Label><Input type="date" value={salesDateFrom} onChange={(e) => setSalesDateFrom(e.target.value)} /></div>
            <div><Label>Date to (optional)</Label><Input type="date" value={salesDateTo} onChange={(e) => setSalesDateTo(e.target.value)} /></div>
            <div><Label>Store (optional)</Label><Input value={salesStore} onChange={(e) => setSalesStore(e.target.value)} placeholder="Filter by store" /></div>
            <div><Label>Register (optional)</Label><Input value={salesRegister} onChange={(e) => setSalesRegister(e.target.value)} placeholder="Filter by register/caja" /></div>
          </div>

          <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 p-8 text-center">
            <FileText className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground mb-3">Drag & drop or click to select CSV/XML sales export</p>
            <input ref={salesFileRef} type="file" accept=".csv,.xml" className="hidden" id="sales-file" />
            <Button variant="outline" onClick={() => salesFileRef.current?.click()}>
              <FolderOpen className="h-4 w-4 mr-1" /> Choose File
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSalesUpload} disabled={hiopos.salesImporting}>
              {hiopos.salesImporting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Importing...</> : "Import Sales"}
            </Button>
            {hiopos.lastImportedFile && (
              <span className="text-xs text-muted-foreground">Last file: {hiopos.lastImportedFile}</span>
            )}
          </div>

          {hiopos.salesImportResult && (
            <div className={`rounded-lg p-4 text-sm ${hiopos.salesImportResult.success ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300" : "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300"}`}>
              <p className="font-medium">{hiopos.salesImportResult.message}</p>
              {hiopos.salesImportResult.success && (
                <p className="text-xs mt-1">
                  {hiopos.salesImportResult.totalEvents} tickets · {hiopos.salesImportResult.totalLines} lines · {hiopos.salesImportResult.duplicatesSkipped} duplicates skipped
                </p>
              )}
            </div>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(0)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button onClick={() => setStep(2)}>Next <ArrowRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 2: Catalog Import ═══════════ */}
      {step === 2 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Package className="h-5 w-5" /> Upload Articles Export
          </h2>
          <p className="text-sm text-muted-foreground">
            Export your articles/items from HIOPOS and upload the CSV or XML file. We'll map them to the product catalog.
          </p>

          <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 p-8 text-center">
            <FileText className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground mb-3">Drag & drop or click to select CSV/XML articles export</p>
            <input ref={catalogFileRef} type="file" accept=".csv,.xml" className="hidden" id="catalog-file" />
            <Button variant="outline" onClick={() => catalogFileRef.current?.click()}>
              <FolderOpen className="h-4 w-4 mr-1" /> Choose File
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleCatalogUpload} disabled={hiopos.catalogImporting}>
              {hiopos.catalogImporting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Importing...</> : "Import Catalog"}
            </Button>
          </div>

          {hiopos.catalogImportResult && (
            <div className={`rounded-lg p-4 text-sm ${hiopos.catalogImportResult.success ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300" : "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300"}`}>
              <p className="font-medium">{hiopos.catalogImportResult.message}</p>
              {hiopos.catalogImportResult.success && (
                <p className="text-xs mt-1">{hiopos.catalogImportResult.inserted} new · {hiopos.catalogImportResult.updated} updated</p>
              )}
            </div>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(1)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button onClick={() => setStep(3)}>Next <ArrowRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 3: Generate Export ═══════════ */}
      {step === 3 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Download className="h-5 w-5" /> Generate HIOPOS Import File
          </h2>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
            <div className="flex gap-2">
              <Info className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="text-xs text-amber-700 dark:text-amber-300 space-y-1">
                <p className="font-medium">Read-only safe export</p>
                <p>This generates a file you can manually import into HIOPOS. Only wines with <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded">pricing_status = READY</code> will be included. No automatic writes.</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <Label>Export Format</Label>
              <RadioGroup value={exportFormat} onValueChange={(v) => setExportFormat(v as "csv" | "xml")} className="flex gap-4 mt-2">
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="csv" id="csv" />
                  <Label htmlFor="csv">CSV (semicolon-separated)</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="xml" id="xml" />
                  <Label htmlFor="xml">XML</Label>
                </div>
              </RadioGroup>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
              <p>• Each wine generates separate items for BOT (Botella), COPA, and MAGNUM formats</p>
              <p>• Codes prefixed with <code className="bg-muted px-1 rounded">WINERIM_</code> for traceability</p>
              <p>• Includes: name, family, VAT, sale price</p>
            </div>
          </div>

          <Button onClick={() => hiopos.generateImportFile(exportFormat, false)} disabled={hiopos.exporting}>
            {hiopos.exporting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Generating...</> : <><Download className="h-4 w-4 mr-1" /> Generate File</>}
          </Button>

          {hiopos.exportResult && (
            <div className={`rounded-lg p-4 text-sm ${hiopos.exportResult.success ? "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300" : "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300"}`}>
              <p className="font-medium">{hiopos.exportResult.message}</p>
              {hiopos.exportResult.success && hiopos.exportResult.downloadUrl && (
                <a href={hiopos.exportResult.downloadUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-2 text-xs underline">
                  <Download className="h-3 w-3" /> Download file
                </a>
              )}
            </div>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(2)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button onClick={() => setStep(4)}>Next <ArrowRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 4: HiOffice ═══════════ */}
      {step === 4 && (
        <div className="space-y-6 rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Server className="h-5 w-5" /> HiOffice B2B Import/Export
          </h2>

          {!useHioffice ? (
            <div className="rounded-lg border border-muted p-6 text-center text-sm text-muted-foreground">
              <p>HiOffice module not enabled.</p>
              <p className="mt-1">Go back to step 1 and enable "We use HiOffice Import/Export module" to activate this feature.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30">
                <div className="flex gap-2">
                  <Info className="h-4 w-4 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0" />
                  <div className="text-xs text-blue-700 dark:text-blue-300 space-y-1">
                    <p className="font-medium">HiOffice Import/Export Module</p>
                    <p>Generate an import bundle compatible with HiOffice's B2B module. Download it and import via HiOffice → Import/Export.</p>
                  </div>
                </div>
              </div>

              <div>
                <Label>Export Format</Label>
                <RadioGroup value={exportFormat} onValueChange={(v) => setExportFormat(v as "csv" | "xml")} className="flex gap-4 mt-2">
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="csv" id="ho-csv" />
                    <Label htmlFor="ho-csv">CSV</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="xml" id="ho-xml" />
                    <Label htmlFor="ho-xml">XML</Label>
                  </div>
                </RadioGroup>
              </div>

              <Button onClick={() => hiopos.generateImportFile(exportFormat, true)} disabled={hiopos.exporting}>
                {hiopos.exporting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Generating...</> : <><Download className="h-4 w-4 mr-1" /> Generate HiOffice Bundle</>}
              </Button>

              {hiopos.exportResult && hiopos.exportResult.success && (
                <div className="rounded-lg bg-green-50 dark:bg-green-950/30 p-4 text-sm text-green-700 dark:text-green-300 space-y-2">
                  <p className="font-medium">{hiopos.exportResult.message}</p>
                  <a href={hiopos.exportResult.downloadUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs underline">
                    <Download className="h-3 w-3" /> Download bundle
                  </a>
                  <div className="flex gap-2 pt-2">
                    <Badge variant={hiopos.bundleStatus === "sent" ? "default" : "secondary"}>
                      {hiopos.bundleStatus === "ready" ? "Ready to import" : hiopos.bundleStatus === "sent" ? "Marked as sent" : hiopos.bundleStatus}
                    </Badge>
                    {hiopos.bundleStatus === "ready" && (
                      <Button size="sm" variant="outline" onClick={hiopos.markBundleSent}>
                        Mark as imported
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="rounded-lg bg-muted/50 p-4 text-xs text-muted-foreground space-y-1">
                <p className="font-medium">Instructions:</p>
                <ol className="list-decimal list-inside space-y-0.5">
                  <li>Click "Generate HiOffice Bundle"</li>
                  <li>Download the generated file</li>
                  <li>Open HiOffice → Import/Export module</li>
                  <li>Select "Import" and choose the downloaded file</li>
                  <li>Verify products appear in HIOPOS</li>
                  <li>Come back here and click "Mark as imported"</li>
                </ol>
              </div>
            </div>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" onClick={() => setStep(3)}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <Button onClick={() => hiopos.enableSync()}>
              <CheckCircle2 className="h-4 w-4 mr-1" /> Enable Connection
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
