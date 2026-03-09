import { useState } from "react";
import { Wrench, Loader2, DollarSign, Grape, ShieldCheck, Settings2, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";

interface RepairResult {
  success: boolean;
  action: string;
  updated: number;
  skipped: number;
  failed: number;
  totalTargets: number;
  errors?: string[];
}

interface BdpRepairActionsPanelProps {
  connectionId: string | null;
  onRepairAction: (action: string) => Promise<RepairResult | null>;
  repairing: boolean;
}

const REPAIR_ACTIONS = [
  {
    id: "fix-prices",
    action: "repair-fix-prices",
    label: "Fix Prices",
    description: "Re-sends current prices from the catalog to all existing BDP products via PUT.",
    icon: DollarSign,
  },
  {
    id: "reassign-category",
    action: "repair-reassign-category",
    label: "Reassign Category",
    description: "Updates family/department using the saved wine-type → BDP family mappings.",
    icon: Grape,
  },
  {
    id: "fix-tax",
    action: "repair-fix-tax",
    label: "Fix Tax / VAT",
    description: "Corrects VAT rates on existing BDP products using catalog data or the default rate.",
    icon: Settings2,
  },
  {
    id: "re-verify",
    action: "repair-re-verify",
    label: "Re-run Verification",
    description: "Checks all products in BDP without modifying them. Reports price, family, and tax status.",
    icon: ShieldCheck,
  },
];

export default function BdpRepairActionsPanel({ connectionId, onRepairAction, repairing }: BdpRepairActionsPanelProps) {
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RepairResult>>({});
  const [expandedErrors, setExpandedErrors] = useState<string | null>(null);

  const handleRun = async (actionId: string, actionKey: string, label: string) => {
    setActiveAction(actionId);
    try {
      const result = await onRepairAction(actionKey);
      if (result) {
        setResults((prev) => ({ ...prev, [actionId]: result }));
        if (result.success) {
          toast({ title: `✅ ${label}`, description: `${result.updated} updated, ${result.skipped} skipped` });
        } else {
          toast({ title: `⚠️ ${label}`, description: `${result.failed} failed, ${result.updated} updated`, variant: "destructive" });
        }
      }
    } finally {
      setActiveAction(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Wrench className="h-3.5 w-3.5 text-primary" />
        <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Repair Actions</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Fix existing BDP products without recreating them. Each action uses UPDATE and runs post-write verification automatically.
      </p>

      <div className="grid gap-2">
        {REPAIR_ACTIONS.map((ra) => {
          const isRunning = activeAction === ra.id;
          const result = results[ra.id];
          const Icon = ra.icon;

          return (
            <div key={ra.id} className="rounded-lg border border-border bg-card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-foreground">{ra.label}</p>
                    <p className="text-[10px] text-muted-foreground">{ra.description}</p>
                  </div>
                </div>
                <Button
                  onClick={() => handleRun(ra.id, ra.action, ra.label)}
                  disabled={!connectionId || repairing || isRunning}
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                >
                  {isRunning ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Wrench className="mr-1.5 h-3 w-3" />}
                  {isRunning ? "Running…" : "Run"}
                </Button>
              </div>

              {result && (
                <div className={`rounded border p-2 text-[11px] space-y-1 ${
                  result.success
                    ? "border-success/30 bg-success/5"
                    : "border-destructive/30 bg-destructive/5"
                }`}>
                  <div className="flex items-center gap-3 flex-wrap">
                    {result.success ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                    ) : (
                      <XCircle className="h-3 w-3 text-destructive shrink-0" />
                    )}
                    <Badge variant="outline" className="text-[9px] border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                      {result.updated} updated
                    </Badge>
                    {result.skipped > 0 && (
                      <Badge variant="outline" className="text-[9px] border-muted-foreground/30 text-muted-foreground">
                        {result.skipped} skipped
                      </Badge>
                    )}
                    {result.failed > 0 && (
                      <Badge variant="outline" className="text-[9px] border-destructive/30 text-destructive">
                        {result.failed} failed
                      </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {result.totalTargets} targets
                    </span>
                  </div>

                  {result.errors && result.errors.length > 0 && (
                    <div>
                      <button
                        onClick={() => setExpandedErrors(expandedErrors === ra.id ? null : ra.id)}
                        className="flex items-center gap-1 text-[10px] text-destructive hover:underline"
                      >
                        <AlertTriangle className="h-2.5 w-2.5" />
                        {expandedErrors === ra.id ? "Hide errors" : `Show ${result.errors.length} error(s)`}
                      </button>
                      {expandedErrors === ra.id && (
                        <pre className="mt-1 max-h-24 overflow-auto rounded border border-destructive/20 bg-destructive/5 p-1.5 text-[10px] font-mono text-foreground whitespace-pre-wrap break-all">
                          {result.errors.join("\n")}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
