import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeftRight, Download, AlertTriangle, CheckCircle2, XCircle, HelpCircle } from "lucide-react";
import { toast } from "@/hooks/use-toast";

interface ConnectionSummary {
  id: string;
  location_name: string;
}

interface DiagnosticBundle {
  connection: {
    id: string;
    location_name: string;
    write_mode: string;
    write_bottle: boolean;
    write_glass: boolean;
    default_family_id: string | null;
    default_vat_id: string | null;
    selected_sale_center_ids: string[];
  };
  sale_centers: { Id: string; Name: string; CurrentPriceListId?: string }[];
  price_lists: { Id: string; Name: string }[];
  families_count: number;
  missing_prices: { agora_id: string; name: string; price_list: string; issue: string }[];
  sample_xml: string;
  recent_tasks: { id: string; status: string; task_type: string; last_error: string | null; payload_json: Record<string, unknown> }[];
}

interface ConnectionDiag {
  bundle: DiagnosticBundle | null;
  loading: boolean;
  error: string | null;
  // Computed from DB
  providerProductCount: number;
  wineCandidateCount: number;
  confirmedMappings: number;
  pendingMappings: number;
  xmlImportMappings: number;
  capabilityStatus: string;
  classificationSamples: { name: string; family: string | null; is_wine: boolean; score: number; reasons: string[] }[];
}

const EMPTY_DIAG: ConnectionDiag = {
  bundle: null, loading: false, error: null,
  providerProductCount: 0, wineCandidateCount: 0, confirmedMappings: 0, pendingMappings: 0,
  xmlImportMappings: 0, capabilityStatus: "UNKNOWN", classificationSamples: [],
};

