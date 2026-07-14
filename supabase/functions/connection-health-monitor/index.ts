import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { classifyPosError } from "../_shared/resilience.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Severity = "info" | "warning" | "error" | "critical";
type HealthStatus = "OK" | "WARN" | "DOWN" | "AUTH_ERROR" | "ERROR" | "PAUSED" | "STALE";

interface MonitorBody {
  provider?: string;
  connectionId?: string;
  includeDisabled?: boolean;
  sendEmails?: boolean;
  notifyClients?: boolean;
  dryRun?: boolean;
}

interface ProbeResult {
  status: HealthStatus;
  severity: Severity;
  httpStatus?: number;
  latencyMs?: number;
  errorClass?: string;
  errorMessage?: string;
  details: Record<string, unknown>;
}

interface Problem {
  key: string;
  type: string;
  severity: Severity;
  title: string;
  message: string;
  errorClass?: string;
  errorMessage?: string;
  details: Record<string, unknown>;
}

const severityRank: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function envList(...names: string[]): string[] {
  for (const name of names) {
    const raw = Deno.env.get(name);
    if (raw?.trim()) {
      return raw.split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);
    }
  }
  return [];
}

function envNumber(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function hasValidMonitorSecret(req: Request): boolean {
  const expected = Deno.env.get("MONITOR_CRON_SECRET") || Deno.env.get("ALERT_MONITOR_SECRET");
  if (!expected?.trim()) return false;
  const provided = req.headers.get("x-monitor-secret") || req.headers.get("x-cron-secret");
  return provided === expected;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map((x) => x.trim()).filter(Boolean)));
}

function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname) return null;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function probeAgoraConnection(connection: any): Promise<ProbeResult> {
  const baseUrl = normalizeBaseUrl(connection.base_url);
  if (!baseUrl) {
    return {
      status: "ERROR",
      severity: "error",
      errorClass: "BUSINESS_ERROR",
      errorMessage: "Missing or invalid base_url",
      details: { reason: "invalid_base_url" },
    };
  }

  const endpoint = `${baseUrl}/api/export-master/?filter=Families`;
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: "GET",
      headers: {
        "Api-Token": (connection.api_token || "").trim(),
        Accept: "*/*",
      },
    }, 5000);
    const latencyMs = Date.now() - started;

    if (response.status === 401 || response.status === 403) {
      const text = await response.text().catch(() => "");
      return {
        status: "AUTH_ERROR",
        severity: "critical",
        httpStatus: response.status,
        latencyMs,
        errorClass: "BUSINESS_ERROR",
        errorMessage: `Agora auth failed with HTTP ${response.status}`,
        details: { endpoint: "/api/export-master/?filter=Families", bodyPreview: text.slice(0, 300) },
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const errorClass = classifyPosError(text, response.status);
      return {
        status: response.status >= 500 ? "DOWN" : "ERROR",
        severity: response.status >= 500 ? "error" : "warning",
        httpStatus: response.status,
        latencyMs,
        errorClass,
        errorMessage: `Agora health probe returned HTTP ${response.status}`,
        details: { endpoint: "/api/export-master/?filter=Families", bodyPreview: text.slice(0, 300) },
      };
    }

    return {
      status: "OK",
      severity: "info",
      httpStatus: response.status,
      latencyMs,
      details: { endpoint: "/api/export-master/?filter=Families" },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const errorClass = classifyPosError(message);
    return {
      status: "DOWN",
      severity: "critical",
      latencyMs: Date.now() - started,
      errorClass,
      errorMessage: message,
      details: { endpoint: "/api/export-master/?filter=Families" },
    };
  }
}

