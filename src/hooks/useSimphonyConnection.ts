import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getSimphonyConfig } from "@/utils/providerConfig";

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
  required?: boolean;
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

import type { PostWriteVerificationResult } from "@/types/postWriteVerification";

/** @deprecated Use PostWriteVerificationResult directly */
export type WriteVerificationResult = PostWriteVerificationResult;

export interface PilotStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
}

export interface DiscoveredLocation {
  locRef: string;
  name: string;
  revenueCenters: { rvcRef: string; name: string }[];
}

export interface WebhookStatus {
  registered: boolean;
  callbackUrl: string;
  lastEventAt: string | null;
  eventCount: number;
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
  const [saveResult, setSaveResult] = useState<{
    savedEvents: number; savedLines: number;
    diagnostics?: {
      business_day: string;
      checks_fetched: number;
      batches_processed: number;
      line_items_saved: number;
      payments_saved: number;
      retries: number;
      duration_ms: number;
      synced_at: string;
      per_rvc?: Record<string, { saved: number; lines: number; wine: number; duplicates_skipped: number; errors: number; last_cursor?: string }>;
    };
  } | null>(null);

  // Preflight
  const [preflightChecks, setPreflightChecks] = useState<PreflightCheck[]>([]);
  const [preflightRunning, setPreflightRunning] = useState(false);

