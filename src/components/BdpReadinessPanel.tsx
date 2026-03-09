import { useEffect, useState } from "react";
import { Shield, RefreshCw, Loader2, CheckCircle2, XCircle, AlertTriangle, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { StatusBadge, type DimensionStatus } from "@/components/ReadinessBadges";

interface BdpReadinessCheck {
  key: string;
  label: string;
  status: DimensionStatus;
  detail?: string;
}

export default function BdpReadinessPanel({ connectionId }: { connectionId: string | null }) {
  const [checks, setChecks] = useState<BdpReadinessCheck[]>([]);
  const [loading, setLoading] = useState(false);
  const [overallStatus, setOverallStatus] = useState<DimensionStatus>("NOT_CONNECTED");

  const fetchReadiness = async () => {
    if (!connectionId) return;
    setLoading(true);
    try {
      const newChecks: BdpReadinessCheck[] = [];

      // Fetch connection + provider_config
      const { data: conn } = await supabase
        .from("pos_connections")
        .select("provider_config, last_sync_at, last_catalog_sync_at, enabled")
        .eq("id", connectionId)
        .single();

      const config = (conn?.provider_config as Record<string, unknown>) || {};

      // 1. Auth check
      const lastTestSuccess = config.last_test_success as boolean | undefined;
      const lastTestAt = config.last_test_at as string | undefined;
      newChecks.push({
        key: "auth",
        label: "Authentication",
        status: lastTestSuccess === true ? "VERIFIED" : lastTestSuccess === false ? "ERROR" : "NOT_CONNECTED",
        detail: lastTestAt ? `Last tested: ${new Date(lastTestAt).toLocaleString()}` : "Not tested yet",
      });

      // 2. Endpoint discovery
      const discoveredEndpoints = config.discovered_endpoints as Record<string, unknown> | undefined;
      const endpointCount = discoveredEndpoints ? Object.keys(discoveredEndpoints).length : 0;
      newChecks.push({
        key: "discovery",
        label: "Endpoint Discovery",
        status: endpointCount > 0 ? "VERIFIED" : "NOT_CONNECTED",
        detail: endpointCount > 0 ? `${endpointCount} endpoint(s) discovered` : "Not yet discovered",
      });

      // 3. Sales read
      const lastSyncAt = conn?.last_sync_at;
      newChecks.push({
        key: "sales_read",
        label: "Sales Read",
        status: lastSyncAt ? "VERIFIED" : "NOT_CONNECTED",
        detail: lastSyncAt ? `Last sync: ${new Date(lastSyncAt).toLocaleString()}` : "No sales synced yet",
      });

      // 4. Catalog sync
      const lastCatalogSync = conn?.last_catalog_sync_at;
      const catalogDiag = config.last_catalog_diagnostics as Record<string, unknown> | undefined;
      const catalogHealth = catalogDiag?.catalog_health as string | undefined;
      newChecks.push({
        key: "catalog_sync",
        label: "Catalog Sync",
        status: lastCatalogSync
          ? (catalogHealth === "complete" ? "VERIFIED" : catalogHealth === "incomplete" ? "PARTIAL" : "CONNECTED")
          : "NOT_CONNECTED",
        detail: lastCatalogSync
          ? `Last sync: ${new Date(lastCatalogSync).toLocaleString()} (${catalogHealth || "unknown"})`
          : "No catalog synced",
      });

      // 5. Write verification
      const lastTestChecks = config.last_test_checks as Record<string, unknown> | undefined;
      const hasWriteCapability = !!discoveredEndpoints && Object.values(discoveredEndpoints as Record<string, any>).some(
        (ep: any) => ep.role === "write" && ep.last_success_at
      );
      newChecks.push({
        key: "write_verification",
        label: "Write Capability",
        status: hasWriteCapability ? "VERIFIED" : endpointCount > 0 ? "PARTIAL" : "NOT_CONNECTED",
        detail: hasWriteCapability ? "Write endpoint verified" : "Write endpoint not verified",
      });

      // 6. Last successful write verification
      const pilotVerifiedAt = config.pilot_verified_at as string | undefined;

      // Also check provider_capabilities
      const { data: caps } = await supabase
        .from("provider_capabilities")
        .select("last_verified_at, readiness_status, can_write_products")
        .eq("connection_id", connectionId)
        .single();

      const lastVerifiedAt = caps?.last_verified_at || pilotVerifiedAt;
      newChecks.push({
        key: "last_verification",
        label: "Post-Write Verification",
        status: lastVerifiedAt ? "VERIFIED" : "NOT_CONNECTED",
        detail: lastVerifiedAt ? `Last verified: ${new Date(lastVerifiedAt).toLocaleString()}` : "No write verified",
      });

      // 7. Pilot verified
      newChecks.push({
        key: "pilot_verified",
        label: "Pilot Verified",
        status: pilotVerifiedAt || caps?.readiness_status === "VERIFIED" ? "VERIFIED" : "NOT_CONNECTED",
        detail: pilotVerifiedAt
          ? `Pilot passed: ${new Date(pilotVerifiedAt).toLocaleString()}`
          : "Run the pilot to verify end-to-end",
      });

      setChecks(newChecks);

      // Overall
      const verifiedCount = newChecks.filter((c) => c.status === "VERIFIED").length;
      const errorCount = newChecks.filter((c) => c.status === "ERROR").length;
      if (errorCount > 0) setOverallStatus("ERROR");
      else if (verifiedCount === newChecks.length) setOverallStatus("VERIFIED");
      else if (verifiedCount >= 4) setOverallStatus("PARTIAL");
      else if (verifiedCount > 0) setOverallStatus("CONNECTED");
      else setOverallStatus("NOT_CONNECTED");
    } catch (e) {
      console.error("Failed to load BDP readiness:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReadiness();
  }, [connectionId]);

  if (!connectionId) return null;

  const statusLabels: Record<DimensionStatus, string> = {
    NOT_CONNECTED: "Not Ready",
    CONNECTED: "Partially Connected",
    PARTIAL: "Mostly Ready",
    VERIFIED: "Fully Verified",
    ERROR: "Error",
  };

  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3 text-left max-w-lg mx-auto">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-primary" />
          BDP Readiness
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={fetchReadiness}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {/* Overall status */}
      <div className="flex justify-center">
        <StatusBadge status={overallStatus} label={statusLabels[overallStatus]} />
      </div>

      {/* Individual checks */}
      <div className="space-y-1.5">
        {checks.map((check) => (
          <div
            key={check.key}
            className={`flex items-center gap-2.5 rounded-md border px-3 py-1.5 text-[11px] ${
              check.status === "VERIFIED"
                ? "border-success/30 bg-success/5"
                : check.status === "ERROR"
                ? "border-destructive/30 bg-destructive/5"
                : check.status === "PARTIAL" || check.status === "CONNECTED"
                ? "border-amber-500/30 bg-amber-500/5"
                : "border-border bg-card"
            }`}
          >
            {check.status === "VERIFIED" ? (
              <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
            ) : check.status === "ERROR" ? (
              <XCircle className="h-3 w-3 text-destructive shrink-0" />
            ) : check.status === "PARTIAL" || check.status === "CONNECTED" ? (
              <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
            ) : (
              <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <span className="font-medium text-foreground">{check.label}</span>
              {check.detail && (
                <p className="text-[10px] text-muted-foreground truncate">{check.detail}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
