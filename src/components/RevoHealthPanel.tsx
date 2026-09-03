import { useState, useCallback } from "react";
import { Shield, RefreshCw, Loader2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { StatusBadge, type DimensionStatus } from "@/components/ReadinessBadges";

interface HealthCheck {
  status: "OK" | "FAIL" | "WARN";
  message: string;
  timestamp?: string;
}

interface HealthResult {
  overallStatus: "VERIFIED" | "PARTIAL" | "ERROR";
  checks: Record<string, HealthCheck>;
}

const CHECK_LABELS: Record<string, string> = {
  auth: "Auth",
  sales_read: "Sales Read",
  catalog_sync: "Catalog Sync",
  dependencies: "Dependencies",
  write_verification: "Write Verification",
  last_sync: "Last Sync",
  last_catalog_sync: "Last Catalog Sync",
};

function checkToDimension(status: "OK" | "FAIL" | "WARN"): DimensionStatus {
  if (status === "OK") return "VERIFIED";
  if (status === "WARN") return "PARTIAL";
  return "ERROR";
}

function overallToDimension(status: string): DimensionStatus {
  if (status === "VERIFIED") return "VERIFIED";
  if (status === "PARTIAL") return "PARTIAL";
  return "ERROR";
}

const OVERALL_LABELS: Record<string, string> = {
  VERIFIED: "Fully Ready",
  PARTIAL: "Partially Ready",
  ERROR: "Not Ready",
};

export default function RevoHealthPanel({
  connectionId,
}: {
  connectionId: string | null;
}) {
  const [result, setResult] = useState<HealthResult | null>(null);
  const [loading, setLoading] = useState(false);

  const runHealthCheck = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: { action: "health-check", connectionId },
      });
      if (error) throw error;
      if (data?.success) setResult(data);
    } catch (e) {
      console.error("Health check failed:", e);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  if (!connectionId) return null;

  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3 text-left max-w-md mx-auto">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-primary" />
          Connection Health
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={runHealthCheck}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          <span className="ml-1">{loading ? "Checking…" : "Run Checks"}</span>
        </Button>
      </div>

      {!result && !loading && (
        <p className="text-[11px] text-muted-foreground text-center py-2">
          Click "Run Checks" to verify connection health.
        </p>
      )}

      {result && (
        <>
          {/* Overall status */}
          <div className="flex justify-center">
            <StatusBadge
              status={overallToDimension(result.overallStatus)}
              label={OVERALL_LABELS[result.overallStatus] || result.overallStatus}
            />
          </div>

          {/* Individual checks */}
          <div className="space-y-1.5">
            {Object.entries(result.checks).map(([key, check]) => (
              <div
                key={key}
                className={`flex items-center justify-between rounded-md border px-2.5 py-1.5 text-[11px] ${
                  check.status === "OK"
                    ? "border-success/30 bg-success/5"
                    : check.status === "WARN"
                    ? "border-amber-500/30 bg-amber-500/5"
                    : "border-destructive/30 bg-destructive/5"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <StatusBadge
                    status={checkToDimension(check.status)}
                    label={CHECK_LABELS[key] || key}
                  />
                  <span className="text-muted-foreground truncate">
                    {check.message}
                  </span>
                </div>
                {check.timestamp && (
                  <span className="text-[9px] text-muted-foreground flex items-center gap-0.5 shrink-0 ml-2">
                    <Clock className="h-2.5 w-2.5" />
                    {new Date(check.timestamp).toLocaleString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
