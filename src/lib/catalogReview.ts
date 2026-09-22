// Pure helpers for the read-only Review console.
// No writes, no side effects: labels, compatibility rules, audit-state derivation
// (mirrors review_catalog_audit in SQL) and CSV export.

export const REVIEW_FORMAT_LABELS: Record<string, string> = {
  BOTTLE: "Botella",
  GLASS: "Copa",
  MAGNUM: "Magnum",
  HALF_GLASS: "Media copa",
  HALF_BOTTLE: "Media botella",
  SMALL_BOTTLE: "Botella pequeña",
  BENJAMIN: "Benjamín",
  DOUBLE_MAGNUM: "Doble magnum",
  SIN_DATO: "Sin dato",
};

export const REVIEW_FORMAT_FILTER_KEYS = [
  "BOTTLE",
  "GLASS",
  "MAGNUM",
  "HALF_GLASS",
  "HALF_BOTTLE",
  "SMALL_BOTTLE",
  "BENJAMIN",
  "DOUBLE_MAGNUM",
  "SIN_DATO",
] as const;

export type ReviewFormatKey = (typeof REVIEW_FORMAT_FILTER_KEYS)[number];

export type DecisionStatus =
  | "DRAFT"
  | "READY_FOR_APPROVAL"
  | "NO_MATCH"
  | "NEEDS_CONFIRMATION"
  | "APPLIED";

export const DECISION_STATUS_LABELS: Record<DecisionStatus, string> = {
  DRAFT: "Borrador",
  READY_FOR_APPROVAL: "Listo para aprobar",
  NO_MATCH: "Sin coincidencia",
  NEEDS_CONFIRMATION: "Necesita confirmación",
  APPLIED: "Aprobado y aplicado",
};

export type ApprovableDecisionRow = {
  provider_product_id: string;
  provider_product_name: string;
  format_key: string | null;
  decision_status: string;
  selected_winerim_id: string | null;
  selected_winerim_name: string | null;
  selected_format_key: string | null;
};

/** Only a saved READY_FOR_APPROVAL decision with a compatible variant can be applied. */
export function canApplyDecision(row: ApprovableDecisionRow): boolean {
  if (row.decision_status !== "READY_FOR_APPROVAL") return false;
  return canApproveDecision({
    agoraFormatKey: row.format_key,
    selectedWinerimId: row.selected_winerim_id,
    selectedFormatKey: row.selected_format_key,
    // A stored READY_FOR_APPROVAL over an unknown POS format was only allowed
    // when the wine had a single active variant, so the format is unambiguous.
    soleVariant: true,
  });
}

/** Builds the CONFIRMED product_mapping row for an approved decision. Pure: no writes. */
export function buildMappingPayload(connectionId: string, row: ApprovableDecisionRow) {
  if (!canApplyDecision(row)) throw new Error("La decisión no es aprobable");
  return {
    connection_id: connectionId,
    provider_product_id: row.provider_product_id,
    provider_product_name: row.provider_product_name,
    winerim_wine_id: row.selected_winerim_id,
    winerim_wine_name: row.selected_winerim_name,
    format_type: row.selected_format_key as string,
    match_method: "MANUAL_REVIEW",
    match_score: 1,
    match_reasons: ["APPROVED_IN_REVIEW_CONSOLE"],
    status: "CONFIRMED",
  };
}

export const AUDIT_STATUS_LABELS: Record<string, string> = {
  MATCHED_LIVE: "Coincide en vivo",
  MISSING_IN_AGORA: "No está en Ágora",
  PRICE_MISMATCH: "Precio distinto",
  FORMAT_MISMATCH: "Formato distinto",
  NOT_SALEABLE: "No vendible",
  HIDDEN: "Oculto",
  FAMILY_MISMATCH: "Familia distinta",
  PENDING_PUSH: "Envío pendiente",
  PUSH_FAILED: "Envío fallido",
  NO_CURRENT_READBACK: "Sin lectura fresca",
  LEGACY_ONLY: "Solo legacy",
  AMBIGUOUS: "Ambiguo",
};

/**
 * "Oculto" means not visible AND not saleable.
 * When a product is saleable in its family but lacks a main-screen button,
 * the accurate label is "Sin tecla principal".
 */
export function formatAuditStatusLabel(
  status: string,
  agoraSaleable: boolean | null | undefined,
): string {
  if (status !== "HIDDEN") return AUDIT_STATUS_LABELS[status] ?? status;
  if (agoraSaleable === true) return "Sin tecla principal";
  return "Oculto";
}

