export type EvidenceState = "healthy" | "stale" | "unavailable";

export type ConnectionEvidence = {
  enabled: boolean;
  last_sync_at: string | null;
  sync_frequency_minutes: number | null;
  consecutive_failures: number | null;
  circuit_breaker_paused_until: string | null;
};

export const EXPECTED_ACTIVE_RESTAURANTS = 27;

export function connectionEvidenceState(
  connection: ConnectionEvidence,
  now = Date.now(),
): EvidenceState {
  if (!connection.enabled || connection.consecutive_failures && connection.consecutive_failures > 0) {
    return "unavailable";
  }

  if (
    connection.circuit_breaker_paused_until &&
    new Date(connection.circuit_breaker_paused_until).getTime() > now
  ) {
    return "unavailable";
  }

  if (!connection.last_sync_at) return "unavailable";
  const lastSync = new Date(connection.last_sync_at).getTime();
  if (!Number.isFinite(lastSync)) return "unavailable";

  const expectedMinutes = Math.max(connection.sync_frequency_minutes ?? 60, 15);
  const staleAfterMs = expectedMinutes * 3 * 60_000;
  return now - lastSync <= staleAfterMs ? "healthy" : "stale";
}

export function evidenceLabel(state: EvidenceState): string {
  if (state === "healthy") return "Al día";
  if (state === "stale") return "Lectura antigua";
  return "Sin lectura disponible";
}

export function formatEvidenceTime(value: string | null | undefined): string {
  if (!value) return "No hay lectura registrada";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha no válida";
  return date.toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "No disponible";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(value);
}

export function isWineEligible(input: {
  family?: string | null;
  name?: string | null;
  isWineCandidate?: boolean | null;
}): { eligible: boolean; reason: string } {
  const text = `${input.family ?? ""} ${input.name ?? ""}`.toLocaleLowerCase("es-ES");
  const excluded = [
    "agua",
    "water",
    "comida",
    "cocina",
    "postre",
    "café",
    "cafe",
    "refresco",
    "cerveza",
  ];
  const matched = excluded.find((word) => text.includes(word));
  if (matched) return { eligible: false, reason: `Excluido: ${matched}` };
  if (input.isWineCandidate !== true) {
    return { eligible: false, reason: "No está clasificado como vino" };
  }
  return { eligible: true, reason: "Candidato de vino" };
}

export function causalLatencySeconds(input: {
  detectedAt?: string | null;
  queuedAt?: string | null;
  appliedAt?: string | null;
  verifiedAt?: string | null;
}): number | null {
  const values = [input.detectedAt, input.queuedAt, input.appliedAt, input.verifiedAt];
  if (values.some((value) => !value || !/(Z|[+-]\d{2}:\d{2})$/.test(value))) return null;
  const points = values.map((value) => new Date(value as string).getTime());
  if (points.some((value) => !Number.isFinite(value))) return null;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index] < points[index - 1]) return null;
  }
  return Math.round((points[3] - points[0]) / 1000);
}

export function maskIdentifier(value: string | null | undefined): string {
  if (!value) return "No disponible";
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
