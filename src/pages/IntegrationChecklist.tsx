import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Eye, ListChecks, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  getGoLiveBlockingItems,
  getIntegrationChecklist,
  getRequiredItems,
  phaseLabels,
  priorityLabels,
  type ChecklistPhase,
  type ChecklistPriority,
  type ChecklistProvider,
  type IntegrationChecklistItem,
} from "@/lib/integrationChecklist";

const priorityMeta: Record<ChecklistPriority, { className: string; icon: typeof CheckCircle2 }> = {
  required: {
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    icon: AlertTriangle,
  },
  recommended: {
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: ShieldCheck,
  },
  optional: {
    className: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
    icon: Eye,
  },
};

const phaseOrder: ChecklistPhase[] = ["access", "catalog", "sales", "stock", "goLive", "monitoring"];

function groupByPhase(items: IntegrationChecklistItem[]): Record<ChecklistPhase, IntegrationChecklistItem[]> {
  return items.reduce((acc, item) => {
    acc[item.phase] = [...(acc[item.phase] || []), item];
    return acc;
  }, {} as Record<ChecklistPhase, IntegrationChecklistItem[]>);
}

export default function IntegrationChecklist() {
  const [provider, setProvider] = useState<ChecklistProvider>("agora");
  const checklist = useMemo(() => getIntegrationChecklist(provider), [provider]);
  const requiredItems = useMemo(() => getRequiredItems(checklist), [checklist]);
  const blockingItems = useMemo(() => getGoLiveBlockingItems(checklist), [checklist]);
  const grouped = useMemo(() => groupByPhase(checklist.items), [checklist]);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Checklist de integración</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Guia operativa para que comercial pueda preparar una conexion y tecnica pueda activarla sin improvisar.
          </p>
        </div>
        <div className="w-full md:w-52">
          <Select value={provider} onValueChange={(value) => setProvider(value as ChecklistProvider)}>
            <SelectTrigger aria-label="Proveedor">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agora">Agora</SelectItem>
              <SelectItem value="revo">REVO</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <div>
              <p className="text-xs uppercase text-muted-foreground">Proveedor</p>
              <p className="mt-1 text-lg font-semibold text-foreground">{checklist.title}</p>
            </div>
            <ClipboardCheck className="h-5 w-5 text-primary" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <div>
              <p className="text-xs uppercase text-muted-foreground">Obligatorios</p>
              <p className="mt-1 text-lg font-semibold text-foreground">{requiredItems.length}</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-red-500" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <div>
              <p className="text-xs uppercase text-muted-foreground">Bloquean go live</p>
              <p className="mt-1 text-lg font-semibold text-foreground">{blockingItems.length}</p>
            </div>
            <ListChecks className="h-5 w-5 text-amber-500" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">{checklist.summary}</p>
        </CardContent>
      </Card>

      <div className="space-y-5">
        {phaseOrder.map((phase) => {
          const items = grouped[phase] || [];
          if (items.length === 0) return null;

          return (
            <Card key={phase}>
              <CardHeader>
                <CardTitle className="text-base">{phaseLabels[phase]}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {items.map((item) => {
                  const meta = priorityMeta[item.priority];
                  const Icon = meta.icon;
                  return (
                    <div key={item.id} className="rounded-md border border-border p-4">
                      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <h2 className="text-sm font-semibold text-foreground">{item.title}</h2>
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">{item.rationale}</p>
                          <p className="mt-2 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">Evidencia: </span>
                            {item.evidence}
                          </p>
                        </div>
                        <Badge variant="outline" className={meta.className}>
                          {priorityLabels[item.priority]}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
