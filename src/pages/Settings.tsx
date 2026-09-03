import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Building2,
  MapPin,
  User,
  Shield,
  Clock,
  Wine,
  Save,
  RefreshCw,
  Plug,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface Connection {
  id: string;
  location_name: string;
  provider: string;
  enabled: boolean;
  sync_frequency_minutes: number;
  backfill_days: number;
  winerim_api_token: string | null;
  write_mode: string;
  last_sync_at: string | null;
  created_at: string;
}

export default function SettingsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  // Global settings (stored per-connection but shown aggregated)
  const [globalWinerimToken, setGlobalWinerimToken] = useState("");
  const [defaultSyncFreq, setDefaultSyncFreq] = useState("15");
  const [defaultBackfillDays, setDefaultBackfillDays] = useState("30");

  const fetchData = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("pos_connections")
      .select("id, location_name, provider, enabled, sync_frequency_minutes, backfill_days, winerim_api_token, write_mode, last_sync_at, created_at")
      .order("created_at", { ascending: true });
    const conns = (data || []) as Connection[];
    setConnections(conns);

    // Derive global token from first connection that has one
    const withToken = conns.find((c) => c.winerim_api_token);
    if (withToken) setGlobalWinerimToken(withToken.winerim_api_token || "");

    // Derive default freq from most common
    if (conns.length > 0) {
      setDefaultSyncFreq(String(conns[0].sync_frequency_minutes));
      setDefaultBackfillDays(String(conns[0].backfill_days));
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const toggleConnection = async (id: string, enabled: boolean) => {
    setSaving(id);
    const { error } = await supabase.from("pos_connections").update({ enabled }).eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      setConnections((prev) => prev.map((c) => c.id === id ? { ...c, enabled } : c));
    }
    setSaving(null);
  };

  const saveGlobalSettings = async () => {
    setSaving("global");
    try {
      // Apply token and sync settings to all connections
      const updates = connections.map((c) =>
        supabase.from("pos_connections").update({
          winerim_api_token: globalWinerimToken || null,
          sync_frequency_minutes: parseInt(defaultSyncFreq),
          backfill_days: parseInt(defaultBackfillDays),
        }).eq("id", c.id)
      );
      await Promise.all(updates);
      toast({ title: "Settings saved", description: "Applied to all connections." });
      await fetchData();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Global sync configuration and connection management.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Winerim API Token */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-border bg-card p-6 shadow-card space-y-4"
      >
        <div className="flex items-center gap-3">
          <Wine className="h-5 w-5 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Winerim API Token</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          This token is used to authenticate stock deductions and wine catalog sync with Winerim. Applied to all connections.
        </p>
        <Input
          type="password"
          placeholder="Enter your Winerim API token..."
          value={globalWinerimToken}
          onChange={(e) => setGlobalWinerimToken(e.target.value)}
          className="bg-background font-mono text-xs"
        />
      </motion.div>

      {/* Default Sync Settings */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.06 }}
        className="rounded-xl border border-border bg-card p-6 shadow-card space-y-4"
      >
        <div className="flex items-center gap-3">
          <Settings2 className="h-5 w-5 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Default Sync Settings</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Sync Frequency</label>
            <Select value={defaultSyncFreq} onValueChange={setDefaultSyncFreq}>
              <SelectTrigger className="bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">Every 5 min</SelectItem>
                <SelectItem value="15">Every 15 min</SelectItem>
                <SelectItem value="30">Every 30 min</SelectItem>
                <SelectItem value="60">Every hour</SelectItem>
                <SelectItem value="360">Every 6 hours</SelectItem>
                <SelectItem value="1440">Daily</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Backfill Days</label>
            <Select value={defaultBackfillDays} onValueChange={setDefaultBackfillDays}>
              <SelectTrigger className="bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="14">14 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="60">60 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </motion.div>

      {/* Connections */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12 }}
        className="rounded-xl border border-border bg-card p-6 shadow-card space-y-4"
      >
        <div className="flex items-center gap-3">
          <Plug className="h-5 w-5 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Connections</h2>
          <Badge variant="secondary" className="text-[10px]">{connections.length}</Badge>
        </div>

        {connections.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground py-4 text-center">No connections configured. Go to Integrations to add one.</p>
        )}

        <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {connections.map((conn) => (
            <div key={conn.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{conn.location_name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge variant="secondary" className="text-[10px] uppercase">{conn.provider}</Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {conn.write_mode !== "NONE" ? `Write: ${conn.write_mode}` : "Read-only"}
                    </span>
                    {conn.last_sync_at && (
                      <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                        <Clock className="h-2.5 w-2.5" />
                        {new Date(conn.last_sync_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <Switch
                checked={conn.enabled}
                onCheckedChange={(val) => toggleConnection(conn.id, val)}
                disabled={saving === conn.id}
              />
            </div>
          ))}
        </div>
      </motion.div>

      <div className="flex justify-end">
        <Button onClick={saveGlobalSettings} disabled={saving === "global"}>
          <Save className="mr-2 h-3.5 w-3.5" />
          {saving === "global" ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
