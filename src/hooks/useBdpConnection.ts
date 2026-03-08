import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface BdpTestResult {
  success: boolean;
  status: number;
  statusText: string;
  contentType: string | null;
  bodyPreview: string | null;
  message: string;
}

export function useBdpConnection() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<BdpTestResult | null>(null);
  const [saving, setSaving] = useState(false);

  const saveConnection = async (data: {
    locationName: string;
    baseUrl: string;
    port: string;
    userKey: string;
    password: string;
    exportProfileCode: string;
  }) => {
    const providerConfig = {
      port: data.port,
      user_key: data.userKey,
      password: data.password,
      export_profile_code: data.exportProfileCode,
    };

    // Sanitize base_url
    let baseUrl = data.baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl && !baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      baseUrl = "http://" + baseUrl;
    }

    const { data: row, error } = await supabase
      .from("pos_connections")
      .insert({
        location_name: data.locationName,
        base_url: baseUrl,
        api_token: "bdp-managed", // placeholder, real auth is in provider_config
        provider: "bdp",
        sync_mode: "PULL_ONLY",
        provider_config: providerConfig,
      } as any)
      .select()
      .single();
    if (error) throw error;
    setConnectionId(row.id);
    return row.id;
  };

  const updateConnection = async (id: string, data: Record<string, unknown>) => {
    const { error } = await supabase.from("pos_connections").update(data as any).eq("id", id);
    if (error) throw error;
  };

  const testConnection = async (fields: {
    locationName: string;
    baseUrl: string;
    port: string;
    userKey: string;
    password: string;
    exportProfileCode: string;
  }) => {
    setTestStatus("testing");
    setTestError(null);
    setTestResult(null);

    let connId = connectionId;

    if (!connId) {
      try {
        connId = await saveConnection(fields);
      } catch (e: any) {
        setTestStatus("error");
        setTestError(e.message);
        return false;
      }
    } else {
      let baseUrl = fields.baseUrl.trim().replace(/\/+$/, "");
      if (baseUrl && !baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
        baseUrl = "http://" + baseUrl;
      }
      await updateConnection(connId, {
        location_name: fields.locationName,
        base_url: baseUrl,
        provider_config: {
          port: fields.port,
          user_key: fields.userKey,
          password: fields.password,
          export_profile_code: fields.exportProfileCode,
        },
      });
    }

    try {
      const { data, error } = await supabase.functions.invoke("bdp-proxy", {
        body: { action: "test", connectionId: connId },
      });
      if (error) {
        setTestStatus("error");
        setTestError(error.message);
        return false;
      }
      setTestResult(data as BdpTestResult);
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

  const testCustomEndpoint = async (path: string, method = "GET") => {
    if (!connectionId) return null;
    const { data, error } = await supabase.functions.invoke("bdp-proxy", {
      body: { action: "test-custom", connectionId, path, method },
    });
    if (error) return { success: false, message: error.message } as any;
    return data;
  };

  const loadExistingConnection = async () => {
    const { data } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("provider", "bdp")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (data) {
      setConnectionId(data.id);
      return data;
    }
    return null;
  };

  return {
    connectionId,
    testStatus,
    testError,
    testResult,
    saving,
    saveConnection,
    updateConnection,
    testConnection,
    testCustomEndpoint,
    loadExistingConnection,
    setConnectionId,
  };
}
