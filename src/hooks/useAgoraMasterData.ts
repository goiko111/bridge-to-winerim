import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface AgoraMasterItem {
  Id: string;
  Name: string;
  [key: string]: string;
}

export interface AgoraMasterData {
  families: AgoraMasterItem[];
  vats: (AgoraMasterItem & { VatRate: string })[];
  priceLists: AgoraMasterItem[];
  preparationTypes: AgoraMasterItem[];
  preparationOrders: AgoraMasterItem[];
  warehouses: AgoraMasterItem[];
  productsSummary: { Id: string; Name: string; FamilyId?: string; VatId?: string }[];
  fetchedAt: string | null;
}

export interface WriteSettings {
  write_mode: string;
  default_family_id: string | null;
  default_vat_id: string | null;
  default_preparation_type_id: string | null;
  default_preparation_order_id: string | null;
  default_warehouse_id: string | null;
  auto_create_families: boolean;
  write_bottle: boolean;
  write_glass: boolean;
  // Auto-push settings
  auto_push_on_create: boolean;
  auto_push_on_update: boolean;
  auto_push_bottle: boolean;
  auto_push_glass: boolean;
  require_manual_review_before_push: boolean;
}

const EMPTY_MASTER: AgoraMasterData = {
  families: [], vats: [], priceLists: [], preparationTypes: [],
  preparationOrders: [], warehouses: [], productsSummary: [], fetchedAt: null,
};

const DEFAULT_WRITE_SETTINGS: WriteSettings = {
  write_mode: "NONE",
  default_family_id: null,
  default_vat_id: null,
  default_preparation_type_id: null,
  default_preparation_order_id: null,
  default_warehouse_id: null,
  auto_create_families: false,
  write_bottle: true,
  write_glass: false,
  auto_push_on_create: false,
  auto_push_on_update: false,
  auto_push_bottle: true,
  auto_push_glass: false,
  require_manual_review_before_push: true,
};