async function loadOperationalSignals(supabase: any, connectionId: string) {
  const now = Date.now();
  const since24h = new Date(now - 24 * 3600_000).toISOString();
  const queuedOlderThan = new Date(now - 30 * 60_000).toISOString();
  const runningOlderThan = new Date(now - 15 * 60_000).toISOString();

  const [queuedOld, runningOld, failedRecent, blockedRecent, stockFailedRecent] = await Promise.all([
    supabase
      .from("outbound_tasks")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", connectionId)
      .eq("status", "QUEUED")
      .lt("created_at", queuedOlderThan),
    supabase
      .from("outbound_tasks")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", connectionId)
      .eq("status", "RUNNING")
      .lt("updated_at", runningOlderThan),
    supabase
      .from("outbound_tasks")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", connectionId)
      .eq("status", "FAILED")
      .gte("updated_at", since24h),
    supabase
      .from("outbound_tasks")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", connectionId)
      .eq("status", "BLOCKED")
      .gte("updated_at", since24h),
    supabase
      .from("stock_sync_log")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", connectionId)
      .eq("status", "FAILED")
      .gte("created_at", since24h),
  ]);

  return {
    queuedOld: queuedOld.count || 0,
    runningOld: runningOld.count || 0,
    failedRecent: failedRecent.count || 0,
    blockedRecent: blockedRecent.count || 0,
    stockFailedRecent: stockFailedRecent.count || 0,
  };
}

