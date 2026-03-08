import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ProviderCapability {
  connection_id: string;
  can_read_sales: boolean;
  can_read_catalog: boolean;
  can_write_products: "UNKNOWN" | "YES" | "NO";
  write_endpoint: string | null;
  write_endpoints_json: unknown;
  last_checked_at: string | null;
}

export interface OutboundTask {
  id: string;
  connection_id: string;
  task_type: string;
  payload_json: Record<string, unknown>;
  status: "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "BLOCKED";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  external_id: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function useOutboundSync(connectionId: string | null) {
  const [capabilities, setCapabilities] = useState<ProviderCapability | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectionResults, setDetectionResults] = useState<unknown[]>([]);

  const [outboundTasks, setOutboundTasks] = useState<OutboundTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [processingQueue, setProcessingQueue] = useState(false);
  const [queuingProducts, setQueuingProducts] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [backfillingPreparation, setBackfillingPreparation] = useState(false);
  const loadCapabilities = useCallback(async () => {
    if (!connectionId) return;
    const { data } = await supabase
      .from("provider_capabilities")
      .select("*")
      .eq("connection_id", connectionId)
      .single();
    if (data) setCapabilities(data as unknown as ProviderCapability);
  }, [connectionId]);

  const detectCapabilities = useCallback(async () => {
    if (!connectionId) return;
    setDetecting(true);
    setDetectionResults([]);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "detect-capabilities", connectionId },
      });
      if (error) throw error;
      setDetectionResults(data?.results || []);
      await loadCapabilities();
      return data;
    } catch (e) {
      console.error("Failed to detect capabilities:", e);
    } finally {
      setDetecting(false);
    }
  }, [connectionId, loadCapabilities]);

  const loadOutboundTasks = useCallback(async (): Promise<OutboundTask[]> => {
    if (!connectionId) return [];
    setLoadingTasks(true);
    try {
      const { data, error } = await supabase
        .from("outbound_tasks")
        .select("*")
        .eq("connection_id", connectionId)
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) throw error;

      const tasks = (data ?? []) as unknown as OutboundTask[];
      setOutboundTasks(tasks);
      return tasks;
    } catch (e) {
      console.error("Failed to load outbound tasks:", e);
      return [];
    } finally {
      setLoadingTasks(false);
    }
  }, [connectionId]);

  const queueProducts = useCallback(async (winerimWineIds: string[], formatTypes?: string[], familyOverrideId?: string) => {
    if (!connectionId) return;
    setQueuingProducts(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "queue-xml-outbound", connectionId, winerimWineIds, formatTypes: formatTypes || ["BOTTLE", "GLASS"], familyOverrideId: familyOverrideId || null },
      });
      if (error) throw error;
      await loadOutboundTasks();
      return data;
    } catch (e) {
      console.error("Failed to queue products:", e);
    } finally {
      setQueuingProducts(false);
    }
  }, [connectionId, loadOutboundTasks]);

  const processQueue = useCallback(async () => {
    if (!connectionId) return;
    setProcessingQueue(true);
    try {
      const { data: xmlData, error: xmlError } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "process-xml-outbound-queue", connectionId },
      });
      if (xmlError) throw xmlError;

      // Backward compatibility: also process legacy JSON queue if any old tasks exist
      const { data: legacyData, error: legacyError } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "process-outbound-queue", connectionId },
      });
      if (legacyError) throw legacyError;

      await loadOutboundTasks();
      return {
        success: true,
        processed: (xmlData?.processed || 0) + (legacyData?.processed || 0),
        succeeded: (xmlData?.succeeded || 0) + (legacyData?.succeeded || 0),
        failed: (xmlData?.failed || 0) + (legacyData?.failed || 0),
        xml: xmlData,
        legacy: legacyData,
      };
    } catch (e) {
      console.error("Failed to process queue:", e);
    } finally {
      setProcessingQueue(false);
    }
  }, [connectionId, loadOutboundTasks]);

  const retryTask = useCallback(async (taskId: string) => {
    await supabase.from("outbound_tasks").update({ status: "QUEUED", last_error: null, blocked_reason: null }).eq("id", taskId);
    await loadOutboundTasks();
  }, [loadOutboundTasks]);

  const exportProducts = useCallback(async (format: "json" | "csv", winerimWineIds?: string[]) => {
    if (!connectionId) return;
    setExporting(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "export-products", connectionId, format, winerimWineIds },
      });
      if (error) throw error;

      if (format === "csv" && typeof data === "string") {
        const blob = new Blob([data], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "agora-import.csv";
        a.click();
        URL.revokeObjectURL(url);
      } else if (data?.products) {
        const blob = new Blob([JSON.stringify(data.products, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "agora-import.json";
        a.click();
        URL.revokeObjectURL(url);
      }
      return data;
    } catch (e) {
      console.error("Failed to export:", e);
    } finally {
      setExporting(false);
    }
  }, [connectionId]);

  const backfillPreparation = useCallback(async (winerimWineIds?: string[]) => {
    if (!connectionId) return;
    setBackfillingPreparation(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "backfill-preparation", connectionId, winerimWineIds: winerimWineIds || [] },
      });
      if (error) throw error;
      await loadOutboundTasks();
      return data;
    } catch (e) {
      console.error("Failed to backfill preparation:", e);
    } finally {
      setBackfillingPreparation(false);
    }
  }, [connectionId, loadOutboundTasks]);

  const fixMissingPrices = useCallback(async (winerimWineIds: string[], formatTypes?: string[]) => {
    if (!connectionId) return;
    setFixingPrices(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "backfill-prices", connectionId, winerimWineIds, formatTypes: formatTypes || ["BOTTLE", "GLASS"] },
      });
      if (error) throw error;
      await loadOutboundTasks();
      return data;
    } catch (e) {
      console.error("Failed to fix missing prices:", e);
    } finally {
      setFixingPrices(false);
    }
  }, [connectionId, loadOutboundTasks]);

  return {
    capabilities, detecting, detectionResults,
    loadCapabilities, detectCapabilities,
    outboundTasks, loadingTasks, loadOutboundTasks,
    processingQueue, processQueue,
    queuingProducts, queueProducts,
    exporting, exportProducts,
    retryTask,
    backfillingPreparation, backfillPreparation,
    fixingPrices, fixMissingPrices,
  };
}
