import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Activity, AlertOctagon, CheckCircle2, Clock, RefreshCw, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  connectionId: string;
  /** Auto-refresh interval in ms. Default 15s. Pass 0 to disable. */
  refreshMs?: number;
}

interface Snapshot {
  loading: boolean;
  locationName?: string;
  provider?: string;
  enabled?: boolean;
  lastSyncAt?: string | null;
  pausedUntil?: string | null;
  pausedReason?: string | null;
  consecutiveFailures?: number;
  queued?: number;
  running?: number;
  failed24h?: number;
  blocked?: number;
  lastErrorPreview?: string | null;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function timeUntil(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

export function ConnectionHealthPanel({ connectionId, refreshMs = 15_000 }: Props) {
  const [snap, setSnap] = useState<Snapshot>({ loading: true });

  const load = async () => {
    setSnap((s) => ({ ...s, loading: true }));
    try {
      const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
      const [connRes, queuedRes, runningRes, failedRes, blockedRes, lastFailedRes] = await Promise.all([
        supabase
          .from("pos_connections")
          .select("location_name, provider, enabled, last_sync_at, circuit_breaker_paused_until, circuit_breaker_reason, consecutive_failures")
          .eq("id", connectionId)
          .single(),
        supabase.from("outbound_tasks").select("id", { count: "exact", head: true }).eq("connection_id", connectionId).eq("status", "QUEUED"),
        supabase.from("outbound_tasks").select("id", { count: "exact", head: true }).eq("connection_id", connectionId).eq("status", "RUNNING"),
        supabase.from("outbound_tasks").select("id", { count: "exact", head: true }).eq("connection_id", connectionId).eq("status", "FAILED").gte("updated_at", since24h),
        supabase.from("outbound_tasks").select("id", { count: "exact", head: true }).eq("connection_id", connectionId).eq("status", "BLOCKED"),
        supabase.from("outbound_tasks").select("last_error, updated_at").eq("connection_id", connectionId).eq("status", "FAILED").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const c = connRes.data as any;
      setSnap({
        loading: false,
        locationName: c?.location_name,
        provider: c?.provider,
        enabled: c?.enabled,
        lastSyncAt: c?.last_sync_at,
        pausedUntil: c?.circuit_breaker_paused_until,
        pausedReason: c?.circuit_breaker_reason,
        consecutiveFailures: c?.consecutive_failures ?? 0,
        queued: queuedRes.count ?? 0,
        running: runningRes.count ?? 0,
        failed24h: failedRes.count ?? 0,
        blocked: blockedRes.count ?? 0,
        lastErrorPreview: (lastFailedRes.data as any)?.last_error ?? null,
      });
    } catch (e) {
      console.error("ConnectionHealthPanel load error", e);
      setSnap((s) => ({ ...s, loading: false }));
    }
  };

  useEffect(() => {
    load();
    if (refreshMs > 0) {
      const id = setInterval(load, refreshMs);
      return () => clearInterval(id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, refreshMs]);

  const isPaused = snap.pausedUntil && new Date(snap.pausedUntil).getTime() > Date.now();
  const statusColor = !snap.enabled
    ? "text-muted-foreground"
    : isPaused
      ? "text-destructive"
      : snap.failed24h && snap.failed24h > 5
        ? "text-warning"
        : "text-success";
  const StatusIcon = !snap.enabled ? Clock : isPaused ? AlertOctagon : snap.failed24h && snap.failed24h > 5 ? Activity : CheckCircle2;
  const statusLabel = !snap.enabled
    ? "Disabled"
    : isPaused
      ? "Circuit breaker open"
      : snap.failed24h && snap.failed24h > 5
        ? "Degraded"
        : "Healthy";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border bg-card/40 backdrop-blur-sm p-5"
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <StatusIcon className={`h-5 w-5 ${statusColor}`} />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Connection health</h3>
            <p className="text-xs text-muted-foreground">
              {snap.locationName || "—"} · <span className="uppercase">{snap.provider || ""}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={statusColor}>
            {statusLabel}
          </Badge>
          <Button variant="ghost" size="sm" onClick={load} disabled={snap.loading}>
            <RefreshCw className={`h-3 w-3 ${snap.loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {isPaused && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-destructive mb-1">
            <Zap className="h-3 w-3" />
            Auto-paused for {timeUntil(snap.pausedUntil)}
          </div>
          <p className="text-[11px] text-muted-foreground">{snap.pausedReason || "—"}</p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Last sync" value={timeAgo(snap.lastSyncAt)} />
        <Metric label="Queued" value={String(snap.queued ?? 0)} />
        <Metric label="Running" value={String(snap.running ?? 0)} tone={snap.running && snap.running > 0 ? "info" : "muted"} />
        <Metric label="Failed 24h" value={String(snap.failed24h ?? 0)} tone={snap.failed24h && snap.failed24h > 5 ? "warning" : "muted"} />
        <Metric label="Blocked" value={String(snap.blocked ?? 0)} tone={snap.blocked && snap.blocked > 0 ? "warning" : "muted"} />
        <Metric label="Consecutive fails" value={String(snap.consecutiveFailures ?? 0)} tone={snap.consecutiveFailures && snap.consecutiveFailures > 0 ? "warning" : "muted"} />
      </div>

      {snap.lastErrorPreview && (
        <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Last error</p>
          <p className="text-xs text-foreground/80 font-mono leading-relaxed line-clamp-3">{snap.lastErrorPreview}</p>
        </div>
      )}
    </motion.div>
  );
}

function Metric({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "info" | "warning" | "muted" }) {
  const toneClass =
    tone === "warning" ? "text-warning" :
    tone === "info" ? "text-info" :
    tone === "muted" ? "text-muted-foreground" :
    "text-foreground";
  return (
    <div className="rounded-lg bg-muted/20 p-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}
