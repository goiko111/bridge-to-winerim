export type OnboardingProvider = "agora" | "revo";

export type GateStatus = "pass" | "warn" | "fail" | "blocked";

export interface CommercialOnboardingInput {
  provider: OnboardingProvider;
  locationName: string;
  posBaseUrl: string;
  posApiToken: string;
  revoTenant: string;
  revoClientToken: string;
  revoWebhookSecret: string;
  winerimApiToken: string;
}

export interface OnboardingValidationResult {
  valid: boolean;
  errors: Partial<Record<keyof CommercialOnboardingInput, string>>;
  normalized: CommercialOnboardingInput;
}

export interface OnboardingGate {
  id: string;
  label: string;
  status: GateStatus;
  detail: string;
  technicalDetail?: string;
}

export interface TechnicalReviewPacket {
  provider: OnboardingProvider;
  locationName: string;
  posBaseUrl: string;
  revoTenant?: string;
  readyForTechnicalReview: boolean;
  gateSummary: Array<Pick<OnboardingGate, "id" | "label" | "status" | "detail">>;
  nextRequiredChecklistIds: string[];
}

export interface SanitizedOnboardingRequestResult {
  valid: boolean;
  errors: string[];
  reviewPacket: TechnicalReviewPacket | null;
}

export const PROVIDER_LABELS: Record<OnboardingProvider, string> = {
  agora: "Agora",
  revo: "REVO",
};

const DEFAULT_PROVIDER: OnboardingProvider = "agora";
export const DEFAULT_REVO_BASE_URL = "https://revoxef.works/api/external";

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0
    || a >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized);
}

export interface OnboardingDestinationValidation {
  allowed: boolean;
  reason?: "INVALID_URL" | "CREDENTIALS_IN_URL" | "PRIVATE_DESTINATION" | "HOST_NOT_ALLOWED" | "PORT_NOT_ALLOWED";
}

export function validateOnboardingDestination(
  value: string,
  allowedHosts: readonly string[],
): OnboardingDestinationValidation {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { allowed: false, reason: "INVALID_URL" };
  }

  if (parsed.username || parsed.password) return { allowed: false, reason: "CREDENTIALS_IN_URL" };

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    return { allowed: false, reason: "PRIVATE_DESTINATION" };
  }

  const effectivePort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  if (!["80", "443", "8984"].includes(effectivePort)) {
    return { allowed: false, reason: "PORT_NOT_ALLOWED" };
  }

  const normalizedAllowedHosts = allowedHosts.map((host) => host.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  if (!normalizedAllowedHosts.includes(hostname)) return { allowed: false, reason: "HOST_NOT_ALLOWED" };

  return { allowed: true };
}

export function normalizePosBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function normalizeOnboardingInput(input: Partial<CommercialOnboardingInput>): CommercialOnboardingInput {
  const rawProvider = String(input.provider || DEFAULT_PROVIDER).toLowerCase();
  const provider: OnboardingProvider = rawProvider === "revo" ? "revo" : "agora";
  const rawPosBaseUrl = String(input.posBaseUrl || "").trim();

  return {
    provider,
    locationName: String(input.locationName || "").trim(),
    posBaseUrl: provider === "revo" && !rawPosBaseUrl ? DEFAULT_REVO_BASE_URL : normalizePosBaseUrl(rawPosBaseUrl),
    posApiToken: String(input.posApiToken || "").trim(),
    revoTenant: String(input.revoTenant || "").trim(),
    revoClientToken: String(input.revoClientToken || "").trim(),
    revoWebhookSecret: String(input.revoWebhookSecret || "").trim(),
    winerimApiToken: String(input.winerimApiToken || "").trim(),
  };
}

export function validateCommercialOnboardingInput(input: Partial<CommercialOnboardingInput>): OnboardingValidationResult {
  const normalized = normalizeOnboardingInput(input);
  const errors: OnboardingValidationResult["errors"] = {};

  if (!normalized.locationName) errors.locationName = "Introduce el nombre del restaurante.";
  if (!normalized.posBaseUrl) {
    errors.posBaseUrl = "Introduce la URL del POS.";
  } else {
    try {
      const parsed = new URL(normalized.posBaseUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        errors.posBaseUrl = "La URL debe usar http o https.";
      } else if (parsed.username || parsed.password) {
        errors.posBaseUrl = "La URL no puede incluir usuario ni contrasena.";
      }
    } catch {
      errors.posBaseUrl = "La URL del POS no tiene un formato valido.";
    }
  }
  if (!normalized.posApiToken) {
    errors.posApiToken = normalized.provider === "revo"
      ? "Introduce el Access Token de REVO."
      : "Introduce el token/API key del POS.";
  }
  if (normalized.provider === "revo") {
    if (!normalized.revoTenant) errors.revoTenant = "Introduce el tenant/account username de REVO.";
    if (!normalized.revoClientToken) errors.revoClientToken = "Introduce el client-token/integrator token de REVO.";
  }
  if (!normalized.winerimApiToken) errors.winerimApiToken = "Introduce el token Winerim.";

  return { valid: Object.keys(errors).length === 0, errors, normalized };
}

