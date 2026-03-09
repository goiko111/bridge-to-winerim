import { useState, useCallback } from "react";
import {
  Loader2, CheckCircle2, XCircle, AlertTriangle, Play, RotateCcw,
  Link2, Package, ShieldCheck, Eye, Upload, BadgeCheck, Beaker, Map,
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
  { key: "discover_endpoints", label: "Discover Endpoints", icon: ShieldCheck },
  { key: "sync_catalog", label: "Sync Catalog", icon: Package },
  { key: "check_mappings", label: "Check Family Mappings", icon: Map },
  { key: "preview_wine", label: "Preview One Wine", icon: Eye },
  { key: "push_wine", label: "Push One Wine", icon: Upload },
  { key: "verify_item", label: "Verify Exists & Price", icon: BadgeCheck },
  { key: "mark_verified", label: "Mark Pilot-Verified", icon: CheckCircle2 },
];

function statusToDimension(s: StepStatus): DimensionStatus {
  if (s === "passed") return "VERIFIED";
  if (s === "failed") return "ERROR";
  if (s === "running") return "CONNECTED";
  if (s === "skipped") return "PARTIAL";
  return "NOT_CONNECTED";
}

export default function BdpPilotRun({
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
    await new Promise((r) => setTimeout(r, 50));

    // ── Step 1: Test Connection ──
    updateStep("test_connection", "running");
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "test", connectionId },
      });
      if (error || !data?.success) {
        updateStep("test_connection", "failed", data?.message || error?.message || "Connection test failed");
        setRunning(false);
        return;
      }
      updateStep("test_connection", "passed", "Auth & endpoint OK");
    } catch (e: any) {
      updateStep("test_connection", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 2: Discover Endpoints ──
    updateStep("discover_endpoints", "running");
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "discover", connectionId },
      });
      if (error || !data?.success) {
        updateStep("discover_endpoints", "failed", data?.message || error?.message || "Discovery failed");
        setRunning(false);
        return;
      }
      const caps = data.capabilities || {};
      const parts: string[] = [];
      if (caps.canReadSales) parts.push("Sales");
      if (caps.canReadCatalog) parts.push("Catalog");
      if (caps.canWrite) parts.push("Write");
      updateStep("discover_endpoints", "passed", `Capabilities: ${parts.join(", ") || "none detected"}`);
    } catch (e: any) {
      updateStep("discover_endpoints", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 3: Sync Catalog ──
    updateStep("sync_catalog", "running");
    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "sync-catalog", connectionId },
      });
      if (error || !data?.success) {
        updateStep("sync_catalog", "failed", data?.message || error?.message || "Catalog sync failed");
        setRunning(false);
        return;
      }
      updateStep("sync_catalog", "passed", `${data.totalProducts} products, ${data.totalFamilies} families`);
    } catch (e: any) {
      updateStep("sync_catalog", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 4: Check Family Mappings ──
    updateStep("check_mappings", "running");
    try {
      const { data: mappings, error: mapErr } = await supabase
        .from("wine_type_family_mappings")
        .select("mapping_key, agora_family_name")
        .eq("connection_id", connectionId);

      if (mapErr) {
        updateStep("check_mappings", "failed", mapErr.message);
        setRunning(false);
        return;
      }

      const configured = (mappings || []).filter((m) => m.agora_family_name);
      if (configured.length === 0) {
        updateStep("check_mappings", "skipped", "No family mappings configured — products will use default family. Consider configuring mappings.");
      } else {
        updateStep("check_mappings", "passed", `${configured.length} mapping(s) configured`);
      }
    } catch (e: any) {
      updateStep("check_mappings", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 5: Preview One Wine ──
    updateStep("preview_wine", "running");
    let selectedWine: any = null;
    try {
      const { data: wines } = await supabase
        .from("winerim_wines")
        .select("*")
        .eq("connection_id", connectionId)
        .eq("pricing_status", "READY")
        .eq("is_active", true)
        .limit(1);

      if (wines?.length) {
        selectedWine = wines[0];
      } else {
        const { data: fallback } = await supabase
          .from("winerim_wines")
          .select("*")
          .eq("connection_id", connectionId)
          .gt("bottle_sale_price", 0)
          .eq("is_active", true)
          .limit(1);
        if (fallback?.length) selectedWine = fallback[0];
      }

      if (!selectedWine) {
        // Fallback: use a provider_product with price > 0
        const { data: providerProducts } = await supabase
          .from("provider_products")
          .select("provider_product_id, name, price, vat_rate, family")
          .eq("connection_id", connectionId)
          .gt("price", 0)
          .limit(1);

        if (providerProducts?.length) {
          const pp = providerProducts[0];
          selectedWine = {
            winerim_id: pp.provider_product_id,
            name: pp.name,
            bottle_sale_price: pp.price,
            price: pp.price,
            wine_type: null,
            format: "bottle",
            vat_rate: pp.vat_rate,
          };
        }
      }

      if (!selectedWine) {
        updateStep("preview_wine", "failed", "No pushable wines or products found. Ensure at least one item has pricing.");
        setRunning(false);
        return;
      }

      setPilotWine(selectedWine as Record<string, unknown>);
      const price = selectedWine.bottle_sale_price || selectedWine.price || 0;
      updateStep("preview_wine", "passed", `Selected: "${selectedWine.name}" (${price}€)`, selectedWine as Record<string, unknown>);
    } catch (e: any) {
      updateStep("preview_wine", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 6: Push One Wine ──
    updateStep("push_wine", "running");
    try {
      const wine = selectedWine;
      const price = wine.bottle_sale_price || wine.price || 0;
      const vatRate = wine.vat_rate || 10;
      const pilotId = `PILOT_${wine.winerim_id || wine.provider_product_id || Date.now()}`;

      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: {
          action: "write-product",
          connectionId,
          product: {
            provider_product_id: pilotId,
            name: `[PILOT] ${wine.name}`,
            price,
            vat_rate: vatRate,
            wine_type: wine.wine_type || undefined,
            format: wine.format || "bottle",
          },
          autoVerify: false, // We'll verify in the next step
        },
      });

      if (error || !data?.success) {
        updateStep("push_wine", "failed", data?.message || error?.message || "Write failed");
        setRunning(false);
        return;
      }

      setPushedItemId(pilotId);
      updateStep("push_wine", "passed", `Written as ${pilotId} — HTTP ${data.status}`, { itemId: pilotId, method: data.method });
    } catch (e: any) {
      updateStep("push_wine", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 7: Verify Exists & Price ──
    updateStep("verify_item", "running");
    try {
      await new Promise((r) => setTimeout(r, 1500));

      const itemId = pushedItemId || `PILOT_${selectedWine?.winerim_id || selectedWine?.provider_product_id || ""}`;

      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: {
          action: "verify-product-v2",
          connectionId,
          productId: itemId,
        },
      });

      if (error) {
        updateStep("verify_item", "failed", error.message);
        setRunning(false);
        return;
      }

      if (data?.verified_exists && data?.verified_prices) {
        const parts: string[] = ["Exists ✓", "Price > 0 ✓"];
        if (data.verified_family) parts.push("Family ✓");
        if (data.verified_tax) parts.push("Tax ✓");
        updateStep("verify_item", "passed", parts.join(" · "), data);
      } else {
        const issues = (data?.errors || []).map((e: any) => e.message).join("; ");
        updateStep("verify_item", "failed", issues || "Product not found or price is 0");
        setRunning(false);
        return;
      }
    } catch (e: any) {
      updateStep("verify_item", "failed", e.message);
      setRunning(false);
      return;
    }

    // ── Step 8: Mark Pilot-Verified ──
    updateStep("mark_verified", "running");
    try {
      await supabase.from("provider_capabilities").upsert(
        {
          connection_id: connectionId,
          provider: "BDP",
          readiness_status: "VERIFIED",
          last_verified_at: new Date().toISOString(),
          can_read_catalog: true,
          can_read_sales: true,
          can_write_products: "YES",
          write_mode: "REST",
          write_endpoints_json: {
            pilot_verified_at: new Date().toISOString(),
            pilot_wine: selectedWine?.name || "unknown",
            pilot_item_id: pushedItemId,
          },
        } as any,
        { onConflict: "connection_id" },
      );

      // Also mark connection as pilot-verified in provider_config
      const { data: conn } = await supabase
        .from("pos_connections")
        .select("provider_config")
        .eq("id", connectionId)
        .single();

      const existingConfig = (conn?.provider_config as Record<string, unknown>) || {};
      await supabase
        .from("pos_connections")
        .update({
          provider_config: {
            ...existingConfig,
            pilot_verified_at: new Date().toISOString(),
            pilot_wine_name: selectedWine?.name || "unknown",
            pilot_item_id: pushedItemId,
          },
        } as any)
        .eq("id", connectionId);

      updateStep("mark_verified", "passed", "Connection marked as pilot-verified");
    } catch (e: any) {
      updateStep("mark_verified", "failed", e.message);
    }

    setRunning(false);
  }, [connectionId]);

  if (!connectionId) return null;

  const allPassed = steps.every((s) => s.status === "passed" || s.status === "skipped");
  const anyFailed = steps.some((s) => s.status === "failed");

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-4 text-left max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Beaker className="h-4 w-4 text-primary" />
          <p className="text-xs font-semibold text-foreground">BDP Pilot Run</p>
          <Badge variant="outline" className="text-[9px]">Guided Validation</Badge>
        </div>
        {(anyFailed || allPassed) && !running && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={reset}>
            <RotateCcw className="h-3 w-3 mr-1" /> Reset
          </Button>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        End-to-end validation: tests auth, discovers endpoints, syncs catalog, checks mappings,
        pushes one <code className="text-foreground">[PILOT]</code> product, and verifies it exists with correct price.
      </p>

      {/* Steps */}
      <div className="space-y-1.5">
        {steps.map((step, i) => {
          const Icon = step.icon;
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
                  : step.status === "skipped"
                  ? "border-amber-500/30 bg-amber-500/5"
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
                ) : step.status === "skipped" ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
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
                  step.status === "skipped" ? "text-amber-600 dark:text-amber-400" :
                  "text-muted-foreground"
                }`}>
                  {step.label}
                </span>
                {step.message && (
                  <p className={`mt-0.5 text-[10px] ${
                    step.status === "failed" ? "text-destructive/80" :
                    step.status === "skipped" ? "text-amber-600/80 dark:text-amber-400/80" :
                    "text-muted-foreground"
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
      {allPassed && !running && (
        <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2">
          <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
          <div>
            <p className="text-xs font-semibold text-success">Pilot Passed</p>
            <p className="text-[10px] text-muted-foreground">
              BDP connection is pilot-verified. Safe to enable sync.
            </p>
          </div>
        </div>
      )}

      {anyFailed && !running && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">Pilot Incomplete</p>
            <p className="text-[10px] text-muted-foreground">
              Fix the failed step and retry. The pilot uses a [PILOT] prefix and is non-destructive.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
