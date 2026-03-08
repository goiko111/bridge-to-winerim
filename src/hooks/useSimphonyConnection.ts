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

export interface PreflightCheck {
  id: string;
  label: string;
  status: "pending" | "pass" | "fail" | "warn";
  detail?: string;
}

export interface CatalogItem {
  menuItemId: string;
  name: string;
  familyGroup: string;
  price: number;
  active: boolean;
}

export interface CatalogWritePreview {
  action: "create" | "update";
  winerimId: string;
  wineName: string;
  menuItemName: string;
  price: number;
  format: string;
}

export interface PilotStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
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

  // S3: Preflight
  const [preflightChecks, setPreflightChecks] = useState<PreflightCheck[]>([]);
  const [preflightRunning, setPreflightRunning] = useState(false);

  // S5: Catalog
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogWritePreview, setCatalogWritePreview] = useState<CatalogWritePreview[]>([]);
  const [catalogWriteResult, setCatalogWriteResult] = useState<{ created: number; updated: number } | null>(null);
  const [catalogWriting, setCatalogWriting] = useState(false);

  // S7: Pilot
  const [pilotSteps, setPilotSteps] = useState<PilotStep[]>([]);
  const [pilotRunning, setPilotRunning] = useState(false);

  const saveConnection = async (data: {
    locationName: string;
    baseUrl: string;
    apiToken: string;
    winerimApiToken?: string;
    syncMode: string;
    syncFrequency: number;
    backfillDays: number;
    oidcBaseUrl?: string;
    ccBaseUrl?: string;
    clientId?: string;
    clientSecret?: string;
  }) => {
    const providerConfig: Record<string, unknown> = {};
    if (data.oidcBaseUrl) providerConfig.oidc_base_url = data.oidcBaseUrl;
    if (data.ccBaseUrl) providerConfig.cc_base_url = data.ccBaseUrl;
    if (data.clientId) providerConfig.client_id = data.clientId;
    if (data.clientSecret) providerConfig.client_secret = data.clientSecret;

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
        provider_config: Object.keys(providerConfig).length > 0 ? providerConfig : null,
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

  const testConnection = async (baseUrl: string, apiToken: string, locationName: string, winerimApiToken?: string, oidcBaseUrl?: string, ccBaseUrl?: string, clientId?: string, clientSecret?: string) => {
    setTestStatus("testing");
    setTestError(null);
    setMerchantName(null);

    let connId = connectionId;
    if (!connId) {
      try {
        connId = await saveConnection({
          locationName, baseUrl, apiToken, winerimApiToken,
          syncMode: "PULL_ONLY", syncFrequency: 15, backfillDays: 30,
          oidcBaseUrl, ccBaseUrl, clientId, clientSecret,
        });
      } catch (e: any) {
        setTestStatus("error");
        setTestError(e.message);
        return false;
      }
    } else {
      const providerConfig: Record<string, unknown> = {};
      if (oidcBaseUrl) providerConfig.oidc_base_url = oidcBaseUrl;
      if (ccBaseUrl) providerConfig.cc_base_url = ccBaseUrl;
      if (clientId) providerConfig.client_id = clientId;
      if (clientSecret) providerConfig.client_secret = clientSecret;
      await updateConnection(connId, {
        base_url: baseUrl, api_token: apiToken, location_name: locationName,
        winerim_api_token: winerimApiToken || null,
        provider_config: Object.keys(providerConfig).length > 0 ? providerConfig : null,
      });
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

  // S2+S3: Preflight checks
  const runPreflight = useCallback(async () => {
    if (!connectionId) return;
    setPreflightRunning(true);
    setPreflightChecks([
      { id: "sts", label: "STS Gen2 reachable", status: "pending" },
      { id: "rvc74", label: "RVC Option 74 (STS Gen2 enabled)", status: "pending" },
      { id: "oidc", label: "OIDC token valid", status: "pending" },
      { id: "cc", label: "Config & Content API (optional)", status: "pending" },
    ]);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "preflight", connectionId },
      });
      if (error) throw error;
      setPreflightChecks(data?.checks || []);
    } catch (e) {
      console.error("Preflight failed:", e);
    } finally {
      setPreflightRunning(false);
    }
  }, [connectionId]);

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

  // S5: Catalog read
  const fetchCatalog = useCallback(async () => {
    if (!connectionId) return;
    setCatalogLoading(true);
    setCatalogItems([]);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "cc-read-catalog", connectionId },
      });
      if (error) throw error;
      setCatalogItems(data?.items || []);
    } catch (e) { console.error("Catalog fetch failed:", e); }
    finally { setCatalogLoading(false); }
  }, [connectionId]);

  // S5: Catalog write preview
  const previewCatalogWrite = useCallback(async () => {
    if (!connectionId) return;
    setCatalogWritePreview([]);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "cc-write-preview", connectionId },
      });
      if (error) throw error;
      setCatalogWritePreview(data?.preview || []);
    } catch (e) { console.error("Write preview failed:", e); }
  }, [connectionId]);

  // S5: Catalog write execute
  const executeCatalogWrite = useCallback(async (dryRun = true) => {
    if (!connectionId) return;
    setCatalogWriting(true);
    setCatalogWriteResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "cc-write-execute", connectionId, dryRun },
      });
      if (error) throw error;
      setCatalogWriteResult({ created: data?.created || 0, updated: data?.updated || 0 });
    } catch (e) { console.error("Catalog write failed:", e); }
    finally { setCatalogWriting(false); }
  }, [connectionId]);

  // S6: Import/Export bulk
  const generateImportExport = useCallback(async (format: "json" | "csv" = "json") => {
    if (!connectionId) return null;
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "generate-import-export", connectionId, format },
      });
      if (error) throw error;
      return data;
    } catch (e) { console.error("Import/Export generation failed:", e); return null; }
  }, [connectionId]);

  // S7: Pilot flow
  const runPilot = useCallback(async () => {
    if (!connectionId) return;
    setPilotRunning(true);
    setPilotSteps([
      { id: "connect", label: "Connection verified", status: "pending" },
      { id: "master", label: "Read master data", status: "pending" },
      { id: "push-test", label: "Push 1 test menu item", status: "pending" },
      { id: "wait-sales", label: "Awaiting 2 test sales (manual)", status: "pending" },
      { id: "pull-sales", label: "Pull & verify BOT/COPA separation", status: "pending" },
    ]);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "pilot-run", connectionId },
      });
      if (error) throw error;
      setPilotSteps(data?.steps || []);
    } catch (e) { console.error("Pilot failed:", e); }
    finally { setPilotRunning(false); }
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
    // S3: Preflight
    preflightChecks, preflightRunning, runPreflight,
    // S5: Catalog
    catalogItems, catalogLoading, fetchCatalog,
    catalogWritePreview, previewCatalogWrite,
    catalogWriteResult, catalogWriting, executeCatalogWrite,
    // S6: Import/Export
    generateImportExport,
    // S7: Pilot
    pilotSteps, pilotRunning, runPilot,
  };
}
