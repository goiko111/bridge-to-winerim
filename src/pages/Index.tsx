import { motion } from "framer-motion";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  AlertTriangle,
  TrendingUp,
  Plug,
  Wine,
} from "lucide-react";

const stats = [
  {
    label: "Active Connections",
    value: "3",
    change: "+1 this week",
    icon: Plug,
    color: "text-success",
  },
  {
    label: "Sales Events Synced",
    value: "12,847",
    change: "+2,340 today",
    icon: TrendingUp,
    color: "text-primary",
  },
  {
    label: "Products Mapped",
    value: "89%",
    change: "142 / 160",
    icon: Wine,
    color: "text-accent",
  },
  {
    label: "Sync Health",
    value: "98.2%",
    change: "Last 7 days",
    icon: Activity,
    color: "text-success",
  },
];

const recentJobs = [
  { id: "JOB-001", location: "La Vinoteca Central", status: "success", time: "2 min ago", events: 24 },
  { id: "JOB-002", location: "Bodega del Puerto", status: "success", time: "17 min ago", events: 18 },
  { id: "JOB-003", location: "El Rincón del Vino", status: "warning", time: "32 min ago", events: 7 },
  { id: "JOB-004", location: "La Vinoteca Central", status: "success", time: "47 min ago", events: 31 },
  { id: "JOB-005", location: "Bodega del Puerto", status: "failed", time: "1h ago", events: 0 },
];

const statusConfig: Record<string, { icon: typeof CheckCircle2; class: string }> = {
  success: { icon: CheckCircle2, class: "text-success" },
  warning: { icon: AlertTriangle, class: "text-warning" },
  failed: { icon: AlertTriangle, class: "text-destructive" },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export default function Dashboard() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Overview of all TPV integrations and sync activity.
        </p>
      </div>

      {/* Stats */}
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {stats.map((s) => (
          <motion.div
            key={s.label}
            variants={fadeUp}
            className="rounded-xl border border-border bg-card p-5 shadow-card"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {s.label}
              </span>
              <s.icon className={`h-4 w-4 ${s.color}`} />
            </div>
            <div className="mt-3 text-2xl font-bold text-foreground">{s.value}</div>
            <p className="mt-1 text-xs text-muted-foreground">{s.change}</p>
          </motion.div>
        ))}
      </motion.div>

      {/* Recent Sync Jobs */}
      <motion.div variants={fadeUp} initial="hidden" animate="show">
        <div className="rounded-xl border border-border bg-card shadow-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">Recent Sync Jobs</h2>
            <a
              href="/sync-monitor"
              className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              View all <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
          <div className="divide-y divide-border">
            {recentJobs.map((job) => {
              const st = statusConfig[job.status];
              return (
                <div
                  key={job.id}
                  className="flex items-center justify-between px-5 py-3.5"
                >
                  <div className="flex items-center gap-3">
                    <st.icon className={`h-4 w-4 ${st.class}`} />
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {job.location}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {job.id}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <span className="text-xs text-muted-foreground">
                      {job.events} events
                    </span>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {job.time}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
