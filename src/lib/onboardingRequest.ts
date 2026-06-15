import {
  isReadyForTechnicalReview,
  normalizeOnboardingInput,
  type CommercialOnboardingInput,
  type OnboardingGate,
  type OnboardingProvider,
} from "@/lib/middlewareOnboarding";

export interface SanitizedOnboardingInput {
  provider: OnboardingProvider;
  locationName: string;
  posBaseUrl: string;
  revoTenant?: string;
  posAuthProvided: boolean;
  winerimAuthProvided: boolean;
  revoClientAuthProvided?: boolean;
  revoWebhookConfigured?: boolean;
}

export interface OnboardingRequestPayload {
  provider: OnboardingProvider;
  locationName: string;
  posBaseUrl: string;
  normalizedInput: SanitizedOnboardingInput;
  testGates: Array<Pick<OnboardingGate, "id" | "label" | "status" | "detail">>;
  testSummary: {
    readyForTechnicalReview: boolean;
    pass: number;
    warn: number;
    fail: number;
    blocked: number;
  };
}

export function sanitizeOnboardingInput(input: Partial<CommercialOnboardingInput>): SanitizedOnboardingInput {
  const normalized = normalizeOnboardingInput(input);
  const sanitized: SanitizedOnboardingInput = {
    provider: normalized.provider,
    locationName: normalized.locationName,
    posBaseUrl: normalized.posBaseUrl,
    posAuthProvided: normalized.posApiToken.length > 0,
    winerimAuthProvided: normalized.winerimApiToken.length > 0,
  };

  if (normalized.provider === "revo") {
    sanitized.revoTenant = normalized.revoTenant;
    sanitized.revoClientAuthProvided = normalized.revoClientToken.length > 0;
    sanitized.revoWebhookConfigured = normalized.revoWebhookSecret.length > 0;
  }

  return sanitized;
}

export function summarizeOnboardingGates(gates: OnboardingGate[]): OnboardingRequestPayload["testSummary"] {
  const summary = {
    readyForTechnicalReview: isReadyForTechnicalReview(gates),
    pass: 0,
    warn: 0,
    fail: 0,
    blocked: 0,
  };

  for (const gate of gates) {
    summary[gate.status] += 1;
  }

  return summary;
}

export function sanitizeOnboardingGates(gates: OnboardingGate[]): OnboardingRequestPayload["testGates"] {
  return gates.map(({ id, label, status, detail }) => ({ id, label, status, detail }));
}

export function buildOnboardingRequestPayload(
  input: Partial<CommercialOnboardingInput>,
  gates: OnboardingGate[],
): OnboardingRequestPayload {
  const normalizedInput = sanitizeOnboardingInput(input);

  return {
    provider: normalizedInput.provider,
    locationName: normalizedInput.locationName,
    posBaseUrl: normalizedInput.posBaseUrl,
    normalizedInput,
    testGates: sanitizeOnboardingGates(gates),
    testSummary: summarizeOnboardingGates(gates),
  };
}
