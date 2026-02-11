import { motion } from "framer-motion";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  RefreshCw,
  Filter,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const jobs = [
  { id: "SYNC-0048", location: "La Vinoteca Central", provider: "AGORA", status: "success", startedAt: "2026-02-11 14:30:00", duration: "4.2s", events: 24, errors: 0, businessDay: "2026-02-11" },
  { id: "SYNC-0047", location: "Bodega del Puerto", provider: "AGORA", status: "success", startedAt: "2026-02-11 14:15:00", duration: "3.8s", events: 18, errors: 0, businessDay: "2026-02-11" },
  { id: "SYNC-0046", location: "El Rincón del Vino", provider: "AGORA", status: "warning", startedAt: "2026-02-11 14:00:00", duration: "6.1s", events: 7, errors: 2, businessDay: "2026-02-11" },
  { id: "SYNC-0045", location: "La Vinoteca Central", provider: "AGORA", status: "success", startedAt: "2026-02-11 13:45:00", duration: "3.5s", events: 31, errors: 0, businessDay: "2026-02-11" },
  { id: "SYNC-0044", location: "Bodega del Puerto", provider: "AGORA", status: "failed", startedAt: "2026-02-11 13:30:00", duration: "12.4s", events: 0, errors: 1, businessDay: "2026-02-11" },
  { id: "SYNC-0043", location: "La Vinoteca Central", provider: "AGORA", status: "success", startedAt: "2026-02-11 13:15:00", duration: "4.0s", events: 22, errors: 0, businessDay: "2026-02-10" },
  { id: "SYNC-0042", location: "El Rincón del Vino", provider: "AGORA", status: "success", startedAt: "2026-02-11 13:00:00", duration: "3.2s", events: 15, errors: 0, businessDay: "2026-02-10" },
  { id: "SYNC-0041", location: "Bodega del Puerto", provider: "AGORA", status: "success", startedAt: "2026-02-11 12:45:00", duration: "5.1s", events: 28, errors: 0, businessDay: "2026-02-10" },
];

const statusConfig: Record<string, { icon: typeof CheckCircle2; class: string; badgeVariant: "default" | "destructive" | "secondary" | "outline" }> = {
  success: { icon: CheckCircle2, class: "text-success", badgeVariant: "default" },
  warning: { icon: AlertTriangle, class: "text-warning", badgeVariant: "outline" },
  failed: { icon: XCircle, class: "text-destructive", badgeVariant: "destructive" },
};

export default function SyncMonitor() {
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sync Monitor</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track all sync jobs across your connected locations.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            <Filter className="mr-2 h-3 w-3" /> Filter
          </Button>
          <Button variant="outline" size="sm">
            <Download className="mr-2 h-3 w-3" /> Export
          </Button>
          <Button size="sm">
            <RefreshCw className="mr-2 h-3 w-3" /> Run Now
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Last Successful Sync</p>
          <p className="mt-2 text-lg font-bold text-foreground">3 min ago</p>
          <p className="text-xs text-muted-foreground">SYNC-0048 • La Vinoteca Central</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Next Scheduled</p>
          <p className="mt-2 text-lg font-bold text-foreground">12 min</p>
          <p className="text-xs text-muted-foreground">All 3 locations</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Success Rate (24h)</p>
          <p className="mt-2 text-lg font-bold text-success">93.7%</p>
          <p className="text-xs text-muted-foreground">45 / 48 jobs</p>
        </div>
      </div>

      {/* Jobs table */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-border bg-card shadow-card overflow-hidden"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Job</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Location</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Business Day</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Duration</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Events</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {jobs.map((job) => {
                const st = statusConfig[job.status];
                return (
                  <tr key={job.id} className="hover:bg-secondary/30 transition-colors cursor-pointer">
                    <td className="px-4 py-3 font-mono text-xs text-foreground">{job.id}</td>
                    <td className="px-4 py-3 text-foreground">{job.location}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{job.businessDay}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <st.icon className={`h-3.5 w-3.5 ${st.class}`} />
                        <Badge variant={st.badgeVariant} className="text-[10px] capitalize">
                          {job.status}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{job.duration}</td>
                    <td className="px-4 py-3 text-foreground">{job.events}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{job.startedAt}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
