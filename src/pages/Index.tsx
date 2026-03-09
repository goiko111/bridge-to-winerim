import { useEffect, useState } from "react";
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
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

interface DashboardStats {
  activeConnections: number;
  totalConnections: number;
  salesEvents: number;
  recentSalesEvents: number;
  mappedProducts: number;
  totalProducts: number;
  successSyncs: number;
  totalSyncs: number;
}

interface RecentJob {
  id: string;
  location: string;
  provider: string;
  status: "success" | "warning" | "failed";
  time: string;
  events: number;
}

const statusConfig: Record<string, { icon: typeof CheckCircle2; class: string }> = {
  success: { icon: CheckCircle2, class: "text-success" },
  warning: { icon: AlertTriangle, class: "text-warning" },
  failed: { icon: AlertTriangle, class: "text-destructive" },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats>({
    activeConnections: 0, totalConnections: 0,
    salesEvents: 0, recentSalesEvents: 0,
    mappedProducts: 0, totalProducts: 0,
    successSyncs: 0, totalSyncs: 0,
  });
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [connRes, salesRes, productsRes, stockRes, recentSalesRes] = await Promise.all([
        supabase.from("pos_connections").select("id, location_name, provider, enabled, last_sync_at"),
        supabase.from("sales_events").select("id", { count: "exact", head: true }),
        supabase.from("provider_products").select("id, winerim_wine_id", { count: "exact" }),
        supabase.from("stock_sync_log").select("id, status", { count: "exact" }),
        supabase.from("sales_events").select("id, connection_id, business_day, line_count, created_at").order("created_at", { ascending: false }).limit(8),
      ]);

      const conns = connRes.data || [];
      const products = productsRes.data || [];
      const stockLogs = stockRes.data || [];
      const connMap = Object.fromEntries(conns.map((c: any) => [c.id, c]));

      setStats({
        activeConnections: conns.filter((c: any) => c.enabled).length,
        totalConnections: conns.length,
        salesEvents: salesRes.count || 0,
        recentSalesEvents: (recentSalesRes.data || []).reduce((sum: number, e: any) => sum + (e.line_count || 0), 0),
        mappedProducts: products.filter((p: any) => p.winerim_wine_id).length,
        totalProducts: products.length,
        successSyncs: stockLogs.filter((l: any) => l.status === "SUCCESS").length,
        totalSyncs: stockLogs.length,
      });

      const jobs: RecentJob[] = (recentSalesRes.data || []).map((ev: any) => {
        const conn = connMap[ev.connection_id];
        return {
          id: ev.id.slice(0, 8),
          location: conn?.location_name || "Unknown",
          provider: conn?.provider || "—",
          status: "success" as const,
          time: timeAgo(ev.created_at),
          events: ev.line_count || 0,
        };
      });
      setRecentJobs(jobs);
    } catch (e) {
      console.error("Dashboard fetch error:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const mappingPct = stats.totalProducts > 0
    ? Math.round((stats.mappedProducts / stats.totalProducts) * 100)
    : 0;
  const syncHealth = stats.totalSyncs > 0
    ? ((stats.successSyncs / stats.totalSyncs) * 100).toFixed(1)
    : "—";

  const statCards = [
    {
      label: "Active Connections",
      value: String(stats.activeConnections),
      change: `${stats.totalConnections} total`,
      icon: Plug,
      color: "text-success",
    },
    {
      label: "Sales Events",
      value: stats.salesEvents.toLocaleString(),
      change: `${stats.recentSalesEvents} recent line items`,
      icon: TrendingUp,
      color: "text-primary",
    },
    {
      label: "Products Mapped",
      value: `${mappingPct}%`,
      change: `${stats.mappedProducts} / ${stats.totalProducts}`,
      icon: Wine,
      color: "text-accent",
    },
    {
      label: "Sync Health",
      value: syncHealth === "—" ? "—" : `${syncHealth}%`,
      change: `${stats.successSyncs} / ${stats.totalSyncs} stock syncs`,
      icon: Activity,
      color: "text-success",
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Overview of all TPV integrations and sync activity.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <motion.div variants={stagger} initial="hidden" animate="show" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((s) => (
          <motion.div key={s.label} variants={fadeUp} className="rounded-xl border border-border bg-card p-5 shadow-card">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{s.label}</span>
              <s.icon className={`h-4 w-4 ${s.color}`} />
            </div>
            <div className="mt-3 text-2xl font-bold text-foreground">{s.value}</div>
            <p className="mt-1 text-xs text-muted-foreground">{s.change}</p>
          </motion.div>
        ))}
      </motion.div>

      <motion.div variants={fadeUp} initial="hidden" animate="show">
        <div className="rounded-xl border border-border bg-card shadow-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">Recent Sales Imports</h2>
            <a href="/sync-monitor" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              View all <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
          <div className="divide-y divide-border">
            {recentJobs.length === 0 && !loading && (
              <div className="px-5 py-8 text-center text-sm text-muted-foreground">No sales events yet.</div>
            )}
            {recentJobs.map((job) => {
              const st = statusConfig[job.status];
              return (
                <div key={job.id} className="flex items-center justify-between px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <st.icon className={`h-4 w-4 ${st.class}`} />
                    <div>
                      <p className="text-sm font-medium text-foreground">{job.location}</p>
                      <p className="text-xs text-muted-foreground">
                        <Badge variant="secondary" className="text-[10px] mr-1 uppercase">{job.provider}</Badge>
                        <span className="font-mono">{job.id}</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <span className="text-xs text-muted-foreground">{job.events} lines</span>
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
