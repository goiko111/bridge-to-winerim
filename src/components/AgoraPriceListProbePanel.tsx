import { useState } from "react";
import { Loader2, FlaskConical, CheckCircle2, XCircle, AlertTriangle, Download, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface ProbeResult {
  success: boolean;
  diagnosis: string;
  probe_product_id: string;
  probe_started: string;
  probe_finished: string;
  import_success: boolean;
  import_error: string | null;
  product_found_in_export: boolean;
  sent_price_list_count: number;
  sent_price_list_ids: string[];
  sent_price_list_names: Record<string, string>;
  actual_price_list_count: number;
  actual_price_list_ids: string[];
  actual_prices: { priceListId: string; priceListName: string; mainPrice: string }[];
  missing_in_agora: string[];
  missing_in_agora_names: string[];
  extra_in_agora: string[];
  persisted_all: boolean;
  conclusion: string;
  xml_sent: string;
  import_raw_response: string;
}

interface Props {
  connectionId: string | null;
}

export default function AgoraPriceListProbePanel({ connectionId }: Props) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const runProbe = async () => {
    if (!connectionId) return;
    setRunning(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "probe-pricelist-persistence", connectionId },
      });
      if (error) throw error;
      setResult(data as ProbeResult);
      toast({
        title: "Probe complete",
        description: data?.diagnosis === "ALL_PRICELISTS_PERSISTED"
          ? "All PriceLists persisted correctly."
          : `Diagnosis: ${data?.diagnosis}`,
      });
    } catch (e: any) {
      toast({ title: "Probe failed", description: e.message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  const exportBundle = () => {
    if (!result) return;
    const bundle = {
      _type: "agora_pricelist_persistence_probe",
      _exported_at: new Date().toISOString(),
      _connection_id: connectionId,
      ...result,
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pricelist-probe-${connectionId?.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Diagnostic bundle downloaded" });
  };

  const copyConclusion = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.conclusion);
    toast({ title: "Copied to clipboard" });
  };

  const diagnosisColor = (d: string) => {
    if (d === "ALL_PRICELISTS_PERSISTED") return "text-emerald-600";
    if (d === "IMPORT_DID_NOT_PERSIST_ALL_PRICELISTS") return "text-amber-600";
    return "text-destructive";
  };

  const diagnosisIcon = (d: string) => {
    if (d === "ALL_PRICELISTS_PERSISTED") return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    if (d === "IMPORT_DID_NOT_PERSIST_ALL_PRICELISTS") return <AlertTriangle className="h-4 w-4 text-amber-600" />;
    return <XCircle className="h-4 w-4 text-destructive" />;
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">PriceList Persistence Probe</h3>
        <Badge variant="outline" className="text-[9px] ml-auto">Diagnostic • Non-destructive</Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        Creates a disposable test product (Id 999999, not sellable) with ALL active PriceLists, imports it into Agora,
        reads it back, and compares sent vs persisted. Use the exported evidence to share with Agora support.
      </p>

      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={runProbe} disabled={running || !connectionId}>
          {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-2 h-4 w-4" />}
          {running ? "Running probe…" : "Run Probe"}
        </Button>
        {result && (
          <>
            <Button variant="outline" size="sm" onClick={exportBundle}>
              <Download className="mr-2 h-4 w-4" /> Export for Support
            </Button>
            <Button variant="ghost" size="sm" onClick={copyConclusion}>
              <Copy className="mr-2 h-4 w-4" /> Copy Conclusion
            </Button>
          </>
        )}
      </div>

      {result && (
        <div className="space-y-3">
          {/* Conclusion banner */}
          <div className={`rounded-lg border p-3 ${
            result.persisted_all
              ? "border-emerald-500/30 bg-emerald-500/5"
              : result.diagnosis === "IMPORT_DID_NOT_PERSIST_ALL_PRICELISTS"
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-destructive/30 bg-destructive/5"
          }`}>
            <div className="flex items-start gap-2">
              {diagnosisIcon(result.diagnosis)}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${diagnosisColor(result.diagnosis)}`}>
                  {result.diagnosis.replace(/_/g, " ")}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{result.conclusion}</p>
              </div>
            </div>
          </div>

          {/* Summary grid */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg border border-border bg-secondary/20 p-2">
              <p className="text-lg font-bold text-primary">{result.sent_price_list_count}</p>
              <p className="text-[10px] text-muted-foreground">Sent in XML</p>
            </div>
            <div className="rounded-lg border border-border bg-secondary/20 p-2">
              <p className={`text-lg font-bold ${result.persisted_all ? "text-emerald-600" : "text-amber-600"}`}>
                {result.actual_price_list_count}
              </p>
              <p className="text-[10px] text-muted-foreground">Persisted by Agora</p>
            </div>
            <div className="rounded-lg border border-border bg-secondary/20 p-2">
              <p className={`text-lg font-bold ${result.missing_in_agora.length > 0 ? "text-destructive" : "text-emerald-600"}`}>
                {result.missing_in_agora.length}
              </p>
              <p className="text-[10px] text-muted-foreground">Missing</p>
            </div>
          </div>

          {/* Details */}
          <details className="group">
            <summary className="text-[11px] font-medium text-foreground cursor-pointer hover:text-primary">
              Detailed comparison
            </summary>
            <div className="mt-2 rounded border border-border bg-secondary/20 p-3 space-y-2 text-[10px]">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="font-medium text-foreground mb-1">Sent in XML ({result.sent_price_list_count} PLs):</p>
                  {result.sent_price_list_ids.map(id => (
                    <p key={id} className="font-mono">
                      PL {id} — {result.sent_price_list_names[id] || "?"}
                      {result.missing_in_agora.includes(id) && (
                        <span className="text-destructive ml-1">❌ NOT persisted</span>
                      )}
                    </p>
                  ))}
                </div>
                <div>
                  <p className="font-medium text-foreground mb-1">Actual in Agora ({result.actual_price_list_count} PLs):</p>
                  {result.actual_prices.length > 0 ? result.actual_prices.map((ap, i) => (
                    <p key={i} className="font-mono">
                      PL {ap.priceListId} — {ap.priceListName} → €{ap.mainPrice}
                    </p>
                  )) : (
                    <p className="text-destructive">
                      {result.product_found_in_export ? "No prices found" : "Product not found in export"}
                    </p>
                  )}
                </div>
              </div>

              {result.missing_in_agora.length > 0 && (
                <div className="rounded border border-destructive/20 bg-destructive/5 p-2">
                  <p className="font-medium text-destructive">Missing PriceLists (sent but not persisted):</p>
                  {result.missing_in_agora.map(id => (
                    <p key={id} className="font-mono text-destructive">
                      PL {id} — {result.sent_price_list_names[id] || "?"}
                    </p>
                  ))}
                </div>
              )}

              <p className="text-muted-foreground">
                Probe product: Id {result.probe_product_id} • Import: {result.import_success ? "✅ OK" : `❌ ${result.import_error}`}
                • Duration: {new Date(result.probe_finished).getTime() - new Date(result.probe_started).getTime()}ms
              </p>
            </div>
          </details>

          {/* XML sent */}
          <details className="group">
            <summary className="text-[11px] font-medium text-foreground cursor-pointer hover:text-primary">
              XML sent to Agora
            </summary>
            <pre className="mt-1 rounded border border-border bg-secondary/30 p-2 text-[10px] font-mono max-h-48 overflow-y-auto whitespace-pre-wrap">
              {result.xml_sent}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}