export function buildInitialOnboardingGates(input: Partial<CommercialOnboardingInput>): OnboardingGate[] {
  const validation = validateCommercialOnboardingInput(input);
  const gates: OnboardingGate[] = [
    {
      id: "input",
      label: "Datos basicos",
      status: validation.valid ? "pass" : "fail",
      detail: validation.valid ? "Campos minimos completos." : "Faltan campos obligatorios.",
    },
    {
      id: "winerim",
      label: "Winerim",
      status: "blocked",
      detail: "Pendiente de probar token.",
    },
    {
      id: "pos",
      label: PROVIDER_LABELS[validation.normalized.provider],
      status: "blocked",
      detail: "Pendiente de probar alcance del POS.",
    },
    {
      id: "write",
      label: "Escritura",
      status: "blocked",
      detail: "La prueba comercial nunca escribe productos ni oculta legacy.",
    },
  ];

  return gates;
}

export function isReadyForTechnicalReview(gates: OnboardingGate[]): boolean {
  const required = gates.filter((gate) => ["input", "winerim", "pos"].includes(gate.id));
  return required.length > 0 && required.every((gate) => gate.status === "pass" || gate.status === "warn");
}

export function buildTechnicalReviewPacket(
  input: Partial<CommercialOnboardingInput>,
  gates: OnboardingGate[],
  nextRequiredChecklistIds: string[],
): TechnicalReviewPacket {
  const normalized = normalizeOnboardingInput(input);

  return {
    provider: normalized.provider,
    locationName: normalized.locationName,
    posBaseUrl: normalized.posBaseUrl,
    revoTenant: normalized.provider === "revo" ? normalized.revoTenant : undefined,
    readyForTechnicalReview: isReadyForTechnicalReview(gates),
    gateSummary: gates.map(({ id, label, status, detail }) => ({ id, label, status, detail })),
    nextRequiredChecklistIds,
  };
}

function sanitizeGateStatus(value: unknown): GateStatus {
  return value === "pass" || value === "warn" || value === "fail" || value === "blocked" ? value : "blocked";
}

function sanitizeGateSummary(value: unknown): TechnicalReviewPacket["gateSummary"] {
  if (!Array.isArray(value)) return [];
  return value.map((gateItem) => {
    const gateRecord = (gateItem || {}) as Record<string, unknown>;
    return {
      id: String(gateRecord.id || ""),
      label: String(gateRecord.label || ""),
      status: sanitizeGateStatus(gateRecord.status),
      detail: String(gateRecord.detail || ""),
    };
  });
}

export function sanitizeTechnicalReviewPacketPayload(payload: unknown): SanitizedOnboardingRequestResult {
  const body = (payload || {}) as Record<string, unknown>;
  const rawPacket = (body.reviewPacket || body) as Record<string, unknown>;
  const provider: OnboardingProvider = rawPacket.provider === "revo" ? "revo" : "agora";
  const locationName = String(rawPacket.locationName || "").trim();
  const posBaseUrl = normalizePosBaseUrl(String(rawPacket.posBaseUrl || ""));
  const errors: string[] = [];

  if (!locationName) errors.push("locationName is required.");
  if (!posBaseUrl) {
    errors.push("posBaseUrl is required.");
  } else {
    try {
      const parsed = new URL(posBaseUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) errors.push("posBaseUrl must use http or https.");
    } catch {
      errors.push("posBaseUrl is invalid.");
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, reviewPacket: null };
  }

  return {
    valid: true,
    errors: [],
    reviewPacket: {
      provider,
      locationName,
      posBaseUrl,
      revoTenant: provider === "revo" ? String(rawPacket.revoTenant || "").trim() : undefined,
      readyForTechnicalReview: rawPacket.readyForTechnicalReview === true,
      gateSummary: sanitizeGateSummary(rawPacket.gateSummary),
      nextRequiredChecklistIds: Array.isArray(rawPacket.nextRequiredChecklistIds)
        ? rawPacket.nextRequiredChecklistIds.map(String)
        : [],
    },
  };
}
