import { useEffect } from "react";
import { Shield, RefreshCw, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useProviderReadiness, type ProviderReadiness, type ReadinessStatus } from "@/hooks/useProviderReadiness";
import {
  StatusBadge,
  type DimensionStatus,
} from "@/components/ReadinessBadges";

const STATUS_LABELS: Record<ReadinessStatus, string> = {
  NOT_CONNECTED: "Not Connected",
  CONNECTED: "Connected",
  PARTIAL: "Partial",
  VERIFIED: "Fully Verified",
  ERROR: "Error",
};

function boolStatus(val: boolean): DimensionStatus {
  return val ? "VERIFIED" : "NOT_CONNECTED";
}

function writeStatus(val: string): DimensionStatus {
  if (val === "YES") return "VERIFIED";
  if (val === "UNKNOWN") return "CONNECTED";
  return "NOT_CONNECTED";
}

/**
 * Self-contained panel that fetches provider_capabilities for a connection
 * and renders the canonical readiness badges.
 *
 * Drop into any wizard's Go Live / summary step.
 */
export default function ProviderReadinessPanel({
  connectionId,
  provider,
}: {
  connectionId: string | null;
  provider?: string;
}) {
  const { readiness, loading, fetchReadiness } = useProviderReadiness();

  useEffect(() => {
    if (connectionId) fetchReadiness(connectionId);
  }, [connectionId, fetchReadiness]);

  if (!connectionId) return null;

  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3 text-left max-w-md mx-auto">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-primary" />
          Integration Readiness
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={() => fetchReadiness(connectionId)}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {/* Overall status */}
      <div className="flex justify-center">
        <StatusBadge status={readiness.readiness_status as DimensionStatus} label={STATUS_LABELS[readiness.readiness_status] || readiness.readiness_status} />
      </div>

      {/* Dimension badges */}
      <div className="flex flex-wrap gap-1.5 justify-center">
        <StatusBadge status={boolStatus(readiness.can_read_sales)} label={readiness.can_read_sales ? "Sales: Yes" : "Sales: No"} />
        <StatusBadge status={boolStatus(readiness.can_read_catalog)} label={readiness.can_read_catalog ? "Catalog: Yes" : "Catalog: No"} />
        <StatusBadge status={writeStatus(readiness.can_write_products)} label={`Write: ${readiness.can_write_products}`} />
        {readiness.write_mode !== "NONE" && (
          <StatusBadge status="CONNECTED" label={`Mode: ${readiness.write_mode}`} />
        )}
        {readiness.webhook_supported && (
          <StatusBadge status="VERIFIED" label="Webhooks" />
        )}
      </div>

      {/* Last verified */}
      {readiness.last_verified_at && (
        <p className="text-[10px] text-muted-foreground text-center">
          Last verified: {new Date(readiness.last_verified_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}
