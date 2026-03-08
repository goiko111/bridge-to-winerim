import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type HioposIntegrationMode = "FILES" | "PORTALREST_ORDERS_API";
export type HioposIngestionMode = "MANUAL_UPLOAD" | "SFTP_PULL";

export interface HioposSalesImportResult {
  success: boolean;
  totalEvents: number;
  totalLines: number;
  duplicatesSkipped: number;
  rowsFailed?: number;
  failReasons?: string[];
  message: string;
}

export interface HioposCatalogImportResult {
  success: boolean;
  totalProducts: number;
  inserted: number;
  updated: number;
  message: string;
}

export interface HioposExportResult {
  success: boolean;
  totalWines: number;
  downloadUrl: string;
  format: "csv" | "xml";
  message: string;
}

export interface SftpPullStatus {
  lastFilePulled: string | null;
  lastSuccessfulImport: string | null;
  failures: number;
  lastError: string | null;
}

export interface PortalRestDiscoveryResult {
  success: boolean;
  endpoints: { path: string; status: number; snippet: string }[];
  message: string;
}

export interface PricingDiagnostics {
  total: number;
  ready: number;
  missing: number;
  bottleCoverage: number;
  glassCoverage: number;
  magnumCoverage: number;
}

export function useHioposConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  // Sales import
  const [salesImporting, setSalesImporting] = useState(false);
  const [salesImportResult, setSalesImportResult] = useState<HioposSalesImportResult | null>(null);
  const [lastImportedFile, setLastImportedFile] = useState<string | null>(null);

  // Catalog import
  const [catalogImporting, setCatalogImporting] = useState(false);
  const [catalogImportResult, setCatalogImportResult] = useState<HioposCatalogImportResult | null>(null);

  // Export / write
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<HioposExportResult | null>(null);

  // HiOffice
  const [hiofficeMode, setHiofficeMode] = useState(false);
  const [bundleStatus, setBundleStatus] = useState<"idle" | "generating" | "ready" | "sent">("idle");

  // SFTP pull status
  const [sftpPullStatus, setSftpPullStatus] = useState<SftpPullStatus | null>(null);
  const [sftpPulling, setSftpPulling] = useState(false);

  // PortalRest
  const [portalRestDiscovery, setPortalRestDiscovery] = useState<PortalRestDiscoveryResult | null>(null);
  const [portalRestDiscovering, setPortalRestDiscovering] = useState(false);
  const [portalRestSalesResult, setPortalRestSalesResult] = useState<HioposSalesImportResult | null>(null);
  const [portalRestFetching, setPortalRestFetching] = useState(false);

  // Pricing diagnostics
  const [pricingDiagnostics, setPricingDiagnostics] = useState<PricingDiagnostics | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);

  const saveConnection = async (data: {
    locationName: string;
    integrationMode: HioposIntegrationMode;
    ingestionMode: HioposIngestionMode;
    storeId?: string;
    timezone: string;
    businessDayCloseHour?: number;
    sftpHost?: string;
    sftpPort?: string;
    sftpUser?: string;
    sftpPassword?: string;
    sftpPath?: string;
    useHioffice?: boolean;
    portalrestBaseUrl?: string;
    portalrestAccountId?: string;
    portalrestLocationId?: string;
    portalrestApiKey?: string;
    portalrestApiSecret?: string;
  }) => {
    const providerConfig: Record<string, unknown> = {
      integration_mode: data.integrationMode === "PORTALREST_ORDERS_API" ? "PORTALREST_ORDERS_API" : "EXPORT_FILES",
      ingestion_mode: data.ingestionMode,
      store_id: data.storeId || null,
      timezone: data.timezone,
      business_day_close_hour: data.businessDayCloseHour ?? 6,
      use_hioffice: data.useHioffice || false,
    };

    if (data.ingestionMode === "SFTP_PULL") {
      providerConfig.sftp = {
        host: data.sftpHost,
        port: data.sftpPort || "22",
        user: data.sftpUser,
        password: data.sftpPassword,
        path: data.sftpPath || "/",
      };
    }

    if (data.integrationMode === "PORTALREST_ORDERS_API") {
      providerConfig.portalrest = {
        base_url: data.portalrestBaseUrl,
        account_id: data.portalrestAccountId,
        location_id: data.portalrestLocationId,
        api_key: data.portalrestApiKey,
        api_secret: data.portalrestApiSecret,
      };
    }

    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName,
        base_url: data.integrationMode === "PORTALREST_ORDERS_API" ? (data.portalrestBaseUrl || "file://local") : "file://local",
        api_token: data.portalrestApiKey || "none",
        provider: "hiopos",
        sync_mode: data.integrationMode === "PORTALREST_ORDERS_API" ? "PULL_ONLY" : "PULL_ONLY",
        sync_frequency_minutes: data.ingestionMode === "SFTP_PULL" ? 60 : 0,
        backfill_days: 30,
        provider_config: providerConfig,
      } as any)
      .select()
      .single();

    if (error) throw error;
    setConnectionId(row.id);

    await supabase.from("provider_capabilities").insert({
      connection_id: row.id,
      provider: "HIOPOS",
      can_read_sales: true,
      can_read_catalog: true,
      can_write_products: "NO",
    } as any);

    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase.from("pos_connections").update(data).eq("id", id);
    if (error) throw error;
  };

  const loadExistingConnection = useCallback(async () => {
    const { data, error } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("provider", "hiopos")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    setConnectionId(data.id);
    const cfg = data.provider_config as any;
    if (cfg?.use_hioffice) setHiofficeMode(true);
    return data;
  }, []);

  const testConnection = async () => {
    setTestStatus("testing");
    setTestError(null);
    if (!connectionId) {
      setTestStatus("error");
      setTestError("No connection saved yet");
      return false;
    }
    try {
      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: { action: "test", connectionId },
      });
      if (error) throw error;
      if (data?.success) { setTestStatus("success"); return true; }
      setTestStatus("error");
      setTestError(data?.message || "Validation failed");
      return false;
    } catch (e: any) {
      setTestStatus("error");
      setTestError(e.message);
      return false;
    }
  };

  // ── Sales import (file) ──
  const uploadSalesFile = useCallback(async (file: File, dateFrom?: string, dateTo?: string, store?: string, register?: string) => {
    if (!connectionId) return;
    setSalesImporting(true);
    setSalesImportResult(null);
    try {
      const filePath = `${connectionId}/sales/${Date.now()}_${file.name}`;
      const { error: uploadErr } = await supabase.storage.from("hiopos-imports").upload(filePath, file);
      if (uploadErr) throw uploadErr;

      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: { action: "import-sales", connectionId, filePath, fileName: file.name, dateFrom, dateTo, store, register },
      });
      if (error) throw error;
      setSalesImportResult(data);
      setLastImportedFile(file.name);
    } catch (e: any) {
      setSalesImportResult({ success: false, totalEvents: 0, totalLines: 0, duplicatesSkipped: 0, message: e.message });
    } finally {
      setSalesImporting(false);
    }
  }, [connectionId]);

  // ── Catalog import ──
  const uploadCatalogFile = useCallback(async (file: File) => {
    if (!connectionId) return;
    setCatalogImporting(true);
    setCatalogImportResult(null);
    try {
      const filePath = `${connectionId}/catalog/${Date.now()}_${file.name}`;
      const { error: uploadErr } = await supabase.storage.from("hiopos-imports").upload(filePath, file);
      if (uploadErr) throw uploadErr;

      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: { action: "import-catalog", connectionId, filePath, fileName: file.name },
      });
      if (error) throw error;
      setCatalogImportResult(data);
    } catch (e: any) {
      setCatalogImportResult({ success: false, totalProducts: 0, inserted: 0, updated: 0, message: e.message });
    } finally {
      setCatalogImporting(false);
    }
  }, [connectionId]);

  // ── Export / write file generator ──
  const generateImportFile = useCallback(async (format: "csv" | "xml" = "csv", useHioffice = false) => {
    if (!connectionId) return;
    setExporting(true);
    setExportResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: { action: "generate-import-file", connectionId, format, useHioffice },
      });
      if (error) throw error;
      setExportResult(data);
      if (useHioffice) setBundleStatus("ready");
    } catch (e: any) {
      setExportResult({ success: false, totalWines: 0, downloadUrl: "", format, message: e.message });
    } finally {
      setExporting(false);
    }
  }, [connectionId]);

  const markBundleSent = useCallback(() => setBundleStatus("sent"), []);

  // ── SFTP Pull (trigger manual pull for SFTP_PULL connections) ──
  const triggerSftpPull = useCallback(async () => {
    if (!connectionId) return;
    setSftpPulling(true);
    try {
      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: { action: "sftp-pull", connectionId },
      });
      if (error) throw error;
      setSftpPullStatus(data?.pullStatus || null);
      if (data?.importResult) setSalesImportResult(data.importResult);
    } catch (e: any) {
      setSftpPullStatus({ lastFilePulled: null, lastSuccessfulImport: null, failures: 1, lastError: e.message });
    } finally {
      setSftpPulling(false);
    }
  }, [connectionId]);

  // ── PortalRest API discovery ──
  const discoverPortalRestEndpoints = useCallback(async () => {
    if (!connectionId) return;
    setPortalRestDiscovering(true);
    setPortalRestDiscovery(null);
    try {
      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: { action: "portalrest-discover", connectionId },
      });
      if (error) throw error;
      setPortalRestDiscovery(data);
    } catch (e: any) {
      setPortalRestDiscovery({ success: false, endpoints: [], message: e.message });
    } finally {
      setPortalRestDiscovering(false);
    }
  }, [connectionId]);

  // ── PortalRest API fetch sales ──
  const fetchPortalRestSales = useCallback(async (hoursBack = 24) => {
    if (!connectionId) return;
    setPortalRestFetching(true);
    setPortalRestSalesResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("hiopos-proxy", {
        body: { action: "portalrest-fetch-sales", connectionId, hoursBack },
      });
      if (error) throw error;
      setPortalRestSalesResult(data);
    } catch (e: any) {
      setPortalRestSalesResult({ success: false, totalEvents: 0, totalLines: 0, duplicatesSkipped: 0, message: e.message });
    } finally {
      setPortalRestFetching(false);
    }
  }, [connectionId]);

  // ── Pricing diagnostics ──
  const loadPricingDiagnostics = useCallback(async () => {
    if (!connectionId) return;
    setPricingLoading(true);
    try {
      const { data: wines, error } = await supabase
        .from("winerim_wines")
        .select("pricing_status, bottle_sale_price, glass_sale_price, magnum_sale_price")
        .eq("connection_id", connectionId)
        .eq("is_active", true);
      if (error) throw error;
      if (!wines) { setPricingDiagnostics(null); return; }
      const total = wines.length;
      const ready = wines.filter(w => w.pricing_status === "READY").length;
      const missing = total - ready;
      const bottleCoverage = total > 0 ? Math.round((wines.filter(w => w.bottle_sale_price && w.bottle_sale_price > 0).length / total) * 100) : 0;
      const glassCoverage = total > 0 ? Math.round((wines.filter(w => w.glass_sale_price && w.glass_sale_price > 0).length / total) * 100) : 0;
      const magnumCoverage = total > 0 ? Math.round((wines.filter(w => w.magnum_sale_price && w.magnum_sale_price > 0).length / total) * 100) : 0;
      setPricingDiagnostics({ total, ready, missing, bottleCoverage, glassCoverage, magnumCoverage });
    } catch (e: any) {
      console.error("Pricing diagnostics error:", e);
    } finally {
      setPricingLoading(false);
    }
  }, [connectionId]);

  const enableSync = async () => {
    if (!connectionId) return;
    await updateConnection(connectionId, { enabled: true });
  };

  return {
    connectionId, setConnectionId,
    testStatus, testError, testConnection,
    saveConnection, updateConnection, loadExistingConnection,
    // Sales
    salesImporting, salesImportResult, lastImportedFile, uploadSalesFile,
    // Catalog
    catalogImporting, catalogImportResult, uploadCatalogFile,
    // Export
    exporting, exportResult, generateImportFile,
    // HiOffice
    hiofficeMode, setHiofficeMode, bundleStatus, setBundleStatus, markBundleSent,
    // SFTP
    sftpPullStatus, sftpPulling, triggerSftpPull,
    // PortalRest
    portalRestDiscovery, portalRestDiscovering, discoverPortalRestEndpoints,
    portalRestSalesResult, portalRestFetching, fetchPortalRestSales,
    // Pricing
    pricingDiagnostics, pricingLoading, loadPricingDiagnostics,
    enableSync,
  };
}
