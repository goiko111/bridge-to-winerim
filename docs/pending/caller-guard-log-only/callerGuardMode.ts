// PENDIENTE DE OK DE GOIKO — se añadirá al final de supabase/functions/_shared/connectionCallerGuard.ts.
// Modo por defecto: "log_only" (calcula y registra la decisión, deja pasar todo).
// Solo bloquea si el secreto/env CALLER_GUARD_MODE === "enforce".
// Nunca registra la clave ni el token: solo función, acción, tipo de llamante y origen.

import type { CallerDecision } from "../../../supabase/functions/_shared/connectionCallerGuard.ts";

export type CallerGuardMode = "log_only" | "enforce";

export function callerGuardMode(raw: string | undefined): CallerGuardMode {
  return raw === "enforce" ? "enforce" : "log_only";
}

export type CallerLogEntry = {
  tag: "CALLER_GUARD";
  mode: CallerGuardMode;
  fn: string;
  action: string | null;
  connectionId: string | null;
  callerKind: "internal" | "admin" | "tenant" | "rejected";
  code: string | null;
  wouldBlock: boolean;
  blocked: boolean;
  userId: string | null;
  origin: string | null;
  userAgent: string | null;
};

export function buildCallerLog(
  fn: string, action: unknown, connectionId: unknown, d: CallerDecision, mode: CallerGuardMode,
  headers: { get(name: string): string | null },
): CallerLogEntry {
  const ua = headers.get("user-agent");
  return {
    tag: "CALLER_GUARD", mode, fn,
    action: typeof action === "string" ? action.slice(0, 80) : null,
    connectionId: typeof connectionId === "string" ? connectionId.slice(0, 36) : null,
    callerKind: d.ok ? d.kind : "rejected",
    code: d.ok ? null : d.code,
    wouldBlock: !d.ok,
    blocked: !d.ok && mode === "enforce",
    userId: d.ok ? d.userId ?? null : null,
    origin: headers.get("origin") ?? headers.get("referer")?.slice(0, 120) ?? null,
    userAgent: ua ? ua.slice(0, 80) : null,
  };
}

/** Devuelve true si la petición debe rechazarse (solo en modo enforce). Siempre registra. */
export function applyCallerGuard(entry: CallerLogEntry, log: (s: string) => void = console.log): boolean {
  log(JSON.stringify(entry));
  return entry.blocked;
}
