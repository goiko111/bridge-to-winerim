import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type ReadinessStatus = "NOT_CONNECTED" | "CONNECTED" | "PARTIAL" | "VERIFIED" | "ERROR";

export interface ProviderReadiness {
  can_read_sales: boolean;
  can_read_catalog: boolean;
  can_write_products: string; // "YES" | "NO" | "UNKNOWN"
  write_mode: string;         // "NONE" | "REST" | "XML_IMPORT" | "CSV" etc.
  webhook_supported: boolean;
  last_verified_at: string | null;
  readiness_status: ReadinessStatus;
  provider: string;
}

const DEFAULT_READINESS: ProviderReadiness = {
  can_read_sales: false,
  can_read_catalog: false,
  can_write_products: "UNKNOWN",
  write_mode: "NONE",
  webhook_supported: false,
  last_verified_at: null,
  readiness_status: "NOT_CONNECTED",
  provider: "",
};

export function useProviderReadiness() {
  const [readiness, setReadiness] = useState<ProviderReadiness>(DEFAULT_READINESS);
  const [loading, setLoading] = useState(false);

  const fetchReadiness = useCallback(async (connectionId: string) => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("provider_capabilities")
        .select("*")
        .eq("connection_id", connectionId)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setReadiness({
          can_read_sales: data.can_read_sales,
          can_read_catalog: data.can_read_catalog,
          can_write_products: data.can_write_products,
          write_mode: (data as any).write_mode ?? "NONE",
          webhook_supported: (data as any).webhook_supported ?? false,
          last_verified_at: (data as any).last_verified_at ?? null,
          readiness_status: (data as any).readiness_status ?? "NOT_CONNECTED",
          provider: data.provider,
        });
      } else {
        setReadiness(DEFAULT_READINESS);
      }
    } catch (e) {
      console.error("Failed to fetch readiness:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const upsertReadiness = useCallback(async (
    connectionId: string,
    provider: string,
    partial: Partial<ProviderReadiness>,
  ) => {
    const row = {
      connection_id: connectionId,
      provider,
      ...partial,
      last_checked_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("provider_capabilities")
      .upsert(row as any, { onConflict: "connection_id" });

    if (error) throw error;

    // Refresh local state
    await fetchReadiness(connectionId);
  }, [fetchReadiness]);

  return { readiness, loading, fetchReadiness, upsertReadiness, DEFAULT_READINESS };
}
