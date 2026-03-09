import { CheckCircle2, XCircle, AlertTriangle, Shield, ShieldCheck, ShieldX, Package, DollarSign, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PostWriteVerificationResult, PostWriteIssue } from "@/types/postWriteVerification";

/**
 * Renders a PostWriteVerificationResult in a consistent format across all providers.
 * Drop into any outbound sync panel or task detail view.
 */
export default function PostWriteVerificationDisplay({
  result,
  compact = false,
  provider,
}: {
  result: PostWriteVerificationResult;
  compact?: boolean;
  provider?: string;
}) {
  if (compact) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <VerificationBadge ok={result.success} label={result.success ? "Verified" : "Failed"} />
        <VerificationBadge ok={result.verified_exists} label="Exists" />
        <VerificationBadge ok={result.verified_prices} label="Prices" />
        <VerificationBadge ok={result.verified_scope} label="Scope" />
        {result.warnings.length > 0 && (
          <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-600">
            {result.warnings.length} warning{result.warnings.length > 1 ? "s" : ""}
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-2.5 text-left">
      {/* Header */}
      <div className="flex items-center gap-2">
        {result.success ? (
          <ShieldCheck className="h-4 w-4 text-success" />
        ) : (
          <ShieldX className="h-4 w-4 text-destructive" />
        )}
        <span className="text-xs font-semibold text-foreground">
          Post-Write Verification {result.success ? "Passed" : "Failed"}
        </span>
        {provider && (
          <Badge variant="outline" className="text-[9px] ml-auto">{provider}</Badge>
        )}
      </div>

      {/* Dimension checks */}
      <div className="flex flex-wrap gap-1.5">
        <DimensionChip ok={result.verified_exists} icon={<Package className="h-3 w-3" />} label="Exists in POS" />
        <DimensionChip ok={result.verified_prices} icon={<DollarSign className="h-3 w-3" />} label="Prices valid" />
        <DimensionChip ok={result.verified_scope} icon={<Lock className="h-3 w-3" />} label="Scope valid" />
        {"verified_family" in result && <DimensionChip ok={(result as any).verified_family} icon={<Package className="h-3 w-3" />} label="Family" />}
        {"verified_preparation" in result && <DimensionChip ok={(result as any).verified_preparation} icon={<Shield className="h-3 w-3" />} label="Preparation" />}
      </div>

      {/* Errors */}
      {result.errors.length > 0 && (
        <div className="space-y-1">
          {result.errors.map((e, i) => (
            <IssueRow key={i} issue={e} type="error" />
          ))}
        </div>
      )}

      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div className="space-y-1">
          {result.warnings.map((w, i) => (
            <IssueRow key={i} issue={w} type="warning" />
          ))}
        </div>
      )}
    </div>
  );
}

function VerificationBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge
      variant={ok ? "default" : "destructive"}
      className="text-[10px] gap-1"
    >
      {ok ? <CheckCircle2 className="h-2.5 w-2.5" /> : <XCircle className="h-2.5 w-2.5" />}
      {label}
    </Badge>
  );
}

function DimensionChip({ ok, icon, label }: { ok: boolean; icon: React.ReactNode; label: string }) {
  return (
    <div className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium border ${
      ok
        ? "border-success/30 bg-success/10 text-success"
        : "border-destructive/30 bg-destructive/10 text-destructive"
    }`}>
      {icon}
      {label}
      {ok ? <CheckCircle2 className="h-2.5 w-2.5 ml-0.5" /> : <XCircle className="h-2.5 w-2.5 ml-0.5" />}
    </div>
  );
}

function IssueRow({ issue, type }: { issue: PostWriteIssue; type: "error" | "warning" }) {
  return (
    <div className={`flex items-start gap-1.5 text-[11px] ${
      type === "error" ? "text-destructive" : "text-amber-600"
    }`}>
      {type === "error" ? (
        <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
      )}
      <span>
        <span className="font-mono font-medium">[{issue.code}]</span>{" "}
        {issue.message}
        {issue.field && <span className="text-muted-foreground"> ({issue.field})</span>}
      </span>
    </div>
  );
}

/**
 * Adapter: Convert any provider-specific verification result into the shared contract.
 * Use this for providers that don't yet return the canonical shape.
 */
export function adaptVerificationResult(raw: any): PostWriteVerificationResult {
  // Already canonical?
  if (raw && typeof raw.verified_exists === "boolean" && typeof raw.verified_prices === "boolean" && typeof raw.verified_scope === "boolean") {
    return {
      success: !!raw.success,
      verified_exists: raw.verified_exists,
      verified_prices: raw.verified_prices,
      verified_scope: raw.verified_scope ?? true,
      errors: Array.isArray(raw.errors) ? raw.errors : [],
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    };
  }

  // BDP legacy shape: { success, exists, priceValid, price, name, message }
  if ("exists" in raw || "priceValid" in raw) {
    const errors: PostWriteIssue[] = [];
    const warnings: PostWriteIssue[] = [];

    if (raw.exists === false) {
      errors.push({ code: "NOT_FOUND", message: raw.message || "Product not found in BDP after write" });
    }
    if (raw.exists && !raw.priceValid) {
      errors.push({ code: "PRICE_ZERO", message: `Product exists but price is ${raw.price ?? 0}`, field: "price", context: { actual: raw.price } });
    }

    return {
      success: !!raw.success && raw.exists !== false && raw.priceValid !== false,
      verified_exists: raw.exists ?? false,
      verified_prices: raw.priceValid ?? false,
      verified_scope: true, // BDP doesn't have scope checks
      errors,
      warnings,
    };
  }

  // Fallback: treat as opaque success/failure
  return {
    success: !!raw.success,
    verified_exists: !!raw.success,
    verified_prices: !!raw.success,
    verified_scope: true,
    errors: raw.success ? [] : [{ code: "UNKNOWN", message: raw.message || "Verification failed" }],
    warnings: [],
  };
}
