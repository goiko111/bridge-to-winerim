import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Database,
  Trash2,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { toast } from "@/hooks/use-toast";

interface Connection {
  id: string;
  location_name: string;
  provider: string;
  enabled: boolean;
  last_sync_at: string | null;
  last_business_day_synced: string | null;
  created_at: string;
  base_url: string;
}

interface SalesEvent {
  id: string;
  connection_id: string;
  provider_doc_id: string;
  business_day: string;
  doc_type: string;
  total_amount: number;
  total_tax: number;
  total_net: number;
  line_count: number;
  created_at: string;
  location_name?: string;
}

const statusConfig: Record<string, { icon: typeof CheckCircle2; class: string; badgeVariant: "default" | "destructive" | "secondary" | "outline" }> = {
  success: { icon: CheckCircle2, class: "text-success", badgeVariant: "default" },
  warning: { icon: AlertTriangle, class: "text-warning", badgeVariant: "outline" },
  failed: { icon: XCircle, class: "text-destructive", badgeVariant: "destructive" },
};

export default function SyncMonitor() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [salesEvents, setSalesEvents] = useState<SalesEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleDelete = async (conn: Connection) => {
    if (!window.confirm(`¿Eliminar conexión "${conn.location_name}"? Se borrarán también sus eventos y líneas de venta.`)) return;
    setDeleting(conn.id);
    try {
      await supabase.from("sales_line_items").delete().eq("connection_id", conn.id);
      await supabase.from("sales_events").delete().eq("connection_id", conn.id);
      await supabase.from("wine_family_rules").delete().eq("connection_id", conn.id);
      const { error } = await supabase.from("pos_connections").delete().eq("id", conn.id);
      if (error) throw error;
      toast({ title: "Conexión eliminada", description: conn.location_name });
      fetchData();
    } catch (e: any) {
      toast({ title: "Error al eliminar", description: e.message, variant: "destructive" });
    } finally {
      setDeleting(null);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    const [connRes, eventsRes] = await Promise.all([
      supabase.from("pos_connections").select("*").order("created_at", { ascending: false }),
      supabase.from("sales_events").select("*").order("business_day", { ascending: false }).limit(50),
    ]);

    const conns = (connRes.data || []) as Connection[];
    setConnections(conns);

    const events = (eventsRes.data || []).map((e: any) => ({
      ...e,
      location_name: conns.find((c) => c.id === e.connection_id)?.location_name || "Unknown",
    }));
    setSalesEvents(events);
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const enabledConns = connections.filter((c) => c.enabled);
  const lastSync = connections
    .filter((c) => c.last_sync_at)
    .sort((a, b) => new Date(b.last_sync_at!).getTime() - new Date(a.last_sync_at!).getTime())[0];

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
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Connections</p>
          <p className="mt-2 text-lg font-bold text-foreground">{enabledConns.length} active</p>
          <p className="text-xs text-muted-foreground">{connections.length} total</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Last Sync</p>
          <p className="mt-2 text-lg font-bold text-foreground">
            {lastSync?.last_sync_at
              ? new Date(lastSync.last_sync_at).toLocaleString()
              : "Never"}
          </p>
          <p className="text-xs text-muted-foreground">
            {lastSync?.location_name || "—"}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sales Events</p>
          <p className="mt-2 text-lg font-bold text-foreground">{salesEvents.length}</p>
          <p className="text-xs text-muted-foreground">stored in database</p>
        </div>
      </div>

      {/* Connections */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-border bg-card shadow-card overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">POS Connections</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Location</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Provider</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Last Sync</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Last Business Day</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Created</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {connections.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    <Database className="mx-auto h-8 w-8 mb-2 opacity-40" />
                    No connections found
                  </td>
                </tr>
              )}
              {connections.map((conn) => {
                const st = conn.enabled ? statusConfig.success : statusConfig.warning;
                return (
                  <tr key={conn.id} className="hover:bg-secondary/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground">{conn.location_name}</td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className="text-[10px] uppercase">{conn.provider}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <st.icon className={`h-3.5 w-3.5 ${st.class}`} />
                        <Badge variant={st.badgeVariant} className="text-[10px]">
                          {conn.enabled ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {conn.last_sync_at ? new Date(conn.last_sync_at).toLocaleString() : "Never"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {conn.last_business_day_synced || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(conn.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => navigate(`/integrations/agora?connection=${conn.id}`)}>
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => handleDelete(conn)} disabled={deleting === conn.id}>
                          <Trash2 className={`h-3.5 w-3.5 ${deleting === conn.id ? "animate-spin" : ""}`} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* Sales Events */}
      {salesEvents.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="rounded-xl border border-border bg-card shadow-card overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Sales Events</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Doc ID</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Location</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Business Day</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Total</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Lines</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {salesEvents.map((ev) => (
                  <tr key={ev.id} className="hover:bg-secondary/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-foreground">{ev.provider_doc_id}</td>
                    <td className="px-4 py-3 text-foreground">{ev.location_name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{ev.business_day}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{ev.doc_type}</td>
                    <td className="px-4 py-3 font-mono text-xs text-foreground">€{Number(ev.total_amount).toFixed(2)}</td>
                    <td className="px-4 py-3 text-foreground">{ev.line_count}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(ev.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}
    </div>
  );
}
