import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type ReviewConnection = {
  id: string;
  location_name: string;
  enabled: boolean;
  catalog_sync_enabled: boolean | null;
  last_sync_at: string | null;
  circuit_breaker_paused_until: string | null;
};

const STORAGE_KEY = "review.connectionId";

/** Read-only list of Agora connections for the global restaurant selector. */
export function useReviewConnections() {
  const [connections, setConnections] = useState<ReviewConnection[]>([]);
  const [connectionId, setConnectionId] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? "",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from("pos_connections")
        .select("id,location_name,enabled,catalog_sync_enabled,last_sync_at,circuit_breaker_paused_until")
        .eq("provider", "agora")
        .order("location_name");
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as ReviewConnection[];
      setConnections(rows);
      setConnectionId((current) => {
        if (current && rows.some((r) => r.id === current)) return current;
        const firstEnabled = rows.find((r) => r.enabled) ?? rows[0];
        return firstEnabled?.id ?? "";
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (connectionId) localStorage.setItem(STORAGE_KEY, connectionId);
  }, [connectionId]);

  const connection = connections.find((c) => c.id === connectionId) ?? null;

  return { connections, connection, connectionId, setConnectionId, loading, error };
}
