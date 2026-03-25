import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Search, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";

interface DiagnoseProbe {
  endpoint: string;
  http_status: number | null;
  success: boolean;
  error: string | null;
  detail: Record<string, unknown>;
}

interface Props {
  activeTpvId: string | null;
  diagnosing: boolean;
  diagnosisResult: Record<string, unknown> | null;
  onDiagnose: () => void;
}

export default function NumierTpvDiagnostics({ activeTpvId, diagnosing, diagnosisResult, onDiagnose }: Props) {
  const conclusion = diagnosisResult?.conclusion as string | undefined;
  const warnings = (diagnosisResult?.warnings || []) as string[];
  const probes = (diagnosisResult?.probes || []) as DiagnoseProbe[];

  const conclusionIcon = conclusion === "valid"
    ? <CheckCircle2 className="h-5 w-5 text-emerald-500" />
    : conclusion === "suspicious"
    ? <AlertTriangle className="h-5 w-5 text-amber-500" />
    : conclusion === "invalid"
    ? <XCircle className="h-5 w-5 text-destructive" />
    : null;

  const conclusionBadge = conclusion === "valid"
    ? <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">Valid</Badge>
    : conclusion === "suspicious"
    ? <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">Suspicious</Badge>
    : conclusion === "invalid"
    ? <Badge variant="destructive">Invalid</Badge>
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Search className="h-5 w-5" /> TPV Diagnosis
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Validates that the selected TPV id works correctly against Numier's sales, categories and products endpoints.
        </p>

        <Button onClick={onDiagnose} disabled={diagnosing || !activeTpvId} className="w-full">
          {diagnosing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {diagnosing ? "Diagnosing…" : `Diagnose TPV ${activeTpvId || "(none)"}`}
        </Button>

        {diagnosisResult && diagnosisResult.success && (
          <div className="space-y-4">
            {/* Conclusion */}
            <div className="flex items-center gap-3 p-3 rounded-md bg-muted border border-border">
              {conclusionIcon}
              <div className="flex-1">
                <span className="text-sm font-medium text-foreground">
                  TPV <code className="text-xs bg-background px-1 rounded">{diagnosisResult.tpv_id as string}</code>
                </span>
              </div>
              {conclusionBadge}
            </div>

            {/* Warnings */}
            {warnings.length > 0 && (
              <div className="space-y-1">
                {warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 p-2 rounded">
                    <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Probe details */}
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Endpoint Probes</h4>
              {probes.map((probe, i) => (
                <div key={i} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <code className="text-xs text-foreground">{probe.endpoint}</code>
                    <div className="flex items-center gap-2">
                      {probe.http_status && (
                        <Badge variant="outline" className="text-xs">{probe.http_status}</Badge>
                      )}
                      {probe.success
                        ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        : <XCircle className="h-4 w-4 text-destructive" />}
                    </div>
                  </div>
                  {probe.error && (
                    <p className="text-xs text-destructive">{probe.error}</p>
                  )}
                  {/* Render detail key-value pairs */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {Object.entries(probe.detail).map(([key, val]) => {
                      if (key === "sample" || key === "location_ids") return null;
                      return (
                        <div key={key} className="flex justify-between text-xs col-span-2">
                          <span className="text-muted-foreground">{key.replace(/_/g, " ")}</span>
                          <span className="font-mono text-foreground">
                            {typeof val === "boolean" ? (val ? "✅" : "❌") : typeof val === "object" && val !== null ? JSON.stringify(val) : String(val ?? "—")}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {diagnosisResult && !diagnosisResult.success && (
          <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-md">
            <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{(diagnosisResult.error || diagnosisResult.message) as string}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
