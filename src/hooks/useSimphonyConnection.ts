import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface SalesLineItem {
  provider_product_id: string;
  name: string;
  format: string;
  family: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  vat_rate: number;
  is_wine_candidate: boolean;
  wine_score?: number;
  wine_reasons?: string[];
}

export interface SalesEvent {
  provider_doc_id: string;
  business_day: string;
  doc_type: string;
  total_amount: number;
  total_tax: number;
  total_net: number;
  line_count: number;
  lines: SalesLineItem[];
}

export interface DetectedFamily {
  name: string;
  suggestedWine: boolean;
  confidence: "high" | "medium" | "low";
  itemCount: number;
}

export function useSimphonyConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [merchantName, setMerchantName] = useState<string | null>(null);

  const [daysWithSales, setDaysWithSales] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [loadingDays, setLoadingDays] = useState(false);
  const [scanStats, setScanStats] = useState<{ totalScanned: number; totalInvoicesFound: number } | null>(null);

  const [salesEvents, setSalesEvents] = useState<SalesEvent[]>([]);
  const [detectedFamilies, setDetectedFamilies] = useState<DetectedFamily[]>([]);
  const [loadingSales, setLoadingSales] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ savedEvents: number; savedLines: number } | null>(null);

  // Simphony stores location_name as "Label|orgShortName|locRef|rvcRef"
  const saveConnection = async (data: {
    locationName: string; // "Label|org|loc|rvc"
    baseUrl: string;
    apiToken: string;
    winerimApiToken?: string;
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
        winerim_api_token: data.winerimApiToken || null,
        provider: "simphony",
        sync_mode: data.syncMode,
        sync_frequency_minutes: data.syncFrequency,
        backfill_days: data.backfillDays,
      } as any)
      .select()
      .single();

    if (error) throw error;
    setConnectionId(row.id);
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase.from("pos_connections").update(data).eq("id", id);
    if (error) throw error;
  };

  const testConnection = async (baseUrl: string, apiToken: string, locationName: string, winerimApiToken?: string) => {
    setTestStatus("testing");
    setTestError(null);
    setMerchantName(null);

    let connId = connectionId;
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName, baseUrl, apiToken, winerimApiToken,
          syncMode: "PULL_ONLY", syncFrequency: 15, backfillDays: 30,
        });
      } catch (e: any) {
        setTestStatus("error");
        setTestError(e.message);
        return false;
      }
    } else {
      await updateConnection(connId, { base_url: baseUrl, api_token: apiToken, location_name: locationName, winerim_api_token: winerimApiToken || null });
    }

    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "test", connectionId: connId },
      });
      if (error) { setTestStatus("error"); setTestError(error.message); return false; }
      if (data?.success) {
        setTestStatus("success");
        setMerchantName(data.merchantName || null);
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

  const findDaysWithSales = useCallback(async (daysBack = 60) => {
    if (!connectionId) return;
    setLoadingDays(true);
    setScanStats(null);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "find-last-business-day", connectionId, daysBack },
      });
      if (error) throw error;
      const days: string[] = data?.daysWithSales || [];
      setDaysWithSales(days);
      setScanStats({ totalScanned: data?.totalScanned || 0, totalInvoicesFound: data?.totalInvoicesFound || 0 });
      if (days.length > 0 && !selectedDay) setSelectedDay(days[0]);
    } catch (e) { console.error("Failed to find business days:", e); }
    finally { setLoadingDays(false); }
  }, [connectionId, selectedDay]);

  const fetchSalesForDay = useCallback(async (day: string) => {
    if (!connectionId) return;
    setLoadingSales(true);
    setSalesEvents([]);
    setDetectedFamilies([]);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "fetch-day", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSalesEvents(data?.salesEvents || []);
      setDetectedFamilies(data?.detectedFamilies || []);
    } catch (e) { console.error("Failed to fetch sales:", e); }
    finally { setLoadingSales(false); }
  }, [connectionId]);

  const saveSalesToDb = useCallback(async (day: string) => {
    if (!connectionId) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "save-sales", connectionId, businessDay: day },
      });
      if (error) throw error;
      setSaveResult({ savedEvents: data?.savedEvents || 0, savedLines: data?.savedLines || 0 });
    } catch (e) { console.error("Failed to save sales:", e); }
    finally { setSaving(false); }
  }, [connectionId]);

  const enableSync = async () => {
    if (!connectionId) return;
    await updateConnection(connectionId, { enabled: true });
  };

  const saveFamilyRules = useCallback(async (families: { name: string; isWine: boolean }[]) => {
    if (!connectionId) return;
    for (const f of families) {
      await supabase.from("wine_family_rules").upsert(
        { connection_id: connectionId, family_name: f.name, is_wine: f.isWine },
        { onConflict: "connection_id,family_name" }
      );
    }
  }, [connectionId]);

  const loadConnection = useCallback(async (id: string) => {
    const { data, error } = await supabase.from("pos_connections").select("*").eq("id", id).single();
    if (error || !data) return null;
    setConnectionId(data.id);
    return data;
  }, []);

  return {
    connectionId, setConnectionId,
    testStatus, testError, merchantName,
    testConnection, saveConnection, updateConnection, loadConnection,
    daysWithSales, selectedDay, setSelectedDay, loadingDays, findDaysWithSales, scanStats,
    salesEvents, detectedFamilies, loadingSales, fetchSalesForDay,
    saving, saveResult, saveSalesToDb,
    enableSync, saveFamilyRules,
  };
}
