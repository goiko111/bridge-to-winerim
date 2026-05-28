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
  const OUTBOUND_TASKS_PAGE_SIZE = 1000;
  const [capabilities, setCapabilities] = useState<ProviderCapability | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectionResults, setDetectionResults] = useState<unknown[]>([]);

  const [outboundTasks, setOutboundTasks] = useState<OutboundTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [processingQueue, setProcessingQueue] = useState(false);
  const [queuingProducts, setQueuingProducts] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [backfillingPreparation, setBackfillingPreparation] = useState(false);
  const [fixingPrices, setFixingPrices] = useState(false);
  const [reassigningFamilies, setReassigningFamilies] = useState(false);
  const [clearingQueue, setClearingQueue] = useState(false);
  const [queueProgress, setQueueProgress] = useState<{ processed: number; succeeded: number; failed: number; total: number } | null>(null);
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
      const allTasks: OutboundTask[] = [];
      let from = 0;

      while (true) {
        const { data, error } = await supabase
          .from("outbound_tasks")
          .select("*")
          .eq("connection_id", connectionId)
          .order("created_at", { ascending: false })
          .range(from, from + OUTBOUND_TASKS_PAGE_SIZE - 1);

        if (error) throw error;

        const page = (data ?? []) as unknown as OutboundTask[];
        if (page.length === 0) break;

        allTasks.push(...page);

        if (page.length < OUTBOUND_TASKS_PAGE_SIZE) break;
        from += OUTBOUND_TASKS_PAGE_SIZE;
      }

      const tasks = allTasks;
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
        body: { action: "queue-xml-outbound", connectionId, winerimWineIds, formatTypes: formatTypes || ["BOTTLE", "GLASS", "MAGNUM"], familyOverrideId: familyOverrideId || null },
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
    let totalProcessed = 0, totalSucceeded = 0, totalFailed = 0;
    // Snapshot initial queue size for progress tracking
    const initialQueued = outboundTasks.filter(t => t.status === "QUEUED" || t.status === "RUNNING").length;
    setQueueProgress({ processed: 0, succeeded: 0, failed: 0, total: initialQueued });
    try {
      const invokeWithRetry = async (action: "process-xml-outbound-queue" | "process-outbound-queue") => {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const { data, error } = await supabase.functions.invoke("agora-proxy", {
              body: { action, connectionId },
            });
            if (error) throw error;
            return data;
          } catch (err) {
            lastError = err;
            if (attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
            }
          }
        }
        throw lastError;
      };

      // Auto-loop: keep calling until both queues are empty
      let xmlDone = false, legacyDone = false;
      while (!xmlDone || !legacyDone) {
        if (!xmlDone) {
          const xmlData = await invokeWithRetry("process-xml-outbound-queue");
          totalProcessed += xmlData?.processed || 0;
          totalSucceeded += xmlData?.succeeded || 0;
          totalFailed += xmlData?.failed || 0;
          xmlDone = xmlData?.done !== false;
        }

        if (!legacyDone) {
          const legacyData = await invokeWithRetry("process-outbound-queue");
          totalProcessed += legacyData?.processed || 0;
          totalSucceeded += legacyData?.succeeded || 0;
          totalFailed += legacyData?.failed || 0;
          legacyDone = legacyData?.done !== false;
        }

        // Update progress and refresh task list after each batch
        setQueueProgress({ processed: totalProcessed, succeeded: totalSucceeded, failed: totalFailed, total: initialQueued });
        await loadOutboundTasks();
      }

      return {
        success: true,
        processed: totalProcessed,
        succeeded: totalSucceeded,
        failed: totalFailed,
      };
    } catch (e) {
      console.error("Failed to process queue:", e);
    } finally {
      setProcessingQueue(false);
      setQueueProgress(null);
    }
  }, [connectionId, loadOutboundTasks, outboundTasks]);

  // Server-side queue processing: starts the loop on the server, no browser dependency
  const processQueueServerSide = useCallback(async () => {
    if (!connectionId) return;
    setProcessingQueue(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "process-xml-outbound-queue", connectionId, serverLoop: true },
      });
      if (error) throw error;
      await loadOutboundTasks();
      return data;
    } catch (e) {
      console.error("Failed to start server-side queue processing:", e);
    } finally {
      setProcessingQueue(false);
    }
  }, [connectionId, loadOutboundTasks]);

  const retryTask = useCallback(async (taskId: string) => {
    await supabase.from("outbound_tasks").update({ status: "QUEUED", last_error: null, blocked_reason: null }).eq("id", taskId);
    await loadOutboundTasks();
  }, [loadOutboundTasks]);

  const requeueTaskWithCurrentScope = useCallback(async (taskId: string) => {
    if (!connectionId) return;
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "requeue-task-current-scope", connectionId, taskId },
      });
      if (error) throw error;
      await loadOutboundTasks();
      return data;
    } catch (e) {
      console.error("Failed to requeue task with current verification scope:", e);
    }
  }, [connectionId, loadOutboundTasks]);

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
        body: { action: "backfill-prices", connectionId, winerimWineIds, formatTypes: formatTypes || ["BOTTLE", "GLASS", "MAGNUM"] },
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

  const reassignFamilies = useCallback(async (winerimWineIds?: string[]) => {
    if (!connectionId) return;
    setReassigningFamilies(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "reassign-families", connectionId, winerimWineIds: winerimWineIds || [] },
      });
      if (error) throw error;
      await loadOutboundTasks();
      return data;
    } catch (e) {
      console.error("Failed to reassign families:", e);
    } finally {
      setReassigningFamilies(false);
    }
  }, [connectionId, loadOutboundTasks]);

  const clearQueue = useCallback(async (statusFilter?: "FAILED" | "BLOCKED") => {
    if (!connectionId) return;
    setClearingQueue(true);
    try {
      let query = supabase.from("outbound_tasks").delete().eq("connection_id", connectionId);
      if (statusFilter === "FAILED") {
        query = query.in("status", ["FAILED", "BLOCKED"]);
      }
      const { error } = await query;
      if (error) throw error;
      await loadOutboundTasks();
      return { success: true };
    } catch (e) {
      console.error("Failed to clear queue:", e);
    } finally {
      setClearingQueue(false);
    }
  }, [connectionId, loadOutboundTasks]);

  const [requeueingBlocked, setRequeuingBlocked] = useState(false);
  const requeueBlockedAsUpdate = useCallback(async () => {
    if (!connectionId) return;
    setRequeuingBlocked(true);
    try {
      const { data, error } = await supabase.functions.invoke("agora-proxy", {
        body: { action: "requeue-blocked-as-update", connectionId },
      });
      if (error) throw error;
      await loadOutboundTasks();
      return data;
    } catch (e) {
      console.error("Failed to requeue blocked as update:", e);
    } finally {
      setRequeuingBlocked(false);
    }
  }, [connectionId, loadOutboundTasks]);

  return {
    capabilities, detecting, detectionResults,
    loadCapabilities, detectCapabilities,
    outboundTasks, loadingTasks, loadOutboundTasks,
    processingQueue, processQueue, processQueueServerSide, queueProgress,
    queuingProducts, queueProducts,
    exporting, exportProducts,
    retryTask,
    requeueTaskWithCurrentScope,
    backfillingPreparation, backfillPreparation,
    fixingPrices, fixMissingPrices,
    reassigningFamilies, reassignFamilies,
    clearingQueue, clearQueue,
    requeueingBlocked, requeueBlockedAsUpdate,
  };
}