export function useAgoraMasterData(connectionId: string | null) {
  const [masterData, setMasterData] = useState<AgoraMasterData>(EMPTY_MASTER);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [writeSettings, setWriteSettings] = useState<WriteSettings>(DEFAULT_WRITE_SETTINGS);

  // Preview XML
  const [previewXml, setPreviewXml] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // XML Import
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    success: boolean; status: number; responsePreview: string; winesProcessed: number;
  } | null>(null);

  const loadMasterData = useCallback(async () => {
    if (!connectionId) return;
    const { data } = await supabase
      .from("agora_master_data")
      .select("*")
      .eq("connection_id", connectionId)
      .single();
    if (data) {
      setMasterData({
        families: (data as any).families_json || [],
        vats: (data as any).vats_json || [],
        priceLists: (data as any).price_lists_json || [],
        preparationTypes: (data as any).preparation_types_json || [],
        preparationOrders: (data as any).preparation_orders_json || [],
        warehouses: (data as any).warehouses_json || [],
        productsSummary: (data as any).products_summary_json || [],
        fetchedAt: (data as any).fetched_at,
      });
    }
  }, [connectionId]);

  const loadWriteSettings = useCallback(async () => {
    if (!connectionId) return;
    const { data } = await supabase
      .from("pos_connections")
      .select("write_mode, default_family_id, default_vat_id, default_preparation_type_id, default_preparation_order_id, default_warehouse_id, auto_create_families, write_bottle, write_glass, auto_push_on_create, auto_push_on_update, auto_push_bottle, auto_push_glass, require_manual_review_before_push")
      .eq("id", connectionId)
      .single();
    if (data) {
      setWriteSettings(data as unknown as WriteSettings);
    }
  }, [connectionId]);

  const syncMasterData = useCallback(async () => {
    if (!connectionId) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "sync-master-data", connectionId },
      });
      if (error) throw error;
      if (data?.success) {
        setMasterData({
          families: data.masterData?.families || [],
          vats: data.masterData?.vats || [],
          priceLists: data.masterData?.priceLists || [],
          preparationTypes: data.masterData?.preparationTypes || [],
          preparationOrders: data.masterData?.preparationOrders || [],
          warehouses: data.masterData?.warehouses || [],
          productsSummary: [],
          fetchedAt: new Date().toISOString(),
        });
      } else {
        setSyncError(data?.error || "Failed to sync master data");
      }
      return data;
    } catch (e: any) {
      setSyncError(e.message);
    } finally {
      setSyncing(false);
    }
  }, [connectionId]);

  const saveWriteSettings = useCallback(async (settings: Partial<WriteSettings>) => {
    if (!connectionId) return;
    const { error } = await supabase
      .from("pos_connections")
      .update(settings as any)
      .eq("id", connectionId);
    if (!error) {
      setWriteSettings(prev => ({ ...prev, ...settings }));
    }
  }, [connectionId]);

  const previewImportXml = useCallback(async (winerimWineIds: string[]) => {
    if (!connectionId) return;
    setPreviewing(true);
    setPreviewXml(null);
    try {
      const formatTypes = [];
      if (writeSettings.write_bottle) formatTypes.push("BOTTLE");
      if (writeSettings.write_glass) formatTypes.push("GLASS");
      if (formatTypes.length === 0) formatTypes.push("BOTTLE");

      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "preview-xml", connectionId, winerimWineIds, formatTypes },
      });
      if (error) throw error;
      if (data?.success) setPreviewXml(data.xml);
      return data;
    } catch (e: any) {
      console.error("Preview XML failed:", e);
    } finally {
      setPreviewing(false);
    }
  }, [connectionId, writeSettings]);

  const importXml = useCallback(async (winerimWineIds: string[], dryRun = false) => {
    if (!connectionId) return;
    setImporting(true);
    setImportResult(null);
    try {
      const formatTypes = [];
      if (writeSettings.write_bottle) formatTypes.push("BOTTLE");
      if (writeSettings.write_glass) formatTypes.push("GLASS");
      if (formatTypes.length === 0) formatTypes.push("BOTTLE");

      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "xml-import", connectionId, winerimWineIds, formatTypes, dryRun },
      });
      if (error) throw error;
      setImportResult({
        success: data?.success || false,
        status: data?.status || 0,
        responsePreview: data?.responsePreview || "",
        winesProcessed: data?.winesProcessed || 0,
      });
      return data;
    } catch (e: any) {
      console.error("XML import failed:", e);
    } finally {
      setImporting(false);
    }
  }, [connectionId, writeSettings]);

  const queueXmlOutbound = useCallback(async (winerimWineIds: string[]) => {
    if (!connectionId) return;
    const formatTypes = [];
    if (writeSettings.write_bottle) formatTypes.push("BOTTLE");
    if (writeSettings.write_glass) formatTypes.push("GLASS");
    if (formatTypes.length === 0) formatTypes.push("BOTTLE");

    const { data, error } = await supabase.functions.invoke("agora-proxy", {
      body: { action: "queue-xml-outbound", connectionId, winerimWineIds, formatTypes },
    });
    if (error) console.error("Queue XML outbound failed:", error);
    return data;
  }, [connectionId, writeSettings]);

  const processXmlQueue = useCallback(async () => {
    if (!connectionId) return;
    const { data, error } = await supabase.functions.invoke("agora-proxy", {
      body: { action: "process-xml-outbound-queue", connectionId },
    });
    if (error) console.error("Process XML queue failed:", error);
    return data;
  }, [connectionId]);

  return {
    masterData, syncing, syncError,
    loadMasterData, syncMasterData,
    writeSettings, loadWriteSettings, saveWriteSettings,
    previewXml, previewing, previewImportXml,
    importing, importResult, importXml,
    queueXmlOutbound, processXmlQueue,
  };
}
