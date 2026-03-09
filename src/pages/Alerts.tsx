import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  RefreshCw,
  Database,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

interface Alert {
  id: string;
  level: "error" | "warning" | "info" | "success";
  title: string;
  message: string;
  time: string;
  resolved: boolean;
  source: string;
}

const levelConfig: Record<string, { icon: typeof AlertTriangle; class: string; bgClass: string }> = {
  error: { icon: XCircle, class: "text-destructive", bgClass: "bg-destructive/10 border-destructive/20" },
  warning: { icon: AlertTriangle, class: "text-warning", bgClass: "bg-warning/10 border-warning/20" },
  info: { icon: Info, class: "text-info", bgClass: "bg-info/10 border-info/20" },
  success: { icon: CheckCircle2, class: "text-success", bgClass: "bg-success/10 border-success/20" },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Alerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAlerts = async () => {
    setLoading(true);
    try {
      // Gather alerts from multiple sources in parallel
      const [connRes, failedStockRes, failedOutboundRes, recentSalesRes] = await Promise.all([
        supabase.from("pos_connections").select("id, location_name, provider, enabled, last_sync_at, created_at"),
        supabase.from("stock_sync_log").select("id, product_name, error_message, created_at, connection_id").eq("status", "FAILED").order("created_at", { ascending: false }).limit(10),
        supabase.from("outbound_tasks").select("id, task_type, last_error, blocked_reason, status, created_at, connection_id, payload_json").in("status", ["FAILED", "BLOCKED"]).order("created_at", { ascending: false }).limit(10),
        supabase.from("sales_events").select("id, connection_id, business_day, line_count, created_at").order("created_at", { ascending: false }).limit(5),
      ]);

      const conns = connRes.data || [];
      const connMap = Object.fromEntries(conns.map((c: any) => [c.id, c]));
      const generated: Alert[] = [];

      // Connection health alerts
      for (const c of conns) {
        const conn = c as any;
        if (!conn.enabled) continue;
        if (conn.last_sync_at) {
          const hoursSince = (Date.now() - new Date(conn.last_sync_at).getTime()) / 3600000;
          if (hoursSince > 24) {
            generated.push({
              id: `stale-${conn.id}`,
              level: "warning",
              title: `Stale sync — ${conn.location_name}`,
              message: `No sync activity for ${Math.floor(hoursSince)}h. Last sync: ${new Date(conn.last_sync_at).toLocaleString()}.`,
              time: conn.last_sync_at,
              resolved: false,
              source: "connection",
            });
          }
        }
      }

      // Stock sync failures
      for (const log of (failedStockRes.data || [])) {
        const l = log as any;
        const loc = connMap[l.connection_id]?.location_name || "Unknown";
        generated.push({
          id: `stock-${l.id}`,
          level: "error",
          title: `Stock sync failed — ${l.product_name}`,
          message: `${l.error_message || "Unknown error"} (${loc})`,
          time: l.created_at,
          resolved: false,
          source: "stock_sync",
        });
      }

      // Outbound failures
      for (const task of (failedOutboundRes.data || [])) {
        const t = task as any;
        const loc = connMap[t.connection_id]?.location_name || "Unknown";
        const name = t.payload_json?.Name || t.task_type;
        generated.push({
          id: `outbound-${t.id}`,
          level: t.status === "BLOCKED" ? "warning" : "error",
          title: `Outbound ${t.status.toLowerCase()} — ${name}`,
          message: `${t.last_error || t.blocked_reason || "Unknown"} (${loc})`,
          time: t.created_at,
          resolved: false,
          source: "outbound",
        });
      }

      // Recent sales (info)
      for (const ev of (recentSalesRes.data || [])) {
        const e = ev as any;
        const loc = connMap[e.connection_id]?.location_name || "Unknown";
        generated.push({
          id: `sales-${e.id}`,
          level: "success",
          title: `Sales synced — ${loc}`,
          message: `Business day ${e.business_day}: ${e.line_count} line items imported.`,
          time: e.created_at,
          resolved: true,
          source: "sales",
        });
      }

      // Sort by time desc
      generated.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      setAlerts(generated);
    } catch (e) {
      console.error("Failed to fetch alerts:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAlerts(); }, []);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Alerts & Health</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live connectivity issues, sync failures, and data warnings.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchAlerts} disabled={loading}>
          <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {alerts.length === 0 && !loading && (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <Database className="mx-auto h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">No alerts — all systems healthy.</p>
        </div>
      )}

      <div className="space-y-3">
        {alerts.map((alert, i) => {
          const cfg = levelConfig[alert.level];
          return (
            <motion.div
              key={alert.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              className={`rounded-xl border p-4 ${cfg.bgClass} ${alert.resolved ? "opacity-50" : ""}`}
            >
              <div className="flex items-start gap-3">
                <cfg.icon className={`h-5 w-5 mt-0.5 shrink-0 ${cfg.class}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{alert.title}</h3>
                    {alert.resolved && (
                      <Badge variant="secondary" className="text-[10px]">Resolved</Badge>
                    )}
                    <Badge variant="outline" className="text-[10px]">{alert.source}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{alert.message}</p>
                  <p className="mt-2 text-[10px] text-muted-foreground">{timeAgo(alert.time)}</p>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
