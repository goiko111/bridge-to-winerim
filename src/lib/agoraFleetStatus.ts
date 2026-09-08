export type FleetSignal = "ok" | "warn" | "fail" | "disabled";

export interface AgoraFleetMetrics {
  enabled: boolean;
  writeMode: string | null;
  lastSyncAt: string | null;
  lastBusinessDaySynced: string | null;
  circuitBreakerPausedUntil: string | null;
  consecutiveFailures: number;
  verifiedProducts: number;
  legacyWineVisibleProducts: number;
  mappedSales7d: number;
  salesLines7d: number;
  stockSuccess7d: number;
  stockFailedOpen: number;
  outboundOpen: number;
  outboundFailed: number;
}

export interface AgoraFleetVerdict {
  signal: FleetSignal;
  label: string;
  detail: string;
}

function hoursSince(dateValue: string | null, now = Date.now()): number | null {
  if (!dateValue) return null;
  const parsed = new Date(dateValue).getTime();
  if (Number.isNaN(parsed)) return null;
  return (now - parsed) / 3600000;
}

export function evaluateAgoraFleetConnection(metrics: AgoraFleetMetrics, now = Date.now()): AgoraFleetVerdict {
  if (!metrics.enabled) {
    return {
      signal: "disabled",
      label: "Apagada / lectura",
      detail: "No ejecuta automatismos de ventas, stock ni catálogo.",
    };
  }

  const breakerUntil = metrics.circuitBreakerPausedUntil ? new Date(metrics.circuitBreakerPausedUntil).getTime() : null;
  if (breakerUntil && breakerUntil > now) {
    return {
      signal: "fail",
      label: "Breaker abierto",
      detail: `Pausada hasta ${new Date(breakerUntil).toLocaleString()}.`,
    };
  }

  const staleHours = hoursSince(metrics.lastSyncAt, now);
  if (staleHours === null || staleHours > 24) {
    return {
      signal: "fail",
      label: "Sin sincronización reciente",
      detail: staleHours === null ? "Nunca ha sincronizado." : `Última actividad hace ${Math.floor(staleHours)}h.`,
    };
  }

  if (metrics.stockFailedOpen > 0) {
    return {
      signal: "fail",
      label: "Stock con fallos",
      detail: `${metrics.stockFailedOpen} deducciones abiertas fallidas/bloqueadas.`,
    };
  }

  if (metrics.legacyWineVisibleProducts > 0 && metrics.mappedSales7d === 0 && metrics.salesLines7d > 0) {
    return {
      signal: "warn",
      label: "Legacy vendible",
      detail: `${metrics.legacyWineVisibleProducts} posibles vinos legacy visibles y ventas sin mapping.`,
    };
  }

  if (metrics.outboundFailed > 0) {
    return {
      signal: "warn",
      label: "Catálogo con incidencias",
      detail: `${metrics.outboundFailed} tareas de catálogo fallidas/bloqueadas.`,
    };
  }

  if (metrics.salesLines7d > 0 && metrics.mappedSales7d === 0) {
    return {
      signal: "warn",
      label: "Ventas sin mapping",
      detail: "Hay ventas recientes, pero ninguna línea mapeada a Winerim.",
    };
  }

  if (metrics.mappedSales7d > 0 && metrics.stockSuccess7d === 0) {
    return {
      signal: "warn",
      label: "Ventas mapeadas sin stock",
      detail: "Hay ventas mapeadas, pero no hay deducciones recientes confirmadas.",
    };
  }

  if (metrics.verifiedProducts === 0) {
    return {
      signal: "warn",
      label: "Catálogo sin verificación",
      detail: "No constan productos Winerim verificados en Agora.",
    };
  }

  return {
    signal: "ok",
    label: "Operativa",
    detail: "Conexión, catálogo y señales recientes sin bloqueo crítico.",
  };
}

export function signalRank(signal: FleetSignal): number {
  if (signal === "fail") return 0;
  if (signal === "warn") return 1;
  if (signal === "disabled") return 2;
  return 3;
}
