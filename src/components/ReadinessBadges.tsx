import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, HelpCircle, AlertTriangle, Zap, Shield } from "lucide-react";
import type { ReadinessStatus } from "@/hooks/useProviderReadiness";

// ── Shared readiness status type ──
export type DimensionStatus = "NOT_CONNECTED" | "CONNECTED" | "PARTIAL" | "VERIFIED" | "ERROR";

const STATUS_CONFIG: Record<DimensionStatus, {
  variant: "default" | "secondary" | "outline" | "destructive";
  icon: typeof CheckCircle2;
  className: string;
}> = {
  NOT_CONNECTED: { variant: "secondary", icon: XCircle, className: "" },
  CONNECTED: { variant: "outline", icon: HelpCircle, className: "border-amber-500/50 text-amber-600" },
  PARTIAL: { variant: "outline", icon: AlertTriangle, className: "border-amber-500/50 text-amber-600" },
  VERIFIED: { variant: "default", icon: CheckCircle2, className: "bg-emerald-600" },
  ERROR: { variant: "destructive", icon: XCircle, className: "" },
};

// ── Generic status badge ──
export function StatusBadge({ status, label }: { status: DimensionStatus; label: string }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  return (
    <Badge variant={cfg.variant} className={`text-[10px] ${cfg.className}`}>
      <Icon className="mr-1 h-3 w-3" /> {label}
    </Badge>
  );
}

// ── Dimension-specific badges ──

export function RestWriteBadge() {
  return <StatusBadge status="NOT_CONNECTED" label="REST Write: Not Supported" />;
}

export function XmlImportBadge({ writeMode, canWrite }: { writeMode: string; canWrite: "YES" | "NO" | "UNKNOWN" }) {
  const status: DimensionStatus =
    writeMode !== "XML_IMPORT" ? "NOT_CONNECTED"
    : canWrite === "YES" ? "VERIFIED"
    : "CONNECTED"; // CONNECTED = supported but not yet verified

  const label =
    status === "VERIFIED" ? "XML Import: Validated"
    : status === "CONNECTED" ? "XML Import: Not Verified"
    : "XML Import: Not Configured";

  return <StatusBadge status={status} label={label} />;
}

export function MasterDataBadge({ fetchedAt }: { fetchedAt: string | null }) {
  const status: DimensionStatus = fetchedAt ? "VERIFIED" : "NOT_CONNECTED";
  const label = fetchedAt ? "Master Data: Synced" : "Master Data: Not Synced";
  return <StatusBadge status={status} label={label} />;
}

export function AutoPushBadge({ verifiedReady, canWrite }: { verifiedReady: boolean; canWrite: "YES" | "NO" | "UNKNOWN" }) {
  const status: DimensionStatus =
    verifiedReady && canWrite === "YES" ? "VERIFIED"
    : canWrite === "YES" ? "PARTIAL" // XML validated but auto-push not yet enabled
    : "NOT_CONNECTED";

  const label =
    status === "VERIFIED" ? "Auto-push: Verified"
    : status === "PARTIAL" ? "Auto-push: Not Verified"
    : "Auto-push: Not Available";

  return <StatusBadge status={status} label={label} />;
}

// ── Composite readiness summary ──
export interface ReadinessDimensions {
  writeMode: string;
  canWrite: "YES" | "NO" | "UNKNOWN";
  masterDataFetchedAt: string | null;
  autoPushVerifiedReady: boolean;
}

export function computeOverallReadiness(d: ReadinessDimensions): ReadinessStatus {
  // ERROR: contradictory state — auto-push verified but XML not validated
  if (d.autoPushVerifiedReady && d.canWrite !== "YES") return "ERROR";
  // VERIFIED: all dimensions green
  if (d.canWrite === "YES" && d.masterDataFetchedAt && d.autoPushVerifiedReady && d.writeMode === "XML_IMPORT") return "VERIFIED";
  // PARTIAL: some dimensions green
  if (d.canWrite === "YES" || d.masterDataFetchedAt) return "PARTIAL";
  // CONNECTED: write mode configured but nothing validated yet
  if (d.writeMode === "XML_IMPORT") return "CONNECTED";
  return "NOT_CONNECTED";
}

export function OverallReadinessBadge({ dimensions }: { dimensions: ReadinessDimensions }) {
  const status = computeOverallReadiness(dimensions);
  const labels: Record<ReadinessStatus, string> = {
    NOT_CONNECTED: "Not Connected",
    CONNECTED: "Connected",
    PARTIAL: "Partial",
    VERIFIED: "Fully Verified",
    ERROR: "Configuration Error",
  };
  return <StatusBadge status={status} label={labels[status]} />;
}

// ── All dimensions in a row ──
export function ReadinessBadgeRow({ dimensions }: { dimensions: ReadinessDimensions }) {
  return (
    <div className="flex gap-2 flex-wrap">
      <RestWriteBadge />
      <XmlImportBadge writeMode={dimensions.writeMode} canWrite={dimensions.canWrite} />
      <MasterDataBadge fetchedAt={dimensions.masterDataFetchedAt} />
      <AutoPushBadge verifiedReady={dimensions.autoPushVerifiedReady} canWrite={dimensions.canWrite} />
    </div>
  );
}
