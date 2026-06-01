import { useState, useCallback } from "react";
import { Wrench, Loader2, DollarSign, Grape, Settings2, CheckCircle2, AlertTriangle, ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface RepairSummary {
  queued: number;
  skipped: number;
  totalTargets: number;
  action: string;
}

interface RepairActionsProps {
  connectionId: string | null;
  backfillingPreparation: boolean;
  onBackfillPreparation: (winerimWineIds?: string[]) => Promise<any>;
  fixingPrices: boolean;
  onFixMissingPrices: (winerimWineIds: string[], formatTypes?: string[]) => Promise<any>;
  reassigningFamilies: boolean;
  onReassignFamilies: (winerimWineIds?: string[]) => Promise<any>;
  onProcessQueue: () => Promise<any>;
  processingQueue: boolean;
}

const REPAIR_ACTIONS = [
  {
    id: "preparation",
    label: "Fix Preparation Fields",
    description: "Re-pushes products with the configured Preparation Type/Order pair; if none is configured, both fields stay empty.",
    icon: Settings2,
    variant: "outline" as const,
  },
  {
    id: "prices",
    label: "Fix Prices for All PriceLists",
    description: "Re-pushes products with the current Winerim sale prices populated across every active PriceList.",
    icon: DollarSign,
    variant: "outline" as const,
  },
  {
    id: "families",
    label: "Reassign to Mapped Families",
    description: "Updates all pushed products to use the currently configured wine-type → Agora family mappings.",
    icon: Grape,
    variant: "outline" as const,
  },
];

export default function AgoraRepairActionsPanel({
  connectionId,
  backfillingPreparation,
  onBackfillPreparation,
  fixingPrices,
  onFixMissingPrices,
  reassigningFamilies,
  onReassignFamilies,
  onProcessQueue,
  processingQueue,
}: RepairActionsProps) {
  const [summaries, setSummaries] = useState<Record<string, RepairSummary>>({});
  const [migrateRunning, setMigrateRunning] = useState(false);
  const [migrateProcessing, setMigrateProcessing] = useState(false);

  const isRunning = (id: string) => {
    if (id === "preparation") return backfillingPreparation;
    if (id === "prices") return fixingPrices;
    if (id === "families") return reassigningFamilies;
    return false;
  };

  const anyRunning = backfillingPreparation || fixingPrices || reassigningFamilies || processingQueue || migrateRunning || migrateProcessing;

  const handleAction = async (id: string) => {
    let result: any;
    try {
      if (id === "preparation") {
        result = await onBackfillPreparation();
      } else if (id === "prices") {
        result = await onFixMissingPrices([], ["BOTTLE", "GLASS", "MAGNUM"]);
      } else if (id === "families") {
        result = await onReassignFamilies();
      }

      if (result) {
        const summary: RepairSummary = {
          queued: result.queued ?? 0,
          skipped: result.skipped ?? 0,
          totalTargets: result.totalTargets ?? 0,
          action: id,
        };
        setSummaries(prev => ({ ...prev, [id]: summary }));

        if (summary.queued > 0) {
          toast({
            title: `${REPAIR_ACTIONS.find(a => a.id === id)?.label}`,
            description: `${summary.queued} queued, ${summary.skipped} skipped (already pending). Processing…`,
          });
          await onProcessQueue();
        } else {
          toast({
            title: `${REPAIR_ACTIONS.find(a => a.id === id)?.label}`,
            description: summary.skipped > 0
              ? `All ${summary.totalTargets} products already have pending tasks.`
              : `No products to repair.`,
          });
        }
      }
    } catch (e: any) {
      toast({
        title: "Repair failed",
        description: e.message || "Unknown error",
        variant: "destructive",
      });
    }
  };

  const handleMigrate = useCallback(async () => {
    if (!connectionId || migrateRunning) return;
    setMigrateRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "migrate-families-to-production", connectionId },
      });
      if (error) throw error;

      const summary: RepairSummary = {
        queued: data?.queued ?? 0,
        skipped: data?.skipped ?? 0,
        totalTargets: data?.totalTargets ?? 0,
        action: "migrate",
      };
      setSummaries(prev => ({ ...prev, migrate: summary }));

      if (summary.queued > 0) {
        toast({
          title: "Migrate to Production Families",
          description: `${summary.queued} queued, ${summary.skipped} skipped. Processing…`,
        });
        setMigrateProcessing(true);
        try {
          await onProcessQueue();
        } finally {
          setMigrateProcessing(false);
        }
      } else {
        toast({
          title: "Migrate to Production Families",
          description: data?.message || (summary.skipped > 0
            ? `All ${summary.totalTargets} products already have pending tasks.`
            : "No VERIFIED products to migrate."),
        });
      }
    } catch (e: any) {
      toast({
        title: "Migration failed",
        description: e.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setMigrateRunning(false);
    }
  }, [connectionId, migrateRunning, onProcessQueue]);

  const migrateSummary = summaries["migrate"];

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Wrench className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Repair Actions</h3>
        <Badge variant="outline" className="text-[9px] ml-auto">UPDATE only • Idempotent</Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        These actions queue UPDATE tasks for all pushed products. They never delete or recreate — only fix specific fields.
        Post-import verification runs automatically after each task.
      </p>

      <div className="space-y-2">
        {REPAIR_ACTIONS.map(action => {
          const running = isRunning(action.id);
          const summary = summaries[action.id];
          const Icon = action.icon;

          return (
            <div key={action.id} className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-md bg-primary/10 p-1.5">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{action.label}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{action.description}</p>
                </div>
                <Button
                  variant={action.variant}
                  size="sm"
                  className="h-8 text-xs shrink-0"
                  disabled={anyRunning || !connectionId}
                  onClick={() => handleAction(action.id)}
                >
                  {running ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wrench className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {running ? "Running…" : "Run"}
                </Button>
              </div>

              {summary && (
                <div className="flex items-center gap-2 flex-wrap text-[11px] ml-9">
                  <Badge variant="default" className="text-[10px] gap-1">
                    <CheckCircle2 className="h-2.5 w-2.5" />
                    {summary.queued} queued
                  </Badge>
                  {summary.skipped > 0 && (
                    <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/50 text-amber-600">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      {summary.skipped} skipped
                    </Badge>
                  )}
                  <span className="text-muted-foreground">
                    of {summary.totalTargets} total products
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Migration Section */}
      <div className="border-t border-border pt-3 space-y-2">
        <div className="flex items-center gap-2">
          <ArrowRightLeft className="h-4 w-4 text-primary" />
          <h4 className="text-sm font-semibold text-foreground">Production Migration</h4>
          <Badge variant="outline" className="text-[9px] ml-auto">VERIFIED only</Badge>
        </div>
        <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-md bg-primary/10 p-1.5">
              <ArrowRightLeft className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Migrate WINERIM → Production Families</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Moves only VERIFIED products from temporary WINERIM families to the final client families using your saved mappings.
                Uses UPDATE only — no deletes, no recreates.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs shrink-0"
              disabled={anyRunning || !connectionId}
              onClick={handleMigrate}
            >
              {migrateRunning ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
              )}
              {migrateRunning ? "Migrating…" : "Migrate"}
            </Button>
          </div>

          {migrateSummary && (
            <div className="flex items-center gap-2 flex-wrap text-[11px] ml-9">
              <Badge variant="default" className="text-[10px] gap-1">
                <CheckCircle2 className="h-2.5 w-2.5" />
                {migrateSummary.queued} queued
              </Badge>
              {migrateSummary.skipped > 0 && (
                <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/50 text-amber-600">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {migrateSummary.skipped} skipped
                </Badge>
              )}
              <span className="text-muted-foreground">
                of {migrateSummary.totalTargets} VERIFIED products
              </span>
            </div>
          )}
        </div>
      </div>

      {(processingQueue || migrateProcessing) && (
        <div className="flex items-center gap-2 text-xs text-primary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {migrateProcessing ? "Processing migration + post-write verification…" : "Processing queue — verification will run automatically per task…"}
        </div>
      )}
    </div>
  );
}