export default function AgoraConnectionCompare() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [connA, setConnA] = useState("");
  const [connB, setConnB] = useState("");
  const [diagA, setDiagA] = useState<ConnectionDiag>({ ...EMPTY_DIAG });
  const [diagB, setDiagB] = useState<ConnectionDiag>({ ...EMPTY_DIAG });

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("pos_connections").select("id, location_name").eq("provider", "agora");
      if (data) setConnections(data);
      if (data && data.length >= 2) {
        setConnA(data[0].id);
        setConnB(data[1].id);
      }
    })();
  }, []);

  async function loadDiag(connectionId: string, setter: (d: ConnectionDiag) => void) {
    setter({ ...EMPTY_DIAG, loading: true });
    try {
      // Parallel fetches: debug-bundle + DB queries
      const [bundleRes, productsRes, mappingsRes, capsRes] = await Promise.all([
        supabase.functions.invoke("agora-proxy", { body: { action: "debug-bundle", connectionId } }),
        supabase.from("provider_products").select("name, family, is_wine_candidate, wine_score, wine_reasons, classification_override")
          .eq("connection_id", connectionId).limit(500),
        supabase.from("product_mappings").select("status, match_method").eq("connection_id", connectionId),
        supabase.from("provider_capabilities").select("can_write_products").eq("connection_id", connectionId).single(),
      ]);

      const bundle = bundleRes.data as DiagnosticBundle | null;
      const products = productsRes.data || [];
      const mappings = mappingsRes.data || [];

      const wineCandidates = products.filter((p: any) => {
        if (p.classification_override === "WINE") return true;
        if (p.classification_override === "NOT_WINE") return false;
        return p.is_wine_candidate;
      });

      const samples = products.slice(0, 10).map((p: any) => ({
        name: p.name,
        family: p.family,
        is_wine: p.classification_override === "WINE" || (p.classification_override !== "NOT_WINE" && p.is_wine_candidate),
        score: p.wine_score || 0,
        reasons: p.wine_reasons || [],
      }));

      setter({
        bundle,
        loading: false,
        error: bundleRes.error ? String(bundleRes.error.message) : null,
        providerProductCount: products.length,
        wineCandidateCount: wineCandidates.length,
        confirmedMappings: mappings.filter((m: any) => m.status === "CONFIRMED").length,
        pendingMappings: mappings.filter((m: any) => m.status === "PENDING").length,
        xmlImportMappings: mappings.filter((m: any) => m.match_method === "XML_IMPORT").length,
        capabilityStatus: capsRes.data?.can_write_products || "UNKNOWN",
        classificationSamples: samples,
      });
    } catch (e) {
      setter({ ...EMPTY_DIAG, error: String(e) });
    }
  }

  function runCompare() {
    if (!connA || !connB) {
      toast({ title: "Select two connections", variant: "destructive" });
      return;
    }
    loadDiag(connA, setDiagA);
    loadDiag(connB, setDiagB);
  }

  function exportCompare() {
    const data = { generated_at: new Date().toISOString(), connectionA: diagA, connectionB: diagB };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `agora-compare-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  const loading = diagA.loading || diagB.loading;

  function StatusIcon({ ok }: { ok: boolean | null }) {
    if (ok === null) return <HelpCircle className="h-4 w-4 text-muted-foreground" />;
    return ok ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <XCircle className="h-4 w-4 text-red-500" />;
  }

  function renderColumn(diag: ConnectionDiag, label: string) {
    if (diag.loading) return <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading {label}...</div>;
    if (diag.error) return <div className="text-sm text-destructive">{diag.error}</div>;
    if (!diag.bundle) return <div className="text-sm text-muted-foreground">Not loaded</div>;
    const b = diag.bundle;
    const taskSuccess = b.recent_tasks.filter(t => t.status === "SUCCESS").length;
    const taskFailed = b.recent_tasks.filter(t => t.status === "FAILED").length;
    const persistErrors = b.recent_tasks.filter(t => t.last_error?.includes("IMPORT_DID_NOT_PERSIST")).length;

    return (
      <div className="space-y-3 text-sm">
        <div className="font-semibold text-base">{b.connection.location_name}</div>

        {/* Layer 1: Import */}
        <div className="border rounded p-2 space-y-1">
          <div className="font-medium text-xs uppercase text-muted-foreground">Import Layer</div>
          <Row label="Write Mode" value={b.connection.write_mode} />
          <Row label="Capability" value={diag.capabilityStatus} badge badgeVariant={diag.capabilityStatus === "YES" ? "default" : "destructive"} />
          <Row label="XML Import Mappings" value={String(diag.xmlImportMappings)} />
          <Row label="Tasks: Success" value={String(taskSuccess)} />
          <Row label="Tasks: Failed" value={String(taskFailed)} />
          <Row label="Persist Errors" value={String(persistErrors)} highlight={persistErrors > 0} />
        </div>

        {/* Layer 2: Persistence */}
        <div className="border rounded p-2 space-y-1">
          <div className="font-medium text-xs uppercase text-muted-foreground">Persistence Layer</div>
          <Row label="SaleCenters" value={String(b.sale_centers.length)} />
          <Row label="PriceLists" value={String(b.price_lists.length)} />
          <Row label="Selected SaleCenters" value={String(b.connection.selected_sale_center_ids.length)} />
          <Row label="Families (Agora)" value={String(b.families_count)} />
          <Row label="Missing Prices" value={String(b.missing_prices.length)} highlight={b.missing_prices.length > 0} />
        </div>

        {/* Layer 3: Classification */}
        <div className="border rounded p-2 space-y-1">
          <div className="font-medium text-xs uppercase text-muted-foreground">Classification Layer</div>
          <Row label="POS Products" value={String(diag.providerProductCount)} />
          <Row label="Wine Candidates" value={String(diag.wineCandidateCount)} highlight={diag.wineCandidateCount === 0} />
          {diag.classificationSamples.length > 0 && (
            <div className="mt-2">
              <div className="text-xs font-medium mb-1">Sample Classifications:</div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {diag.classificationSamples.map((s, i) => (
                  <div key={i} className="flex items-start gap-1 text-xs">
                    <StatusIcon ok={s.is_wine} />
                    <div>
                      <span className="font-mono">{s.name?.substring(0, 30)}</span>
                      {s.family && <span className="text-muted-foreground ml-1">[{s.family}]</span>}
                      <span className="ml-1 text-muted-foreground">score={s.score}</span>
                      {s.reasons.length > 0 && (
                        <div className="text-muted-foreground">{s.reasons.join(", ")}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Layer 4: Matching */}
        <div className="border rounded p-2 space-y-1">
          <div className="font-medium text-xs uppercase text-muted-foreground">Matching Layer</div>
          <Row label="Confirmed Mappings" value={String(diag.confirmedMappings)} />
          <Row label="Pending Mappings" value={String(diag.pendingMappings)} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select className="border rounded px-2 py-1 text-sm bg-background" value={connA} onChange={e => setConnA(e.target.value)}>
          {connections.map(c => <option key={c.id} value={c.id}>{c.location_name} ({c.id.substring(0, 8)})</option>)}
        </select>
        <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
        <select className="border rounded px-2 py-1 text-sm bg-background" value={connB} onChange={e => setConnB(e.target.value)}>
          {connections.map(c => <option key={c.id} value={c.id}>{c.location_name} ({c.id.substring(0, 8)})</option>)}
        </select>
        <Button size="sm" onClick={runCompare} disabled={loading || !connA || !connB}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ArrowLeftRight className="h-4 w-4 mr-1" />}
          Compare
        </Button>
        {(diagA.bundle || diagB.bundle) && (
          <Button size="sm" variant="outline" onClick={exportCompare}>
            <Download className="h-4 w-4 mr-1" /> Export
          </Button>
        )}
      </div>

      {/* Divergence summary */}
      {diagA.bundle && diagB.bundle && !loading && (
        <DivergenceSummary a={diagA} b={diagB} />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>{renderColumn(diagA, "A")}</div>
        <div>{renderColumn(diagB, "B")}</div>
      </div>
    </div>
  );
}

function Row({ label, value, badge, badgeVariant, highlight }: {
  label: string; value: string; badge?: boolean;
  badgeVariant?: "default" | "destructive" | "secondary" | "outline";
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      {badge ? (
        <Badge variant={badgeVariant || "secondary"}>{value}</Badge>
      ) : (
        <span className={highlight ? "text-destructive font-semibold" : "font-medium"}>{value}</span>
      )}
    </div>
  );
}

function DivergenceSummary({ a, b }: { a: ConnectionDiag; b: ConnectionDiag }) {
  const issues: { layer: string; detail: string; severity: "error" | "warn" | "info" }[] = [];

  // Import layer
  if (a.capabilityStatus !== b.capabilityStatus)
    issues.push({ layer: "Import", detail: `Capability differs: ${a.capabilityStatus} vs ${b.capabilityStatus}`, severity: "warn" });
  if (a.xmlImportMappings === 0 && b.xmlImportMappings > 0)
    issues.push({ layer: "Import", detail: `Connection A has 0 XML import mappings while B has ${b.xmlImportMappings}`, severity: "error" });
  if (b.xmlImportMappings === 0 && a.xmlImportMappings > 0)
    issues.push({ layer: "Import", detail: `Connection B has 0 XML import mappings while A has ${a.xmlImportMappings}`, severity: "error" });

  // Persistence
  if (a.bundle && b.bundle) {
    if (a.bundle.price_lists.length !== b.bundle.price_lists.length)
      issues.push({ layer: "Persistence", detail: `PriceList count differs: ${a.bundle.price_lists.length} vs ${b.bundle.price_lists.length}`, severity: "info" });
    const aMissing = a.bundle.missing_prices.length;
    const bMissing = b.bundle.missing_prices.length;
    if (aMissing > 0 && bMissing === 0)
      issues.push({ layer: "Persistence", detail: `Connection A has ${aMissing} missing prices, B has none`, severity: "error" });
    if (bMissing > 0 && aMissing === 0)
      issues.push({ layer: "Persistence", detail: `Connection B has ${bMissing} missing prices, A has none`, severity: "error" });
  }

  // Classification
  if (a.wineCandidateCount === 0 && b.wineCandidateCount > 0)
    issues.push({ layer: "Classification", detail: `Connection A has 0 wine candidates while B has ${b.wineCandidateCount}`, severity: "error" });
  if (b.wineCandidateCount === 0 && a.wineCandidateCount > 0)
    issues.push({ layer: "Classification", detail: `Connection B has 0 wine candidates while A has ${a.wineCandidateCount}`, severity: "error" });
  if (a.providerProductCount === 0 && b.providerProductCount > 0)
    issues.push({ layer: "Classification", detail: `Connection A has 0 POS products — catalog may not have synced`, severity: "error" });

  // Matching
  if (a.confirmedMappings === 0 && b.confirmedMappings > 0)
    issues.push({ layer: "Matching", detail: `Connection A has 0 confirmed mappings while B has ${b.confirmedMappings}`, severity: "error" });

  if (issues.length === 0) {
    return (
      <div className="bg-green-500/10 border border-green-500/20 rounded p-3 flex items-center gap-2 text-sm">
        <CheckCircle2 className="h-4 w-4 text-green-500" />
        No significant divergences found between connections.
      </div>
    );
  }

  return (
    <div className="border rounded p-3 space-y-2">
      <div className="font-medium text-sm flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-yellow-500" />
        Divergences Found ({issues.length})
      </div>
      {issues.map((issue, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          <Badge variant={issue.severity === "error" ? "destructive" : issue.severity === "warn" ? "outline" : "secondary"} className="text-[10px] shrink-0">
            {issue.layer}
          </Badge>
          <span>{issue.detail}</span>
        </div>
      ))}
    </div>
  );
}