  // Catalog
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogWritePreview, setCatalogWritePreview] = useState<CatalogWritePreview[]>([]);
  const [catalogWriteResult, setCatalogWriteResult] = useState<{ created: number; updated: number } | null>(null);
  const [catalogWriting, setCatalogWriting] = useState(false);
  const [writeVerification, setWriteVerification] = useState<WriteVerificationResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Pilot
  const [pilotSteps, setPilotSteps] = useState<PilotStep[]>([]);
  const [pilotRunning, setPilotRunning] = useState(false);

  // S2: OIDC token acquisition
  const [oidcAcquiring, setOidcAcquiring] = useState(false);
  const [oidcResult, setOidcResult] = useState<{ success: boolean; message: string; expiresAt?: string } | null>(null);

  // S3: Organizations discovery
  const [discoveredLocations, setDiscoveredLocations] = useState<DiscoveredLocation[]>([]);
  const [discovering, setDiscovering] = useState(false);

  // S6: Webhooks
  const [webhookStatus, setWebhookStatus] = useState<WebhookStatus | null>(null);
  const [webhookRegistering, setWebhookRegistering] = useState(false);

  // S9: Multi-RVC
  const [selectedRvcs, setSelectedRvcs] = useState<string[]>([]);

  // RVC diagnostics
  const [rvcDiagnostics, setRvcDiagnostics] = useState<{
    singleRvc: boolean;
    rvcCount?: number;
    diagnostics?: {
      rvc: string; reachable: boolean; status: number | null;
      sampleChecks: number;
      cursor: { last_business_day: string | null; synced_at: string | null; last_cursor: string | null };
      error?: string;
      savedEvents?: number;
    }[];
    globalCursor?: string | null;
    lastSync?: Record<string, unknown> | null;
  } | null>(null);
  const [rvcDiagLoading, setRvcDiagLoading] = useState(false);

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
    selectedRvcs?: string[];
  }) => {
    const providerConfig: Record<string, unknown> = {};
    if (data.oidcBaseUrl) providerConfig.oidc_base_url = data.oidcBaseUrl;
    if (data.ccBaseUrl) providerConfig.cc_base_url = data.ccBaseUrl;
    if (data.clientId) providerConfig.client_id = data.clientId;
    if (data.clientSecret) providerConfig.client_secret = data.clientSecret;
    if (data.selectedRvcs && data.selectedRvcs.length > 0) providerConfig.selected_rvcs = data.selectedRvcs;

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
          selectedRvcs: selectedRvcs.length > 0 ? selectedRvcs : undefined,
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
      if (selectedRvcs.length > 0) providerConfig.selected_rvcs = selectedRvcs;
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

  // S2: Acquire OIDC token via client_credentials
  const acquireOidcToken = useCallback(async () => {
    if (!connectionId) return;
    setOidcAcquiring(true);
    setOidcResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "oidc-acquire", connectionId },
      });
      if (error) throw error;
      setOidcResult(data);
    } catch (e: any) {
      setOidcResult({ success: false, message: e.message });
    } finally {
      setOidcAcquiring(false);
    }
  }, [connectionId]);

  // S3: Discover organizations/locations/RVCs
  const discoverLocations = useCallback(async () => {
    if (!connectionId) return;
    setDiscovering(true);
    setDiscoveredLocations([]);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "discover-locations", connectionId },
      });
      if (error) throw error;
      const locs = data?.locations || [];
      setDiscoveredLocations(locs);
    } catch (e: any) {
      console.error("Discovery failed:", e);
    } finally {
      setDiscovering(false);
    }
  }, [connectionId]);

  // Persist selected location + RVCs to provider_config
  const saveDiscoverySelection = useCallback(async (
    selectedLocRef: string,
    selectedLocName: string,
    rvcs: string[],
    allDiscovered: DiscoveredLocation[],
  ) => {
    if (!connectionId) return;
    // Read current config, merge in discovery data
    const { data: conn } = await supabase.from("pos_connections").select("provider_config").eq("id", connectionId).single();
    const cfg = getSimphonyConfig(conn?.provider_config);
    const discoveredForJson = allDiscovered.map((loc) => ({
      locRef: loc.locRef,
      name: loc.name,
      revenueCenters: loc.revenueCenters.map((rvc) => ({ rvcRef: rvc.rvcRef, name: rvc.name })),
    }));
    const updatedCfg = {
      ...cfg,
      selected_rvcs: rvcs,
      discovered_locations: discoveredForJson,
      selected_location_ref: selectedLocRef,
      selected_location_name: selectedLocName,
      discovery_completed_at: new Date().toISOString(),
    };
    await supabase.from("pos_connections").update({
      provider_config: updatedCfg as any,
    }).eq("id", connectionId);
  }, [connectionId]);

  // Preflight
  const runPreflight = useCallback(async () => {
    if (!connectionId) return;
    setPreflightRunning(true);
    setPreflightChecks([
      { id: "base_urls", label: "Required base URLs & refs", status: "pending", required: true },
      { id: "sts", label: "STS Gen2 connectivity", status: "pending", required: true },
      { id: "oidc", label: "OIDC authentication", status: "pending", required: true },
      { id: "locations", label: "Locations discovered", status: "pending", required: true },
      { id: "rvc", label: "Revenue Center (RVC) discovered", status: "pending", required: true },
      { id: "rvc74", label: "Option 74 (Enable STS Gen2)", status: "pending", required: true },
      { id: "workstation", label: "POS API Client workstation", status: "pending", required: true },
      { id: "cc", label: "Config & Content API", status: "pending", required: false },
      { id: "notifications", label: "Notifications API", status: "pending", required: false },
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
      setSaveResult({
        savedEvents: data?.savedEvents || 0,
        savedLines: data?.savedLines || 0,
        diagnostics: data?.diagnostics || undefined,
      });
    } catch (e) { console.error("Failed to save sales:", e); }
    finally { setSaving(false); }
  }, [connectionId]);

  // Catalog
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

  const verifyWrite = useCallback(async (params: { externalId?: string; winerim_id?: string; format?: string; expectedPrice?: number; verifyMode?: "ccapi" | "import" | "auto" }) => {
    if (!connectionId) return null;
    setVerifying(true);
    setWriteVerification(null);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "verify-write", connectionId, ...params },
      });
      if (error) throw error;
      setWriteVerification(data);
      return data;
    } catch (e: any) {
      const failResult: WriteVerificationResult = {
        success: false, verified_exists: false, verified_prices: false, verified_scope: false,
        errors: [{ code: "VERIFY_CALL_FAILED", message: e.message }], warnings: [],
      };
      setWriteVerification(failResult);
      return failResult;
    } finally {
      setVerifying(false);
    }
  }, [connectionId]);

  // S6: Register webhook
  const registerWebhook = useCallback(async () => {
    if (!connectionId) return;
    setWebhookRegistering(true);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "register-webhook", connectionId },
      });
      if (error) throw error;
      setWebhookStatus(data?.webhookStatus || null);
    } catch (e) { console.error("Webhook registration failed:", e); }
    finally { setWebhookRegistering(false); }
  }, [connectionId]);

  const fetchWebhookStatus = useCallback(async () => {
    if (!connectionId) return;
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "webhook-status", connectionId },
      });
      if (error) throw error;
      setWebhookStatus(data?.webhookStatus || null);
    } catch (e) { console.error("Webhook status failed:", e); }
  }, [connectionId]);

  // RVC diagnostics
  const fetchRvcDiagnostics = useCallback(async () => {
    if (!connectionId) return;
    setRvcDiagLoading(true);
    setRvcDiagnostics(null);
    try {
      const { data, error } = await supabase.functions.invoke("simphony-proxy", {
        body: { action: "rvc-diagnostics", connectionId },
      });
      if (error) throw error;
      setRvcDiagnostics(data);
    } catch (e) { console.error("RVC diagnostics failed:", e); }
    finally { setRvcDiagLoading(false); }
  }, [connectionId]);

  // Pilot
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
    const cfg = getSimphonyConfig(data.provider_config);
    if (cfg.selected_rvcs) setSelectedRvcs(cfg.selected_rvcs);
    // Restore discovered locations from persisted config
    if ((cfg as any).discovered_locations) {
      setDiscoveredLocations((cfg as any).discovered_locations);
    }
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
    // Preflight
    preflightChecks, preflightRunning, runPreflight,
    // Catalog
    catalogItems, catalogLoading, fetchCatalog,
    catalogWritePreview, previewCatalogWrite,
    catalogWriteResult, catalogWriting, executeCatalogWrite,
    // Post-write verification
    writeVerification, verifying, verifyWrite,
    // Import/Export
    generateImportExport,
    // Pilot
    pilotSteps, pilotRunning, runPilot,
    // S2: OIDC
    oidcAcquiring, oidcResult, acquireOidcToken,
    // S3: Discovery
    discoveredLocations, discovering, discoverLocations, saveDiscoverySelection,
    // S6: Webhooks
    webhookStatus, webhookRegistering, registerWebhook, fetchWebhookStatus,
    // S9: Multi-RVC
    selectedRvcs, setSelectedRvcs,
    // RVC diagnostics
    rvcDiagnostics, rvcDiagLoading, fetchRvcDiagnostics,
  };
}