export const LEGACY_STATE_LABELS: Record<string, string> = {
  LEGACY_VISIBLE: "Legacy visible",
  LEGACY_HIDDEN: "Legacy oculto",
  LEGACY_MAPPED_EXCEPTION: "Legacy con mapa (excepción)",
  LEGACY_ONLY: "Solo legacy",
  IDENTITY_BLOCKED: "Identidad bloqueada",
};

export function formatLabel(key: string | null | undefined): string {
  if (!key) return REVIEW_FORMAT_LABELS.SIN_DATO;
  return REVIEW_FORMAT_LABELS[key] ?? key;
}

/** A decision is only valid when the Agora sold format equals the Winerim variant format. */
export function isVariantCompatible(
  agoraFormatKey: string | null | undefined,
  variantFormatKey: string | null | undefined,
): boolean {
  if (!agoraFormatKey || !variantFormatKey) return false;
  if (agoraFormatKey === "SIN_DATO" || variantFormatKey === "SIN_DATO") return false;
  return agoraFormatKey === variantFormatKey;
}

/**
 * Selection is allowed when formats match, or when the POS format is unknown
 * ("Sin dato"): the chosen exact variant defines the format and is approvable.
 */
export function isVariantSelectable(
  agoraFormatKey: string | null | undefined,
  variantFormatKey: string | null | undefined,
): boolean {
  if (!variantFormatKey || variantFormatKey === "SIN_DATO") return false;
  if (!agoraFormatKey || agoraFormatKey === "SIN_DATO") return true;
  return agoraFormatKey === variantFormatKey;
}

export function canApproveDecision(input: {
  agoraFormatKey: string | null | undefined;
  selectedWinerimId: string | null | undefined;
  selectedFormatKey: string | null | undefined;
  /** Kept for compatibility: a sole variant is still unambiguous. */
  soleVariant?: boolean;
}): boolean {
  if (!input.selectedWinerimId) return false;
  if (isVariantCompatible(input.agoraFormatKey, input.selectedFormatKey)) return true;
  // POS did not report a format: the operator picked an exact variant, so it is approvable.
  const agoraUnknown = !input.agoraFormatKey || input.agoraFormatKey === "SIN_DATO";
  const variantKnown = !!input.selectedFormatKey && input.selectedFormatKey !== "SIN_DATO";
  return agoraUnknown && variantKnown;
}


export type AuditInput = {
  formatKey: string | null;
  pushStatus: string | null;
  readbackFresh: boolean | null;
  foundInAgora: boolean | null;
  agoraSaleable: boolean | null;
  agoraVisible: boolean | null;
  expectedFamilyId: string | null;
  agoraFamilyId: string | null;
  winerimPrice: number | null;
  agoraPrice: number | null;
};

/** Mirrors the precedence used by review_catalog_audit in the database. */
export function deriveAuditStatus(input: AuditInput): string {
  if (!input.formatKey || input.formatKey === "SIN_DATO") return "AMBIGUOUS";
  if (input.pushStatus === "FAILED") return "PUSH_FAILED";
  if (input.pushStatus === "PENDING" || input.pushStatus === "QUEUED") return "PENDING_PUSH";
  if (!input.readbackFresh) return "NO_CURRENT_READBACK";
  if (input.foundInAgora === false) return "MISSING_IN_AGORA";
  if (input.agoraSaleable === false) return "NOT_SALEABLE";
  if (input.agoraVisible === false && input.pushStatus === null) return "HIDDEN";
  if (
    input.expectedFamilyId &&
    input.agoraFamilyId &&
    input.expectedFamilyId !== input.agoraFamilyId
  ) {
    return "FAMILY_MISMATCH";
  }
  if (
    input.winerimPrice !== null &&
    input.agoraPrice !== null &&
    Math.abs(input.winerimPrice - input.agoraPrice) > 0.005
  ) {
    return "PRICE_MISMATCH";
  }
  if (!input.pushStatus) return "LEGACY_ONLY";
  return "MATCHED_LIVE";
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString("es-ES", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** NULL stays unknown: never rendered as false/0. */
export function formatBoolean(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "Desconocido";
  return value ? "Sí" : "No";
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-ES");
}

export function formatLatency(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "SIN_EVIDENCIA";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = Array.isArray(v) ? v.join("|") : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
}

export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  const csv = toCsv(rows);
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
