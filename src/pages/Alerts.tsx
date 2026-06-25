import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Clock,
  Database,
  Info,
  Mail,
  RefreshCw,
  ShieldAlert,
  WifiOff,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

type AlertSeverity = "info" | "warning" | "error" | "critical";
type AlertStatus = "OPEN" | "ACKED" | "RESOLVED";

interface PersistentAlert {
  id: string;
  connection_id: string;
  provider: string;
  alert_key: string;
  alert_type: string;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  message: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  occurrences: number;
  internal_notified_at: string | null;
  client_notified_at: string | null;
  last_notification_error: string | null;
  location_name?: string;
}

interface HealthCheck {
  id: string;
  connection_id: string;
  provider: string;
  location_name: string;
  check_type: string;
  status: string;
  severity: AlertSeverity;
  http_status: number | null;
  latency_ms: number | null;
  error_class: string | null;
  error_message: string | null;
  checked_at: string;
}

interface LegacyAlert {
  id: string;
  level: AlertSeverity | "success";
  title: string;
  message: string;
  time: string;
  source: string;
}

const severityConfig: Record<AlertSeverity | "success", { icon: typeof AlertTriangle; className: string; bgClass: string }> = {
  critical: { icon: ShieldAlert, className: "text-destructive", bgClass: "bg-destructive/10 border-destructive/30" },
  error: { icon: XCircle, className: "text-destructive", bgClass: "bg-destructive/10 border-destructive/20" },
  warning: { icon: AlertTriangle, className: "text-warning", bgClass: "bg-warning/10 border-warning/20" },
  info: { icon: Info, className: "text-info", bgClass: "bg-info/10 border-info/20" },
  success: { icon: CheckCircle2, className: "text-success", bgClass: "bg-success/10 border-success/20" },
};

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.max(0, Math.floor(diff / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString();
}

export default function Alerts() {
  const [alerts, setAlerts] = useState<PersistentAlert[]>([]);
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [legacyAlerts, setLegacyAlerts] = useState<LegacyAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningMonitor, setRunningMonitor] = useState(false);
  const [schemaReady, setSchemaReady] = useState(true);

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const [connRes, alertRes, checkRes, failedStockRes, failedOutboundRes] = await Promise.all([
        supabase.from("pos_connections").select("id, location_name, provider, enabled, last_sync_at, created_at"),
        supabase
          .from("connection_alerts" as any)
          .select("*")
          .order("last_seen_at", { ascending: false })
          .limit(100),
        supabase
          .from("connection_health_checks" as any)
          .select("*")
          .order("checked_at", { ascending: false })
          .limit(100),
        supabase
          .from("stock_sync_log")
          .select("id, product_name, error_message, created_at, connection_id")
          .eq("status", "FAILED")
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("outbound_tasks")
          .select("id, task_type, last_error, blocked_reason, status, created_at, connection_id, payload_json")
          .in("status", ["FAILED", "BLOCKED"])
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      const conns = connRes.data || [];
      const connMap = Object.fromEntries(conns.map((c: any) => [c.id, c]));
      setSchemaReady(!alertRes.error && !checkRes.error);

      const persistent = ((alertRes.data || []) as any[]).map((a) => ({
        ...a,
        location_name: connMap[a.connection_id]?.location_name || a.metadata?.location_name || "Unknown",
      })) as PersistentAlert[];
      setAlerts(persistent);
      setChecks((checkRes.data || []) as any);

      const generated: LegacyAlert[] = [];

      for (const log of failedStockRes.data || []) {
        const l = log as any;
        const loc = connMap[l.connection_id]?.location_name || "Unknown";
        generated.push({
          id: `stock-${l.id}`,
          level: "error",
          title: `Stock sync failed — ${l.product_name}`,
          message: `${l.error_message || "Unknown error"} (${loc})`,
          time: l.created_at,
          source: "stock_sync_log",
        });
      }

      for (const task of failedOutboundRes.data || []) {
        const t = task as any;
        const loc = connMap[t.connection_id]?.location_name || "Unknown";
        const name = t.payload_json?.Name || t.task_type;
        generated.push({
          id: `outbound-${t.id}`,
          level: t.status === "BLOCKED" ? "warning" : "error",
          title: `Outbound ${t.status.toLowerCase()} — ${name}`,
          message: `${t.last_error || t.blocked_reason || "Unknown"} (${loc})`,
          time: t.created_at,
          source: "outbound_tasks",
        });
      }

      generated.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      setLegacyAlerts(generated);
    } catch (e: any) {
      toast({ title: "Error loading alerts", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const runMonitor = async () => {
    setRunningMonitor(true);
    try {
      const { data, error } = await supabase.functions.invoke("connection-health-monitor", {
        body: { provider: "agora", sendEmails: false, notifyClients: false },
      });
      if (error) throw error;
      toast({
        title: "Monitor executed",
        description: `${(data as any)?.checked || 0} Agora connections checked.`,
      });
      await fetchAlerts();
    } catch (e: any) {
      toast({ title: "Monitor failed", description: e.message, variant: "destructive" });
    } finally {
      setRunningMonitor(false);
    }
  };

  const updateAlertStatus = async (alertId: string, status: AlertStatus) => {
    const patch: Record<string, unknown> = { status };
    if (status === "RESOLVED") patch.resolved_at = new Date().toISOString();
    const { error } = await supabase.from("connection_alerts" as any).update(patch).eq("id", alertId);
    if (error) {
      toast({ title: "Could not update alert", description: error.message, variant: "destructive" });
      return;
    }
    await fetchAlerts();
  };

  const openAlerts = useMemo(() => alerts.filter((a) => a.status !== "RESOLVED"), [alerts]);
  const resolvedAlerts = useMemo(() => alerts.filter((a) => a.status === "RESOLVED"), [alerts]);
  const criticalCount = openAlerts.filter((a) => a.severity === "critical").length;
  const errorCount = openAlerts.filter((a) => a.severity === "error").length;
  const warningCount = openAlerts.filter((a) => a.severity === "warning").length;
  const lastCheck = checks[0];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Alerts & Health</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Persistent incidents, email notifications, and live sync warnings.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={fetchAlerts} disabled={loading}>
            <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button size="sm" onClick={runMonitor} disabled={runningMonitor || !schemaReady}>
            <BellRing className={`mr-2 h-3 w-3 ${runningMonitor ? "animate-pulse" : ""}`} /> Run Monitor
          </Button>
        </div>
      </div>

      {!schemaReady && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-warning" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Monitoring tables pending</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Apply the connection health migration in Lovable Cloud before persistent alerts can be shown.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <SummaryCard icon={ShieldAlert} label="Critical" value={criticalCount} tone={criticalCount > 0 ? "danger" : "muted"} />
        <SummaryCard icon={XCircle} label="Errors" value={errorCount} tone={errorCount > 0 ? "danger" : "muted"} />
        <SummaryCard icon={AlertTriangle} label="Warnings" value={warningCount} tone={warningCount > 0 ? "warning" : "muted"} />
        <SummaryCard icon={Clock} label="Last Check" value={lastCheck ? timeAgo(lastCheck.checked_at) : "Never"} tone={lastCheck ? "default" : "muted"} />
      </div>

      {openAlerts.length === 0 && legacyAlerts.length === 0 && !loading && (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <Database className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No alerts — all monitored systems are healthy.</p>
        </div>
      )}

      <Tabs defaultValue="open" className="space-y-4">
        <TabsList>
          <TabsTrigger value="open">
            Open
            {openAlerts.length > 0 && <Badge variant="destructive" className="ml-2 text-[10px]">{openAlerts.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="checks">Health Checks</TabsTrigger>
          <TabsTrigger value="legacy">
            Sync Signals
            {legacyAlerts.length > 0 && <Badge variant="secondary" className="ml-2 text-[10px]">{legacyAlerts.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="resolved">Resolved</TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="space-y-3">
          {openAlerts.map((alert, i) => (
            <PersistentAlertCard key={alert.id} alert={alert} index={i} onUpdateStatus={updateAlertStatus} />
          ))}
        </TabsContent>

        <TabsContent value="checks" className="space-y-3">
          {checks.map((check, i) => (
            <HealthCheckRow key={check.id} check={check} index={i} />
          ))}
        </TabsContent>

        <TabsContent value="legacy" className="space-y-3">
          {legacyAlerts.map((alert, i) => (
            <LegacyAlertCard key={alert.id} alert={alert} index={i} />
          ))}
        </TabsContent>

        <TabsContent value="resolved" className="space-y-3">
          {resolvedAlerts.map((alert, i) => (
            <PersistentAlertCard key={alert.id} alert={alert} index={i} onUpdateStatus={updateAlertStatus} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof AlertTriangle;
  label: string;
  value: string | number;
  tone: "default" | "danger" | "warning" | "muted";
}) {
  const toneClass =
    tone === "danger" ? "text-destructive" :
    tone === "warning" ? "text-warning" :
    tone === "muted" ? "text-muted-foreground" :
    "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-card">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${toneClass}`} />
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className={`mt-2 text-xl font-bold ${toneClass}`}>{value}</p>
    </div>
  );
}

function PersistentAlertCard({
  alert,
  index,
  onUpdateStatus,
}: {
  alert: PersistentAlert;
  index: number;
  onUpdateStatus: (id: string, status: AlertStatus) => void;
}) {
  const cfg = severityConfig[alert.severity];
  const Icon = cfg.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
      className={`rounded-xl border p-4 ${cfg.bgClass} ${alert.status === "RESOLVED" ? "opacity-60" : ""}`}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${cfg.className}`} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{alert.title}</h3>
              <Badge variant={alert.status === "RESOLVED" ? "secondary" : "outline"} className="text-[10px]">{alert.status}</Badge>
              <Badge variant="outline" className="text-[10px]">{alert.alert_type}</Badge>
              {alert.client_notified_at && (
                <Badge variant="secondary" className="text-[10px]">
                  <Mail className="mr-1 h-3 w-3" /> Client emailed
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{alert.message}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
              <span>{alert.location_name}</span>
              <span>Seen {alert.occurrences}x</span>
              <span>First {formatDate(alert.first_seen_at)}</span>
              <span>Last {timeAgo(alert.last_seen_at)}</span>
            </div>
            {alert.last_notification_error && (
              <p className="mt-2 rounded-md bg-background/50 px-2 py-1 text-[10px] text-destructive">
                Email: {alert.last_notification_error}
              </p>
            )}
          </div>
        </div>
        {alert.status !== "RESOLVED" && (
          <div className="flex shrink-0 gap-2">
            {alert.status === "OPEN" && (
              <Button variant="outline" size="sm" onClick={() => onUpdateStatus(alert.id, "ACKED")}>
                Ack
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => onUpdateStatus(alert.id, "RESOLVED")}>
              Resolve
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function HealthCheckRow({ check, index }: { check: HealthCheck; index: number }) {
  const level: AlertSeverity | "success" =
    check.status === "OK" ? "success" : check.severity || "warning";
  const cfg = severityConfig[level];
  const Icon = check.status === "DOWN" ? WifiOff : cfg.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.02 }}
      className="rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${cfg.className}`} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{check.location_name}</h3>
              <Badge variant="outline" className="text-[10px]">{check.status}</Badge>
              {check.http_status && <Badge variant="secondary" className="text-[10px]">HTTP {check.http_status}</Badge>}
              {check.latency_ms !== null && <Badge variant="secondary" className="text-[10px]">{check.latency_ms}ms</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{check.error_message || check.error_class || "Healthy probe"}</p>
          </div>
        </div>
        <p className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(check.checked_at)}</p>
      </div>
    </motion.div>
  );
}

function LegacyAlertCard({ alert, index }: { alert: LegacyAlert; index: number }) {
  const cfg = severityConfig[alert.level];
  const Icon = cfg.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
      className={`rounded-xl border p-4 ${cfg.bgClass}`}
    >
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${cfg.className}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{alert.title}</h3>
            <Badge variant="outline" className="text-[10px]">{alert.source}</Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{alert.message}</p>
          <p className="mt-2 text-[10px] text-muted-foreground">{timeAgo(alert.time)}</p>
        </div>
      </div>
    </motion.div>
  );
}
