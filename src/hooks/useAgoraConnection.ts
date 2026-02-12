import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface AgoraProduct {
  id: string;
  name: string;
  mapped: boolean;
  winerimId: string | null;
  confidence: number;
}

export function useAgoraConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [products, setProducts] = useState<AgoraProduct[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);

  const saveConnection = async (data: {
    locationName: string;
    baseUrl: string;
    apiToken: string;
    syncMode: string;
    syncFrequency: number;
    backfillDays: number;
  }) => {
    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName,
        base_url: data.baseUrl,
        api_token: data.apiToken,
        sync_mode: data.syncMode,
        sync_frequency_minutes: data.syncFrequency,
        backfill_days: data.backfillDays,
      })
      .select()
      .single();

    if (error) throw error;
    setConnectionId(row.id);
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase
      .from("pos_connections")
      .update(data)
      .eq("id", id);
    if (error) throw error;
  };

  const testConnection = async (baseUrl: string, apiToken: string) => {
    setTestStatus("testing");
    setTestError(null);

    // First save or update the connection so the edge function can read it
    let connId = connectionId;
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName: "New Location",
          baseUrl,
          apiToken,
          syncMode: "PULL_ONLY",
          syncFrequency: 15,
          backfillDays: 30,
        });
      } catch (e: any) {
        setTestStatus("error");
        setTestError(e.message);
        return false;
      }
    } else {
      await updateConnection(connId, { base_url: baseUrl, api_token: apiToken });
    }

    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "test", connectionId: connId },
      });

      if (error) {
        setTestStatus("error");
        setTestError(error.message);
        return false;
      }

      if (data?.success) {
        setTestStatus("success");
        return true;
      } else {
        setTestStatus("error");
        setTestError(data?.message || "Connection failed");
        return false;
      }
    } catch (e: any) {
      setTestStatus("error");
      setTestError(e.message);
      return false;
    }
  };

  const fetchProducts = async () => {
    if (!connectionId) return;
    setLoadingProducts(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "products", connectionId },
      });

      if (error) throw error;

      // Map Agora products to our format (all unmapped by default)
      const mapped: AgoraProduct[] = (data?.products || []).map((p: any, i: number) => ({
        id: p.id || `P${String(i + 1).padStart(3, "0")}`,
        name: p.name || p.description || `Product ${i + 1}`,
        mapped: false,
        winerimId: null,
        confidence: 0,
      }));

      setProducts(mapped);
    } catch (e) {
      console.error("Failed to fetch products:", e);
    } finally {
      setLoadingProducts(false);
    }
  };

  const enableSync = async () => {
    if (!connectionId) return;
    await updateConnection(connectionId, { enabled: true });
  };

  return {
    connectionId,
    testStatus,
    testError,
    testConnection,
    saveConnection,
    updateConnection,
    products,
    loadingProducts,
    fetchProducts,
    enableSync,
  };
}
