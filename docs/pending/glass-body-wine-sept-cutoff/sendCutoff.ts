// PENDIENTE DE OK DE GOIKO — no copiar a supabase/functions/ sin OK.
// Parte (a): la ficha de GET /wines/{id} llega como {success:true, wine:{...}}.
// Parte (b): fecha de corte. Repaso, intradía y reintentos solo envían días de
// negocio >= SEND_CUTOFF_DAY; los anteriores quedan en «septiembre pendiente de aprobar».

export const SEND_CUTOFF_DAY = "2026-09-30";

export function extractWineFromBody(body: unknown): unknown {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return null;
  if (b.wine && typeof b.wine === "object" && !Array.isArray(b.wine)) return b.wine;
  if (b.data && typeof b.data === "object" && !Array.isArray(b.data)) return b.data;
  return b;
}

export type CutoffPartition = { allowed: string[]; held: string[] };

export function partitionDaysByCutoff(days: string[], cutoff: string = SEND_CUTOFF_DAY): CutoffPartition {
  const allowed: string[] = [];
  const held: string[] = [];
  for (const d of days) (d >= cutoff ? allowed : held).push(d);
  return { allowed, held };
}

export function heldLogEntry(connectionId: string, held: string[]) {
  return { tag: "SEPTEMBER_PENDING_APPROVAL", connectionId, days: held, sent: false };
}
