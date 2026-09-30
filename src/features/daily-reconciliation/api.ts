import { supabase } from "@/integrations/supabase/client";
import type { FleetPayload, ReconciliationPayload } from "./types";

const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
const anonKey = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? "");

async function request(path: string): Promise<Response> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("Sesión requerida");
  return fetch(`${supabaseUrl}/functions/v1/read-reconciliation-results${path}`, { headers: { Accept: "application/json", Authorization: `Bearer ${data.session.access_token}`, apikey: anonKey } });
}

async function json<T>(path: string): Promise<T> {
  const response = await request(path); const payload = await response.json();
  if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload as T;
}

export const reconciliationApi = {
  fleet: () => json<FleetPayload>("?view=fleet"),
  details: (connectionId: string, from: string, to: string, state?: string) => json<ReconciliationPayload>(`?connectionId=${encodeURIComponent(connectionId)}&from=${from}&to=${to}${state ? `&state=${encodeURIComponent(state)}` : ""}`),
  exportUrl: async (connectionId: string, from: string, to: string, format: "csv" | "json") => {
    const response = await request(`?connectionId=${encodeURIComponent(connectionId)}&from=${from}&to=${to}&format=${format}`);
    if (!response.ok) throw new Error(`Export HTTP ${response.status}`);
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `reconciliation-${connectionId}-${from}-${to}.${format}`; link.click(); URL.revokeObjectURL(url);
  },
};
