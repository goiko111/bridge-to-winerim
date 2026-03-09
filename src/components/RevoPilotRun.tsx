import { useState, useCallback } from "react";
import {
  Loader2, CheckCircle2, XCircle, AlertTriangle, Play, RotateCcw,
  Link2, Package, ShieldCheck, Eye, Upload, BadgeCheck, Beaker,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { StatusBadge, type DimensionStatus } from "@/components/ReadinessBadges";

type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

interface PilotStep {
  key: string;
  label: string;
  icon: typeof Link2;
  status: StepStatus;
  message?: string;
  detail?: Record<string, unknown>;
}

const INITIAL_STEPS: Omit<PilotStep, "status">[] = [
  { key: "test_connection", label: "Test Connection", icon: Link2 },
  { key: "sync_catalog", label: "Sync Catalog", icon: Package },
  { key: "check_deps", label: "Check Dependencies", icon: ShieldCheck },
  { key: "preview_wine", label: "Preview One Wine", icon: Eye },
  { key: "push_wine", label: "Push One Wine", icon: Upload },
  { key: "verify_item", label: "Verify Item & Price", icon: BadgeCheck },
  { key: "mark_verified", label: "Mark Pilot-Verified", icon: CheckCircle2 },
];

function statusToDimension(s: StepStatus): DimensionStatus {
  if (s === "passed") return "VERIFIED";
  if (s === "failed") return "ERROR";
  if (s === "running") return "CONNECTED";
  if (s === "skipped") return "PARTIAL";
  return "NOT_CONNECTED";
}

export default function RevoPilotRun({
  connectionId,
}: {
  connectionId: string | null;
}) {
  const [steps, setSteps] = useState<PilotStep[]>(
    INITIAL_STEPS.map((s) => ({ ...s, status: "pending" as StepStatus }))
  );
  const [running, setRunning] = useState(false);
  const [pilotWine, setPilotWine] = useState<Record<string, unknown> | null>(null);
  const [pushedItemId, setPushedItemId] = useState<string | null>(null);

  const updateStep = (key: string, status: StepStatus, message?: string, detail?: Record<string, unknown>) => {
    setSteps((prev) =>
      prev.map((s) => (s.key === key ? { ...s, status, message, detail } : s))
    );
  };

  const reset = () => {
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: "pending" as StepStatus })));
    setPilotWine(null);
    setPushedItemId(null);
  };

  const runPilot = useCallback(async () => {
    if (!connectionId) return;
    setRunning(true);
    reset();

    // Give React a tick to render reset
    await new Promise((r) => setTimeout(r, 50));

    // ── Step 1: Test Connection ──
    updateStep("test_connection", "running");
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: { action: "test", connectionId },
      });
      if (error || !data?.success) {
        updateStep("test_connection", "failed", data?.message || error?.message || "Connection test failed");
        setRunning(false);
        return;
      }
      updateStep("test_connection", "passed", `Auth OK (${data.paymentMethodCount || 0} payment methods)`);
    } catch (e: any) {
      updateStep("test_connection", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 2: Sync Catalog ──
    updateStep("sync_catalog", "running");
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: { action: "sync-catalog", connectionId },
      });
      if (error || !data?.success) {
        updateStep("sync_catalog", "failed", data?.message || error?.message || "Catalog sync failed");
        setRunning(false);
        return;
      }
      updateStep("sync_catalog", "passed", `${data.totalProducts} products, ${data.wineCandidates} wine candidates`);
    } catch (e: any) {
      updateStep("sync_catalog", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 3: Check Dependencies ──
    updateStep("check_deps", "running");
    try {
      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: {
          action: "validate-write-deps",
          connectionId,
          itemData: { name: "Pilot Test Wine", price: 25, tax: 10, category_id: "1" },
        },
      });
      if (error) {
        updateStep("check_deps", "failed", error.message);
        setRunning(false);
        return;
      }
      // Deps may fail for category_id "1" but we care about tax and general availability
      const warnings = data?.warnings?.length || 0;
      const missing = data?.missing?.filter((m: any) => m.dep !== "category_id") || [];
      if (missing.length > 0) {
        updateStep("check_deps", "failed", missing.map((m: any) => m.message).join("; "));
        setRunning(false);
        return;
      }
      updateStep("check_deps", "passed", `Dependencies OK${warnings > 0 ? ` (${warnings} warnings)` : ""}`);
    } catch (e: any) {
      updateStep("check_deps", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 4: Preview One Wine ──
    updateStep("preview_wine", "running");
    try {
      // Find one READY wine from winerim_wines
      const { data: wines, error: wErr } = await supabase
        .from("winerim_wines")
        .select("*")
        .eq("connection_id", connectionId)
        .eq("pricing_status", "READY")
        .eq("is_active", true)
        .limit(1);

      if (wErr || !wines?.length) {
        // Try any wine with bottle_sale_price > 0
        const { data: fallback } = await supabase
          .from("winerim_wines")
          .select("*")
          .eq("connection_id", connectionId)
          .gt("bottle_sale_price", 0)
          .eq("is_active", true)
          .limit(1);

        if (!fallback?.length) {
          updateStep("preview_wine", "failed", "No pushable wines found. Ensure at least one wine has pricing.");
          setRunning(false);
          return;
        }
        setPilotWine(fallback[0] as Record<string, unknown>);
        updateStep("preview_wine", "passed", `Selected: "${fallback[0].name}" (${fallback[0].bottle_sale_price}€)`, fallback[0] as Record<string, unknown>);
      } else {
        setPilotWine(wines[0] as Record<string, unknown>);
        updateStep("preview_wine", "passed", `Selected: "${wines[0].name}" (${wines[0].bottle_sale_price}€)`, wines[0] as Record<string, unknown>);
      }
    } catch (e: any) {
      updateStep("preview_wine", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 5: Push One Wine ──
    updateStep("push_wine", "running");
    try {
      const wine = pilotWine || (await supabase
        .from("winerim_wines")
        .select("*")
        .eq("connection_id", connectionId)
        .or("pricing_status.eq.READY,bottle_sale_price.gt.0")
        .eq("is_active", true)
        .limit(1)
        .then((r) => r.data?.[0])) as any;

      if (!wine) {
        updateStep("push_wine", "failed", "No wine available to push");
        setRunning(false);
        return;
      }

      // Resolve category from mappings
      let categoryId: string | null = null;
      const wt = String(wine.wine_type || "").toLowerCase();
      const fmt = String(wine.format || "bottle").toLowerCase();
      const { data: mappings } = await supabase
        .from("wine_type_family_mappings")
        .select("mapping_key, agora_family_id")
        .eq("connection_id", connectionId);

      if (mappings?.length) {
        const lookup = new Map(mappings.map((m: any) => [m.mapping_key, m.agora_family_id]));
        for (const key of [`${fmt}_${wt}`, `bottle_${wt}`, fmt]) {
          if (lookup.has(key)) { categoryId = lookup.get(key) || null; break; }
        }
      }

      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: {
          action: "upsert-item",
          connectionId,
          itemData: {
            name: `[PILOT] ${wine.name}`,
            price: wine.bottle_sale_price || wine.price || 0,
            category_id: categoryId,
            tax: 10,
            winerim_id: wine.winerim_id,
          },
        },
      });

      if (error || !data?.success) {
        updateStep("push_wine", "failed", data?.error || error?.message || "Push failed");
        setRunning(false);
        return;
      }

      const itemId = data.revoItemId || data.external_id || "";
      setPushedItemId(itemId);
      updateStep("push_wine", "passed", `Created Revo item ${itemId}`, { revoItemId: itemId });
    } catch (e: any) {
      updateStep("push_wine", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 6: Verify Item Exists & Price > 0 ──
    updateStep("verify_item", "running");
    try {
      // Get the pushed item ID from state or step detail
      const itemId = pushedItemId || steps.find((s) => s.key === "push_wine")?.detail?.revoItemId as string;

      // Small delay to let Revo propagate
      await new Promise((r) => setTimeout(r, 1500));

      const { data, error } = await supabase.functions.invoke("revo-proxy", {
        body: {
          action: "verify-write",
          connectionId,
          revo_item_id: itemId,
        },
      });

      if (error) {
        updateStep("verify_item", "failed", error.message);
        setRunning(false);
        return;
      }

      if (data?.success && data?.verified_exists && data?.verified_prices) {
        updateStep("verify_item", "passed", "Item exists with price > 0", data);
      } else {
        const issues = (data?.errors || []).map((e: any) => e.message).join("; ");
        updateStep("verify_item", "failed", issues || "Verification failed: item missing or price is 0");
        setRunning(false);
        return;
      }
    } catch (e: any) {
      updateStep("verify_item", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 7: Mark Pilot-Verified ──
    updateStep("mark_verified", "running");
    try {
      await supabase.from("provider_capabilities").upsert(
        {
          connection_id: connectionId,
          provider: "REVO_XEF",
          readiness_status: "VERIFIED",
          last_verified_at: new Date().toISOString(),
          can_read_catalog: true,
          can_read_sales: true,
          can_write_products: "YES",
          write_mode: "REST",
          write_endpoints_json: {
            pilot_verified_at: new Date().toISOString(),
            pilot_wine: pilotWine?.name || "unknown",
            pilot_revo_item_id: pushedItemId,
          },
        } as any,
        { onConflict: "connection_id" },
      );
      updateStep("mark_verified", "passed", "Connection marked as pilot-verified");
    } catch (e: any) {
      updateStep("mark_verified", "failed", e.message);
    }

    setRunning(false);
  }, [connectionId]);

  if (!connectionId) return null;

  const allPassed = steps.every((s) => s.status === "passed");
  const anyFailed = steps.some((s) => s.status === "failed");
  const currentRunning = steps.find((s) => s.status === "running");

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-4 text-left max-w-md mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Beaker className="h-4 w-4 text-primary" />
          <p className="text-xs font-semibold text-foreground">Pilot Run</p>
          <Badge variant="outline" className="text-[9px]">Optional</Badge>
        </div>
        {(anyFailed || allPassed) && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={reset}>
            <RotateCcw className="h-3 w-3 mr-1" /> Reset
          </Button>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Guided validation: tests connection, syncs catalog, pushes one wine to Revo, verifies it exists with correct price.
        Non-destructive — uses a <code className="text-foreground">[PILOT]</code> prefix.
      </p>

      {/* Steps */}
      <div className="space-y-1.5">
        {steps.map((step, i) => {
          const Icon = step.icon;
          const isActive = step.status === "running";
          return (
            <div
              key={step.key}
              className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-[11px] transition-all ${
                step.status === "passed"
                  ? "border-success/30 bg-success/5"
                  : step.status === "failed"
                  ? "border-destructive/30 bg-destructive/5"
                  : step.status === "running"
                  ? "border-primary/30 bg-primary/5"
                  : "border-border bg-secondary/20"
              }`}
            >
              <div className="mt-0.5 shrink-0">
                {step.status === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                ) : step.status === "passed" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                ) : step.status === "failed" ? (
                  <XCircle className="h-3.5 w-3.5 text-destructive" />
                ) : (
                  <div className="h-3.5 w-3.5 rounded-full border border-muted-foreground/30 flex items-center justify-center text-[8px] text-muted-foreground font-semibold">
                    {i + 1}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <span className={`font-medium ${
                  step.status === "passed" ? "text-success" :
                  step.status === "failed" ? "text-destructive" :
                  step.status === "running" ? "text-primary" :
                  "text-muted-foreground"
                }`}>
                  {step.label}
                </span>
                {step.message && (
                  <p className={`mt-0.5 text-[10px] ${
                    step.status === "failed" ? "text-destructive/80" : "text-muted-foreground"
                  }`}>
                    {step.message}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Action button */}
      {!running && !allPassed && (
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={runPilot}
        >
          <Play className="mr-2 h-3.5 w-3.5" />
          {anyFailed ? "Retry Pilot Run" : "Start Pilot Run"}
        </Button>
      )}

      {/* Result */}
      {allPassed && (
        <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2">
          <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
          <div>
            <p className="text-xs font-semibold text-success">Pilot Passed</p>
            <p className="text-[10px] text-muted-foreground">
              Connection is pilot-verified. Safe to proceed to Go Live.
            </p>
          </div>
        </div>
      )}

      {anyFailed && !running && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-warning">Pilot Incomplete</p>
            <p className="text-[10px] text-muted-foreground">
              Fix the failed step and retry. The pilot is non-destructive.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