function daysSinceBusinessDay(day: string | null | undefined): number | null {
  if (!day) return null;
  const parsed = new Date(`${day}T00:00:00Z`).getTime();
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

function buildProblems(connection: any, probe: ProbeResult, signals: any): Problem[] {
  const problems: Problem[] = [];
  const now = Date.now();
  const pausedUntil = connection.circuit_breaker_paused_until;
  const isPaused = pausedUntil && new Date(pausedUntil).getTime() > now;

  // A failed probe and an open breaker are normally the same incident. Keep a
  // single connectivity alert while the POS is unreachable so the monitor does
  // not open two tickets (and two email threads) for one outage.
  if (isPaused && probe.status !== "DOWN") {
    problems.push({
      key: "breaker_open",
      type: "circuit_breaker",
      severity: "warning",
      title: `${connection.location_name}: circuit breaker abierto`,
      message: connection.circuit_breaker_reason || `La conexion esta pausada hasta ${pausedUntil}.`,
      errorClass: "POS_DOWN",
      errorMessage: connection.circuit_breaker_reason || undefined,
      details: { pausedUntil, consecutiveFailures: connection.consecutive_failures || 0 },
    });
  }

  if (probe.status === "DOWN") {
    problems.push({
      key: "connectivity",
      type: "connectivity",
      severity: probe.severity,
      title: `${connection.location_name}: Agora no responde`,
      message: `No se puede alcanzar Agora desde Lovable Cloud. Revisar TPV encendido, puerto, router, firewall o DDNS.`,
      errorClass: probe.errorClass,
      errorMessage: probe.errorMessage,
      details: {
        ...probe.details,
        breakerOpen: Boolean(isPaused),
        pausedUntil: isPaused ? pausedUntil : null,
        consecutiveFailures: connection.consecutive_failures || 0,
      },
    });
    return problems;
  }

  if (probe.status === "AUTH_ERROR") {
    problems.push({
      key: "auth",
      type: "auth",
      severity: "critical",
      title: `${connection.location_name}: token/API Agora rechazado`,
      message: `Agora responde ${probe.httpStatus}. Revisar token API HTTP y permisos.`,
      errorClass: probe.errorClass,
      errorMessage: probe.errorMessage,
      details: probe.details,
    });
    return problems;
  }

  if (probe.status === "ERROR") {
    problems.push({
      key: "api_error",
      type: "api_error",
      severity: probe.severity,
      title: `${connection.location_name}: respuesta anomala de Agora`,
      message: probe.errorMessage || "La sonda de Agora respondio con error.",
      errorClass: probe.errorClass,
      errorMessage: probe.errorMessage,
      details: probe.details,
    });
  }

  const readOnly = connection.provider_config?.read_only_onboarding === true;
  const salesLagDays = daysSinceBusinessDay(connection.last_business_day_synced);
  if (connection.enabled && !readOnly && salesLagDays !== null && salesLagDays >= 2) {
    problems.push({
      key: "sales_stale",
      type: "sales_stale",
      severity: "warning",
      title: `${connection.location_name}: ventas sin avanzar`,
      message: `El ultimo dia de negocio sincronizado es ${connection.last_business_day_synced}.`,
      details: { lastBusinessDaySynced: connection.last_business_day_synced, salesLagDays },
    });
  }

  const outboundTotal = signals.queuedOld + signals.runningOld + signals.failedRecent + signals.blockedRecent;
  if (outboundTotal > 0) {
    problems.push({
      key: "outbound_attention",
      type: "outbound_queue",
      severity: signals.failedRecent > 0 || signals.blockedRecent > 0 ? "error" : "warning",
      title: `${connection.location_name}: cola outbound requiere revision`,
      message: `${outboundTotal} tareas requieren atencion reciente o llevan demasiado tiempo pendientes.`,
      details: signals,
    });
  }

  if (signals.stockFailedRecent > 0) {
    problems.push({
      key: "stock_failed",
      type: "stock_sync",
      severity: "error",
      title: `${connection.location_name}: fallos recientes descontando stock`,
      message: `${signals.stockFailedRecent} descuentos de stock han fallado en las ultimas 24 horas.`,
      details: { stockFailedRecent: signals.stockFailedRecent },
    });
  }

  return problems;
}

function worstStatus(probe: ProbeResult, problems: Problem[]): { status: HealthStatus; severity: Severity } {
  if (probe.status !== "OK") return { status: probe.status, severity: probe.severity };
  const worst = problems.reduce<Problem | null>((acc, p) => (
    !acc || severityRank[p.severity] > severityRank[acc.severity] ? p : acc
  ), null);
  if (!worst) return { status: "OK", severity: "info" };
  return {
    status: worst.type === "sales_stale" ? "STALE" : "WARN",
    severity: worst.severity,
  };
}

async function recordCheck(supabase: any, connection: any, probe: ProbeResult, problems: Problem[], dryRun: boolean) {
  const overall = worstStatus(probe, problems);
  const row = {
    connection_id: connection.id,
    provider: connection.provider,
    location_name: connection.location_name,
    check_type: "agora_health",
    status: overall.status,
    severity: overall.severity,
    http_status: probe.httpStatus ?? null,
    latency_ms: probe.latencyMs ?? null,
    error_class: probe.errorClass ?? null,
    error_message: probe.errorMessage ?? null,
    details: {
      probe: probe.details,
      activeProblems: problems.map((p) => ({ key: p.key, type: p.type, severity: p.severity })),
    },
    checked_at: new Date().toISOString(),
  };
  if (dryRun) return { id: null, ...row };
  const { data, error } = await supabase.from("connection_health_checks").insert(row).select("id").single();
  if (error) throw error;
  return data;
}

async function upsertAlert(supabase: any, connection: any, problem: Problem, checkId: string | null, dryRun: boolean) {
  if (dryRun) {
    return {
      id: `dry-${connection.id}-${problem.key}`,
      connection_id: connection.id,
      provider: connection.provider,
      alert_key: problem.key,
      alert_type: problem.type,
      severity: problem.severity,
      status: "OPEN",
      title: problem.title,
      message: problem.message,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      occurrences: 1,
      consecutive_failures: 1,
      metadata: problem.details,
    };
  }

  const { data: existing, error: existingError } = await supabase
    .from("connection_alerts")
    .select("*")
    .eq("connection_id", connection.id)
    .eq("alert_key", problem.key)
    .in("status", ["OPEN", "ACKED"])
    .maybeSingle();
  if (existingError) throw existingError;

  const now = new Date().toISOString();
  if (existing) {
    const { data, error } = await supabase
      .from("connection_alerts")
      .update({
        alert_type: problem.type,
        severity: problem.severity,
        title: problem.title,
        message: problem.message,
        last_seen_at: now,
        occurrences: (existing.occurrences || 0) + 1,
        consecutive_failures: (existing.consecutive_failures || 0) + 1,
        last_check_id: checkId,
        last_error_class: problem.errorClass ?? null,
        last_error_message: problem.errorMessage ?? null,
        metadata: { ...(existing.metadata || {}), latest: problem.details },
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("connection_alerts")
    .insert({
      connection_id: connection.id,
      provider: connection.provider,
      alert_key: problem.key,
      alert_type: problem.type,
      severity: problem.severity,
      title: problem.title,
      message: problem.message,
      last_check_id: checkId,
      last_error_class: problem.errorClass ?? null,
      last_error_message: problem.errorMessage ?? null,
      notify_client: false,
      metadata: { latest: problem.details },
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function resolveMissingAlerts(
  supabase: any,
  connection: any,
  activeKeys: Set<string>,
  sendEmails: boolean,
  dryRun: boolean,
) {
  const { data: openAlerts, error } = await supabase
    .from("connection_alerts")
    .select("*")
    .eq("connection_id", connection.id)
    .in("status", ["OPEN", "ACKED"]);
  if (error) throw error;

  const resolved: any[] = [];
  for (const alert of openAlerts || []) {
    if (activeKeys.has(alert.alert_key)) continue;
    const now = new Date().toISOString();
    const next = { ...alert, status: "RESOLVED", resolved_at: now, last_seen_at: now };
    if (!dryRun) {
      const { data, error: updateError } = await supabase
        .from("connection_alerts")
        .update({ status: "RESOLVED", resolved_at: now, last_seen_at: now })
        .eq("id", alert.id)
        .select("*")
        .single();
      if (updateError) throw updateError;
      resolved.push(data);
    } else {
      resolved.push(next);
    }
  }

  if (sendEmails && !dryRun) {
    for (const alert of resolved) {
      await notifyRecovery(supabase, connection, alert);
    }
  }
  return resolved;
}

async function loadClientEmails(supabase: any, connection: any, alertType: string, severity: Severity): Promise<string[]> {
  const fromConfig = [
    ...(Array.isArray(connection.provider_config?.alert_client_emails) ? connection.provider_config.alert_client_emails : []),
    ...(Array.isArray(connection.provider_config?.client_alert_emails) ? connection.provider_config.client_alert_emails : []),
  ];

  const { data } = await supabase
    .from("connection_notification_contacts")
    .select("target, min_severity, alert_types")
    .eq("connection_id", connection.id)
    .eq("enabled", true)
    .eq("channel", "email")
    .eq("notify_client", true);

  const fromTable = (data || [])
    .filter((row: any) => severityRank[severity] >= severityRank[(row.min_severity || "warning") as Severity])
    .filter((row: any) => !Array.isArray(row.alert_types) || row.alert_types.length === 0 || row.alert_types.includes(alertType))
    .map((row: any) => row.target);

  return uniq([...fromConfig, ...fromTable]);
}

async function sendEmail(to: string[], subject: string, text: string, html: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY") || Deno.env.get("ALERT_RESEND_API_KEY");
  const from = Deno.env.get("ALERT_EMAIL_FROM") || Deno.env.get("RESEND_FROM_EMAIL");
  if (!apiKey || !from) {
    return { ok: false, error: "EMAIL_NOT_CONFIGURED: set RESEND_API_KEY and ALERT_EMAIL_FROM" };
  }
  if (to.length === 0) return { ok: true };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text,
      html,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, error: `EMAIL_HTTP_${response.status}: ${body.slice(0, 500)}` };
  }
  return { ok: true };
}

function alertEmailBody(connection: any, alert: any, audience: "internal" | "client") {
  const summary = [
    `Restaurante: ${connection.location_name}`,
    `Proveedor: ${connection.provider}`,
    `Incidencia: ${alert.title}`,
    `Detalle: ${alert.message}`,
    `Tipo: ${alert.alert_type}`,
    `Severidad: ${alert.severity}`,
    `Veces detectado: ${alert.occurrences}`,
    `Primera deteccion: ${alert.first_seen_at}`,
    `Ultima deteccion: ${alert.last_seen_at}`,
  ].join("\n");
  const clientHelp = audience === "client"
    ? "\n\nQue revisar: servidor/TPV encendido, conexion a internet, API HTTP de Agora, puerto 8984, router/firewall y DDNS si aplica."
    : "\n\nRunbook: revisar Alerts en middleware, Lovable Cloud logs, estado router/DDNS/puerto y circuit breaker.";
  const text = `${summary}${clientHelp}`;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.45">
    <h2>${htmlEscape(alert.title)}</h2>
    <p>${htmlEscape(alert.message)}</p>
    <ul>
      <li><strong>Restaurante:</strong> ${htmlEscape(connection.location_name)}</li>
      <li><strong>Proveedor:</strong> ${htmlEscape(connection.provider)}</li>
      <li><strong>Tipo:</strong> ${htmlEscape(alert.alert_type)}</li>
      <li><strong>Severidad:</strong> ${htmlEscape(alert.severity)}</li>
      <li><strong>Veces detectado:</strong> ${alert.occurrences}</li>
      <li><strong>Primera deteccion:</strong> ${htmlEscape(alert.first_seen_at)}</li>
      <li><strong>Ultima deteccion:</strong> ${htmlEscape(alert.last_seen_at)}</li>
    </ul>
    <p>${audience === "client"
      ? "Por favor, revisad servidor/TPV encendido, conexion a internet, API HTTP de Agora, puerto 8984, router/firewall y DDNS si aplica."
      : "Revisar el panel Alerts del middleware y los logs de Lovable Cloud antes de reintentar colas."}</p>
  </div>`;
  return { text, html };
}

async function maybeNotifyAlert(supabase: any, connection: any, alert: any, sendEmails: boolean, notifyClients: boolean) {
  if (!sendEmails) return { internal: "disabled", client: "disabled" };

  const internalAfter = envNumber("ALERT_INTERNAL_AFTER_OCCURRENCES", 2);
  const clientAfter = envNumber("ALERT_CLIENT_AFTER_OCCURRENCES", 3);
  const clientAfterMinutes = envNumber("ALERT_CLIENT_AFTER_MINUTES", 30);
  const minutesOpen = (Date.now() - new Date(alert.first_seen_at).getTime()) / 60_000;
  const updates: Record<string, unknown> = {};
  const result: Record<string, unknown> = {};

  if (!alert.internal_notified_at && (alert.occurrences >= internalAfter || alert.severity === "critical")) {
    const to = uniq(envList("ALERT_INTERNAL_EMAILS", "MONITOR_INTERNAL_EMAILS", "INTERNAL_ALERT_EMAILS"));
    const { text, html } = alertEmailBody(connection, alert, "internal");
    const sent = await sendEmail(to, `[Winerim TPV] ${alert.title}`, text, html);
    if (sent.ok) {
      updates.internal_notified_at = new Date().toISOString();
      result.internal = "sent";
    } else {
      updates.last_notification_error = sent.error;
      result.internal = sent.error;
    }
  }

  if (notifyClients && !alert.client_notified_at && alert.occurrences >= clientAfter && minutesOpen >= clientAfterMinutes) {
    const to = await loadClientEmails(supabase, connection, alert.alert_type, alert.severity);
    if (to.length > 0) {
      const { text, html } = alertEmailBody(connection, alert, "client");
      const sent = await sendEmail(to, `Winerim TPV: incidencia en ${connection.location_name}`, text, html);
      if (sent.ok) {
        updates.client_notified_at = new Date().toISOString();
        updates.notify_client = true;
        result.client = "sent";
      } else {
        updates.last_notification_error = sent.error;
        result.client = sent.error;
      }
    } else {
      result.client = "no_client_email";
    }
  }

  if (Object.keys(updates).length > 0) {
    await supabase.from("connection_alerts").update(updates).eq("id", alert.id);
  }
  return result;
}

async function notifyRecovery(supabase: any, connection: any, alert: any) {
  if (alert.recovery_notified_at) return;
  const updates: Record<string, unknown> = {};
  const internalTo = uniq(envList("ALERT_INTERNAL_EMAILS", "MONITOR_INTERNAL_EMAILS", "INTERNAL_ALERT_EMAILS"));
  if (alert.internal_notified_at && internalTo.length > 0) {
    const subject = `[Winerim TPV] Recuperado: ${connection.location_name}`;
    const text = `Recuperada la incidencia "${alert.title}" en ${connection.location_name}.\nResuelta: ${alert.resolved_at}`;
    const html = `<div style="font-family:Arial,sans-serif"><h2>Recuperado: ${htmlEscape(connection.location_name)}</h2><p>${htmlEscape(alert.title)}</p><p>Resuelta: ${htmlEscape(alert.resolved_at || "")}</p></div>`;
    const sent = await sendEmail(internalTo, subject, text, html);
    if (!sent.ok) updates.last_notification_error = sent.error;
  }

  if (alert.client_notified_at) {
    const clientTo = await loadClientEmails(supabase, connection, alert.alert_type, alert.severity);
    if (clientTo.length > 0) {
      const subject = `Winerim TPV: conexion recuperada en ${connection.location_name}`;
      const text = `La incidencia de conexion de ${connection.location_name} ya aparece recuperada.`;
      const html = `<div style="font-family:Arial,sans-serif"><h2>Conexion recuperada</h2><p>${htmlEscape(connection.location_name)} vuelve a responder correctamente.</p></div>`;
      const sent = await sendEmail(clientTo, subject, text, html);
      if (!sent.ok) updates.last_notification_error = sent.error;
    }
  }

  updates.recovery_notified_at = new Date().toISOString();
  await supabase.from("connection_alerts").update(updates).eq("id", alert.id);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = req.method === "POST"
      ? (await req.json().catch(() => ({}))) as MonitorBody
      : {} as MonitorBody;

    const provider = (body.provider || "agora").toLowerCase();
    const includeDisabled = body.includeDisabled === true;
    const requestedSendEmails = body.sendEmails === true;
    const requestedNotifyClients = body.notifyClients === true;
    const dryRun = body.dryRun === true;
    const cronAuthorized = hasValidMonitorSecret(req);

    if ((requestedSendEmails || requestedNotifyClients) && !cronAuthorized) {
      return jsonResponse({
        ok: false,
        error: "MONITOR_SECRET_REQUIRED",
        message: "Email notifications require X-Monitor-Secret and MONITOR_CRON_SECRET.",
      }, 403);
    }

    const sendEmails = requestedSendEmails && cronAuthorized;
    const notifyClients = requestedNotifyClients && cronAuthorized;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    let query = supabase
      .from("pos_connections")
      .select("*")
      .eq("provider", provider);
    if (!includeDisabled) query = query.eq("enabled", true);
    if (body.connectionId) query = query.eq("id", body.connectionId);

    const { data: connections, error: connError } = await query;
    if (connError) throw connError;

    const results = [];
    for (const connection of connections || []) {
      const probe = provider === "agora"
        ? await probeAgoraConnection(connection)
        : {
          status: "ERROR" as HealthStatus,
          severity: "warning" as Severity,
          errorMessage: `Provider ${provider} is not supported by this monitor yet`,
          details: {},
        };
      const signals = await loadOperationalSignals(supabase, connection.id);
      const problems = buildProblems(connection, probe, signals);
      const check = await recordCheck(supabase, connection, probe, problems, dryRun);
      const activeKeys = new Set(problems.map((p) => p.key));
      const alerts = [];
      const notificationResults = [];

      for (const problem of problems) {
        const alert = await upsertAlert(supabase, connection, problem, check.id, dryRun);
        alerts.push(alert);
        if (!dryRun) {
          notificationResults.push(await maybeNotifyAlert(supabase, connection, alert, sendEmails, notifyClients));
        }
      }

      const resolved = dryRun
        ? []
        : await resolveMissingAlerts(supabase, connection, activeKeys, sendEmails, dryRun);

      results.push({
        connectionId: connection.id,
        locationName: connection.location_name,
        status: worstStatus(probe, problems),
        problems: problems.map((p) => ({ key: p.key, type: p.type, severity: p.severity, title: p.title })),
        resolved: resolved.length,
        notifications: notificationResults,
      });
    }

    return jsonResponse({
      ok: true,
      provider,
      dryRun,
      checked: results.length,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
