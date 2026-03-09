import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Database,
  Trash2,
  Eye,
  ArrowDownToLine,
  Clock,
  Wine,
  Upload,
  Play,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  winerim_api_token: string | null;
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

interface StockSyncLog {
  id: string;
  connection_id: string;
  sales_event_id: string;
  sales_line_item_id: string;
  provider_product_id: string;
  winerim_product_id: string;
  product_name: string;
  quantity: number;
  status: string;
  error_message: string | null;
  created_at: string;
  synced_at: string | null;
}

const statusConfig: Record<string, { icon: typeof CheckCircle2; class: string; badgeVariant: "default" | "destructive" | "secondary" | "outline" }> = {
  success: { icon: CheckCircle2, class: "text-success", badgeVariant: "default" },
  warning: { icon: AlertTriangle, class: "text-warning", badgeVariant: "outline" },
  failed: { icon: XCircle, class: "text-destructive", badgeVariant: "destructive" },
};

export default function SyncMonitor() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [salesEvents, setSalesEvents] = useState<SalesEvent[]>([]);
  const [stockLogs, setStockLogs] = useState<StockSyncLog[]>([]);
  const [outboundTasks, setOutboundTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [syncingStock, setSyncingStock] = useState<string | null>(null);
  const [processingOutbound, setProcessingOutbound] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleDelete = async (conn: Connection) => {
    if (!window.confirm(`¿Eliminar conexión "${conn.location_name}"? Se borrarán también sus eventos y líneas de venta.`)) return;
    setDeleting(conn.id);
    try {
      await supabase.from("stock_sync_log").delete().eq("connection_id", conn.id);
      await supabase.from("sales_line_items").delete().eq("connection_id", conn.id);
      await supabase.from("sales_events").delete().eq("connection_id", conn.id);
      await supabase.from("wine_family_rules").delete().eq("connection_id", conn.id);
      await supabase.from("provider_products").delete().eq("connection_id", conn.id);
      await supabase.from("classification_config").delete().eq("connection_id", conn.id);
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

  const getProxyName = (provider: string) => `${provider}-proxy`;

  const syncStockForConnection = useCallback(async (conn: Connection) => {
    if (!conn.last_business_day_synced) {
      toast({ title: "Sin ventas", description: "No hay día de ventas sincronizado aún.", variant: "destructive" });
      return;
    }
    if (!conn.winerim_api_token) {
      toast({ title: "Sin token Winerim", description: "Configura el token de API de Winerim en la conexión.", variant: "destructive" });
      return;
    }
    setSyncingStock(conn.id);
    try {
      const { data, error } = await supabase.functions.invoke(getProxyName(conn.provider), {
        body: { action: "sync-stock", connectionId: conn.id, businessDay: conn.last_business_day_synced },
      });
      if (error) throw error;
      toast({
        title: "Stock sincronizado",
        description: `✅ ${data.synced} descontados, ⏭️ ${data.skipped} ya sincronizados, ❌ ${data.failed} fallidos, 🔗 ${data.unmapped} sin mapear`,
      });
      fetchData();
    } catch (e: any) {
      toast({ title: "Error sync stock", description: e.message, variant: "destructive" });
    } finally {
      setSyncingStock(null);
    }
  }, []);

  const processOutboundForConnection = useCallback(async (conn: Connection) => {
    setProcessingOutbound(conn.id);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "process-outbound-queue", connectionId: conn.id },
      });
      if (error) throw error;
      toast({
        title: "Outbound processed",
        description: `${data.succeeded} succeeded, ${data.failed} failed of ${data.processed} tasks`,
      });
      fetchData();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setProcessingOutbound(null);
    }
  }, []);

  const fetchData = async () => {
    setLoading(true);
    const [connRes, eventsRes, logsRes, outboundRes] = await Promise.all([
      supabase.from("pos_connections").select("*").order("created_at", { ascending: false }),
      supabase.from("sales_events").select("*").order("business_day", { ascending: false }).limit(50),
      supabase.from("stock_sync_log").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("outbound_tasks").select("*").order("created_at", { ascending: false }).limit(100),
    ]);

    const conns = (connRes.data || []) as Connection[];
    setConnections(conns);

    const events = (eventsRes.data || []).map((e: any) => ({
      ...e,
      location_name: conns.find((c) => c.id === e.connection_id)?.location_name || "Unknown",
    }));
    setSalesEvents(events);
    setStockLogs((logsRes.data || []) as unknown as StockSyncLog[]);
    setOutboundTasks(outboundRes.data || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const enabledConns = connections.filter((c) => c.enabled);
  const lastSync = connections
    .filter((c) => c.last_sync_at)
    .sort((a, b) => new Date(b.last_sync_at!).getTime() - new Date(a.last_sync_at!).getTime())[0];

  const successLogs = stockLogs.filter(l => l.status === "SUCCESS");
  const failedLogs = stockLogs.filter(l => l.status === "FAILED");
  const pendingLogs = stockLogs.filter(l => l.status === "PENDING");

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

      <div className="grid gap-4 sm:grid-cols-5">
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Connections</p>
          <p className="mt-2 text-lg font-bold text-foreground">{enabledConns.length} active</p>
          <p className="text-xs text-muted-foreground">{connections.length} total</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Last Sync</p>
          <p className="mt-2 text-lg font-bold text-foreground">
            {lastSync?.last_sync_at ? new Date(lastSync.last_sync_at).toLocaleString() : "Never"}
          </p>
          <p className="text-xs text-muted-foreground">{lastSync?.location_name || "—"}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sales Events</p>
          <p className="mt-2 text-lg font-bold text-foreground">{salesEvents.length}</p>
          <p className="text-xs text-muted-foreground">stored in database</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Stock Sync</p>
          <p className="mt-2 text-lg font-bold text-foreground">
            <span className="text-success">{successLogs.length}</span>
            {failedLogs.length > 0 && <span className="text-destructive ml-2">/ {failedLogs.length} ❌</span>}
          </p>
          <p className="text-xs text-muted-foreground">
            {pendingLogs.length > 0 ? `${pendingLogs.length} pending` : "deductions sent"}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Outbound</p>
          <p className="mt-2 text-lg font-bold text-foreground">
            <span className="text-success">{outboundTasks.filter((t: any) => t.status === "SUCCESS").length}</span>
            <span className="text-muted-foreground ml-1">/ {outboundTasks.length}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {outboundTasks.filter((t: any) => t.status === "QUEUED").length} queued
          </p>
        </div>
      </div>

      <Tabs defaultValue="connections" className="space-y-4">
        <TabsList>
          <TabsTrigger value="connections">Connections</TabsTrigger>
          <TabsTrigger value="sales">Sales Events</TabsTrigger>
          <TabsTrigger value="stock">
            Stock Sync
            {failedLogs.length > 0 && (
              <Badge variant="destructive" className="ml-2 text-[10px]">{failedLogs.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="outbound">
            Outbound
            {outboundTasks.filter((t: any) => t.status === "FAILED" || t.status === "BLOCKED").length > 0 && (
              <Badge variant="destructive" className="ml-2 text-[10px]">
                {outboundTasks.filter((t: any) => t.status === "FAILED" || t.status === "BLOCKED").length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Connections Tab */}
        <TabsContent value="connections">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-border bg-card shadow-card overflow-hidden"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Location</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Provider</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Last Sync</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Last Day</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Winerim</th>
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
                    const hasWinerim = !!conn.winerim_api_token;
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
                        <td className="px-4 py-3">
                          {hasWinerim ? (
                            <Badge variant="default" className="text-[10px]">
                              <Wine className="h-3 w-3 mr-1" /> Connected
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">Not configured</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {hasWinerim && conn.last_business_day_synced && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                title="Sync stock to Winerim"
                                onClick={() => syncStockForConnection(conn)}
                                disabled={syncingStock === conn.id}
                              >
                                <ArrowDownToLine className={`h-3.5 w-3.5 ${syncingStock === conn.id ? "animate-bounce" : ""}`} />
                              </Button>
                            )}
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => navigate(`/integrations/${conn.provider}?connection=${conn.id}`)}>
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
        </TabsContent>

        {/* Sales Events Tab */}
        <TabsContent value="sales">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-border bg-card shadow-card overflow-hidden"
          >
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
                  {salesEvents.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No sales events yet</td>
                    </tr>
                  )}
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
        </TabsContent>

        {/* Stock Sync Tab */}
        <TabsContent value="stock">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-border bg-card shadow-card overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Winerim Stock Deductions</h2>
              <div className="flex gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-success" /> {successLogs.length}</span>
                <span className="flex items-center gap-1"><Clock className="h-3 w-3 text-warning" /> {pendingLogs.length}</span>
                <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-destructive" /> {failedLogs.length}</span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Product</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Qty</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Winerim ID</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Error</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {stockLogs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                        <Wine className="mx-auto h-8 w-8 mb-2 opacity-40" />
                        No stock sync logs yet. Sync sales with mapped wines to see deductions here.
                      </td>
                    </tr>
                  )}
                  {stockLogs.map((log) => {
                    const stIcon = log.status === "SUCCESS" ? CheckCircle2
                      : log.status === "FAILED" ? XCircle
                      : Clock;
                    const stClass = log.status === "SUCCESS" ? "text-success"
                      : log.status === "FAILED" ? "text-destructive"
                      : "text-warning";
                    return (
                      <tr key={log.id} className="hover:bg-secondary/30 transition-colors">
                        <td className="px-4 py-3 text-foreground max-w-[200px] truncate" title={log.product_name}>
                          {log.product_name}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-foreground">-{Number(log.quantity)}</td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{log.winerim_product_id || "—"}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            {(() => { const Icon = stIcon; return <Icon className={`h-3.5 w-3.5 ${stClass}`} />; })()}
                            <Badge
                              variant={log.status === "SUCCESS" ? "default" : log.status === "FAILED" ? "destructive" : "outline"}
                              className="text-[10px]"
                            >
                              {log.status}
                            </Badge>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-destructive max-w-[200px] truncate" title={log.error_message || ""}>
                          {log.error_message || "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {log.synced_at ? new Date(log.synced_at).toLocaleString() : new Date(log.created_at).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </motion.div>
        </TabsContent>

        {/* Outbound Tab */}
        <TabsContent value="outbound">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Outbound Tasks (Winerim → POS)</h2>
              <div className="flex gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-success" /> {outboundTasks.filter((t: any) => t.status === "SUCCESS").length}</span>
                <span className="flex items-center gap-1"><Clock className="h-3 w-3 text-warning" /> {outboundTasks.filter((t: any) => t.status === "QUEUED").length}</span>
                <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-destructive" /> {outboundTasks.filter((t: any) => t.status === "FAILED").length}</span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Product</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Attempts</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Error/Reason</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Created</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {outboundTasks.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      <Upload className="mx-auto h-8 w-8 mb-2 opacity-40" /> No outbound tasks yet.
                    </td></tr>
                  )}
                  {outboundTasks.map((t: any) => (
                    <tr key={t.id} className="hover:bg-secondary/30 transition-colors">
                      <td className="px-4 py-3 text-foreground max-w-[200px] truncate">{t.payload_json?.Name || t.task_type}</td>
                      <td className="px-4 py-3">
                        <Badge variant={t.status === "SUCCESS" ? "default" : t.status === "FAILED" ? "destructive" : t.status === "BLOCKED" ? "outline" : "secondary"} className="text-[10px]">
                          {t.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{t.attempts}/{t.max_attempts}</td>
                      <td className="px-4 py-3 text-xs text-destructive max-w-[200px] truncate">{t.last_error || t.blocked_reason || "—"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(t.created_at).toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">
                        {(t.status === "FAILED" || t.status === "BLOCKED") && (
                          <Button variant="ghost" size="icon" className="h-7 w-7"
                            onClick={async () => {
                              await supabase.from("outbound_tasks").update({ status: "QUEUED", last_error: null, blocked_reason: null }).eq("id", t.id);
                              fetchData();
                            }}>
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
