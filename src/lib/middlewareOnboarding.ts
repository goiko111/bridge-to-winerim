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

export const PROVIDER_LABELS: Record<OnboardingProvider, string> = {
  agora: "Agora",
  revo: "REVO",
};

const DEFAULT_PROVIDER: OnboardingProvider = "agora";
export const DEFAULT_REVO_BASE_URL = "https://revoxef.works/api/external";

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
