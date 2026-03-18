import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Search, RefreshCw, Loader2, CheckCircle2, Wine, ChevronDown, ChevronUp,
  AlertTriangle, Eye,
} from "lucide-react";

interface PushTrackingRow {
  winerim_wine_id: string;
  format: string;
  sync_status: string;
  agora_product_id: string | null;
  agora_family_id: string | null;
  last_error: string | null;
  pushed_at: string | null;
  verified_at: string | null;
}

interface WineWithTracking extends PushTrackingRow {
  wine_name: string;
  family_name: string | null;
}

export default function AgoraWinesInPosPanel({ connectionId, families }: { connectionId: string | null; families?: { Id: string; Name: string }[] }) {
  const [rows, setRows] = useState<WineWithTracking[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    try {
      const { data: tracking } = await supabase
        .from("winerim_push_tracking")
        .select("winerim_wine_id, format, sync_status, agora_product_id, agora_family_id, last_error, pushed_at, verified_at")
        .eq("connection_id", connectionId)
        .in("sync_status", ["PUSHED", "VERIFIED", "QUEUED", "FAILED"]);

      if (!tracking || tracking.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }

      const wineIds = [...new Set((tracking as PushTrackingRow[]).map(t => t.winerim_wine_id))];
      const { data: wines } = await supabase
        .from("winerim_wines")
        .select("winerim_id, name")
        .eq("connection_id", connectionId)
        .in("winerim_id", wineIds);

      const nameMap: Record<string, string> = {};
      (wines || []).forEach((w: any) => { nameMap[w.winerim_id] = w.name; });

      const familyMap: Record<string, string> = {};
      if (families) {
        for (const f of families) { familyMap[f.Id] = f.Name; }
      }

      setRows(
        (tracking as PushTrackingRow[]).map(t => ({
          ...t,
          wine_name: nameMap[t.winerim_wine_id] || t.winerim_wine_id,
          family_name: t.agora_family_id ? (familyMap[t.agora_family_id] || t.agora_family_id) : null,
        }))
      );
    } catch (e) {
      console.error("Failed to load push tracking:", e);
    } finally {
      setLoading(false);
    }
  }, [connectionId, families]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(r => r.wine_name.toLowerCase().includes(q) || (r.agora_product_id || "").toLowerCase().includes(q));
  }, [rows, search]);

  const stats = useMemo(() => ({
    pushed: rows.filter(r => r.sync_status === "PUSHED").length,
    verified: rows.filter(r => r.sync_status === "VERIFIED").length,
    queued: rows.filter(r => r.sync_status === "QUEUED").length,
    failed: rows.filter(r => r.sync_status === "FAILED").length,
  }), [rows]);

  const total = rows.length;

  if (total === 0 && !loading) return null;

  const statusBadge = (status: string) => {
    switch (status) {
      case "VERIFIED": return <Badge variant="default" className="text-[10px] bg-emerald-600"><CheckCircle2 className="h-3 w-3 mr-0.5" />Verified</Badge>;
      case "PUSHED": return <Badge variant="default" className="text-[10px]">Pushed</Badge>;
      case "QUEUED": return <Badge variant="secondary" className="text-[10px]">Queued</Badge>;
      case "FAILED": return <Badge variant="destructive" className="text-[10px]"><AlertTriangle className="h-3 w-3 mr-0.5" />Failed</Badge>;
      default: return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Wine className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Vinos en Ágora</span>
          <Badge variant="outline" className="text-[10px]">{total}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {stats.verified > 0 && <Badge variant="default" className="text-[10px] bg-emerald-600">{stats.verified} verified</Badge>}
          {stats.pushed > 0 && <Badge variant="default" className="text-[10px]">{stats.pushed} pushed</Badge>}
          {stats.failed > 0 && <Badge variant="destructive" className="text-[10px]">{stats.failed} failed</Badge>}
          {stats.queued > 0 && <Badge variant="secondary" className="text-[10px]">{stats.queued} queued</Badge>}
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          <div className="flex gap-2 items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Buscar vino o ID Agora…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10 bg-background text-sm h-8" />
            </div>
            <Button variant="ghost" size="sm" onClick={load} disabled={loading} className="h-8">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border overflow-hidden max-h-80 overflow-y-auto">
              {filtered.map((r, i) => (
                <div key={`${r.winerim_wine_id}-${r.format}-${i}`} className="px-3 py-2 bg-card hover:bg-secondary/20 transition-colors">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground truncate">{r.wine_name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className="text-[10px]">{r.format}</Badge>
                        {r.agora_product_id && (
                          <span className="text-[10px] font-mono text-muted-foreground">ID: {r.agora_product_id}</span>
                        )}
                        {r.pushed_at && (
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(r.pushed_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                    {statusBadge(r.sync_status)}
                  </div>
                  {r.last_error && (
                    <p className="text-[10px] text-destructive mt-1 truncate">{r.last_error}</p>
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="px-3 py-4 text-center text-sm text-muted-foreground">No se encontraron vinos.</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
