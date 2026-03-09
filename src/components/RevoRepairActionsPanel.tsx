import { useState, useCallback, useEffect } from "react";
import { Wrench, Loader2, DollarSign, Tag, ShieldCheck, CheckCircle2, AlertTriangle, XCircle, ChevronDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface RepairSummary {
  queued: number;
  skipped: number;
  totalTargets: number;
  // reverify-specific
  verified?: number;
  passed?: number;
  failed?: number;
  results?: any[];
}

interface RevoCategory {
  id: string;
  name: string;
  group_name?: string;
}

const REPAIR_ACTIONS = [
  {
    id: "fix-prices",
    action: "repair-fix-prices",
    label: "Fix Prices",
    description: "Re-pushes latest Winerim sale prices to all existing Revo items. Uses UPDATE only.",
    icon: DollarSign,
  },
  {
    id: "reassign-category",
    action: "repair-reassign-category",
    label: "Reassign Category",
    description: "Updates all pushed items to use the currently saved wine-type → Revo category mappings.",
    icon: Tag,
  },
  {
    id: "fix-tax",
    action: "repair-fix-tax",
    label: "Fix Tax / VAT",
    description: "Sets the correct VAT rate on all pushed items using the connection's default or a chosen rate.",
    icon: DollarSign,
  },
  {
    id: "reverify",
    action: "repair-reverify",
    label: "Re-run Verification",
    description: "Checks all pushed items in Revo: price > 0, category assigned, tax present. No writes.",
    icon: ShieldCheck,
  },
];

export default function RevoRepairActionsPanel({ connectionId }: { connectionId: string | null }) {
  const [running, setRunning] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, RepairSummary>>({});
  const [categories, setCategories] = useState<RevoCategory[]>([]);
  const [categoryOverride, setCategoryOverride] = useState("");

  // Load categories for reassign
  useEffect(() => {
    if (!connectionId) return;
    supabase.functions.invoke("revo-proxy", {
      body: { action: "fetch-diagnostics-deps", connectionId, resource: "categories" },
    }).then(({ data }) => {
      setCategories((data?.items || []).map((c: any) => ({ id: String(c.id), name: String(c.name) })));
    });
  }, [connectionId]);

  const handleAction = useCallback(async (actionDef: typeof REPAIR_ACTIONS[0]) => {
    if (!connectionId || running) return;
    setRunning(actionDef.id);

    try {
      const body: Record<string, unknown> = { action: actionDef.action, connectionId };
      if (actionDef.id === "reassign-category" && categoryOverride) {
        body.categoryOverride = categoryOverride;
      }

      const { data, error } = await supabase.functions.invoke("revo-proxy", { body });
      if (error) throw error;

      const summary: RepairSummary = {
        queued: data?.queued ?? 0,
        skipped: data?.skipped ?? 0,
        totalTargets: data?.totalTargets ?? 0,
        verified: data?.verified,
        passed: data?.passed,
        failed: data?.failed,
        results: data?.results,
      };
      setSummaries((prev) => ({ ...prev, [actionDef.id]: summary }));

      // Auto-process queue for non-reverify actions
      if (actionDef.id !== "reverify" && summary.queued > 0) {
        toast({
          title: actionDef.label,
          description: `${summary.queued} queued, ${summary.skipped} skipped. Processing…`,
        });
        setProcessing(true);
        try {
          const { data: procData } = await supabase.functions.invoke("revo-proxy", {
            body: { action: "process-outbound-queue", connectionId },
          });
          const processed = procData?.processed || 0;
          const blocked = procData?.blocked || 0;

          // Auto re-verify after repair
          const { data: verifyData } = await supabase.functions.invoke("revo-proxy", {
            body: { action: "repair-reverify", connectionId },
          });
          setSummaries((prev) => ({
            ...prev,
            [actionDef.id]: { ...prev[actionDef.id], ...{ processed, blocked } },
            reverify: {
              queued: 0, skipped: 0,
              totalTargets: verifyData?.totalTargets ?? 0,
              verified: verifyData?.verified,
              passed: verifyData?.passed,
              failed: verifyData?.failed,
              results: verifyData?.results,
            },
          }));

          toast({
            title: `${actionDef.label} — Complete`,
            description: `${processed} processed, ${verifyData?.passed || 0} passed verification, ${verifyData?.failed || 0} failed.`,
          });
        } finally {
          setProcessing(false);
        }
      } else if (actionDef.id === "reverify") {
        toast({
          title: "Verification Complete",
          description: `${summary.passed} passed, ${summary.failed} failed out of ${summary.verified} items.`,
        });
      } else {
        toast({
          title: actionDef.label,
          description: summary.skipped > 0
            ? `All ${summary.totalTargets} items already have pending tasks.`
            : "No items to repair.",
        });
      }
    } catch (e: any) {
      toast({ title: "Repair failed", description: e.message, variant: "destructive" });
    } finally {
      setRunning(null);
    }
  }, [connectionId, running, categoryOverride]);

  if (!connectionId) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Wrench className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Repair Actions</h3>
        <Badge variant="outline" className="text-[9px] ml-auto">UPDATE only • Idempotent</Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        Fix existing pushed products in Revo. All actions queue UPDATE tasks, auto-process them, and re-verify.
      </p>

      <div className="space-y-2">
        {REPAIR_ACTIONS.map((actionDef) => {
          const isRunning = running === actionDef.id;
          const summary = summaries[actionDef.id];
          const Icon = actionDef.icon;

          return (
            <div key={actionDef.id} className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-md bg-primary/10 p-1.5">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{actionDef.label}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{actionDef.description}</p>

                  {/* Category override for reassign */}
                  {actionDef.id === "reassign-category" && categories.length > 0 && (
                    <div className="mt-2 relative max-w-xs">
                      <select
                        value={categoryOverride}
                        onChange={(e) => setCategoryOverride(e.target.value)}
                        className="w-full rounded-md border border-border bg-background px-2.5 py-1 text-[11px] text-foreground appearance-none pr-6 cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="">Use saved mappings</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>{c.name} (ID: {c.id})</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                    </div>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs shrink-0"
                  disabled={!!running || processing || !connectionId}
                  onClick={() => handleAction(actionDef)}
                >
                  {isRunning ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wrench className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {isRunning ? "Running…" : "Run"}
                </Button>
              </div>

              {/* Summary */}
              {summary && (
                <div className="flex items-center gap-2 flex-wrap text-[11px] ml-9">
                  {actionDef.id === "reverify" ? (
                    <>
                      <Badge variant="default" className="text-[10px] gap-1 bg-success/15 text-success border-success/30">
                        <CheckCircle2 className="h-2.5 w-2.5" /> {summary.passed} passed
                      </Badge>
                      {(summary.failed || 0) > 0 && (
                        <Badge variant="destructive" className="text-[10px] gap-1">
                          <XCircle className="h-2.5 w-2.5" /> {summary.failed} failed
                        </Badge>
                      )}
                      <span className="text-muted-foreground">of {summary.verified} verified</span>
                    </>
                  ) : (
                    <>
                      <Badge variant="default" className="text-[10px] gap-1">
                        <CheckCircle2 className="h-2.5 w-2.5" /> {summary.queued} queued
                      </Badge>
                      {summary.skipped > 0 && (
                        <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/50 text-amber-600">
                          <AlertTriangle className="h-2.5 w-2.5" /> {summary.skipped} skipped
                        </Badge>
                      )}
                      <span className="text-muted-foreground">of {summary.totalTargets} total</span>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {processing && (
        <div className="flex items-center gap-2 text-xs text-primary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Processing queue + auto-verification…
        </div>
      )}
    </div>
  );
}
