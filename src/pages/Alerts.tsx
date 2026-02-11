import { motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  Bell,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

const alerts = [
  {
    id: 1,
    level: "error",
    title: "Connection Failed — Bodega del Puerto",
    message: "Unable to reach Agora at 192.168.2.50:8080. Request timed out after 10s. Check network and Agora service status.",
    time: "1h ago",
    resolved: false,
  },
  {
    id: 2,
    level: "warning",
    title: "Partial Sync — El Rincón del Vino",
    message: "2 documents failed normalization due to missing product IDs. Review raw export documents.",
    time: "32 min ago",
    resolved: false,
  },
  {
    id: 3,
    level: "info",
    title: "New Products Detected",
    message: "3 new products found in latest export from La Vinoteca Central. Map them in the Integrations area.",
    time: "2h ago",
    resolved: false,
  },
  {
    id: 4,
    level: "success",
    title: "Backfill Complete — La Vinoteca Central",
    message: "Successfully imported 30 days of historical data. 847 sales events processed.",
    time: "5h ago",
    resolved: true,
  },
];

const levelConfig: Record<string, { icon: typeof AlertTriangle; class: string; bgClass: string }> = {
  error: { icon: XCircle, class: "text-destructive", bgClass: "bg-destructive/10 border-destructive/20" },
  warning: { icon: AlertTriangle, class: "text-warning", bgClass: "bg-warning/10 border-warning/20" },
  info: { icon: Info, class: "text-info", bgClass: "bg-info/10 border-info/20" },
  success: { icon: CheckCircle2, class: "text-success", bgClass: "bg-success/10 border-success/20" },
};

export default function Alerts() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Alerts & Health</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Monitor connectivity issues, sync failures, and data warnings.
        </p>
      </div>

      <div className="space-y-3">
        {alerts.map((alert, i) => {
          const cfg = levelConfig[alert.level];
          return (
            <motion.div
              key={alert.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06 }}
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
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{alert.message}</p>
                  <p className="mt-2 text-[10px] text-muted-foreground">{alert.time}</p>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
