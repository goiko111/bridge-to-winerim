import {
  isReadyForTechnicalReview,
  normalizeOnboardingInput,
  type CommercialOnboardingInput,
  type OnboardingGate,
  type OnboardingProvider,
} from "./middlewareOnboarding";

export const ONBOARDING_REQUEST_STATUSES = [
  "DRAFT",
  "TESTED",
  "READY_FOR_TECHNICAL_REVIEW",
  "TECHNICAL_REVIEW",
  "APPROVED",
  "REJECTED",
  "CONVERTED",
  "CANCELED",
] as const;

export type OnboardingRequestStatus = (typeof ONBOARDING_REQUEST_STATUSES)[number];

export const ALLOWED_ONBOARDING_STATUS_TRANSITIONS: Record<OnboardingRequestStatus, OnboardingRequestStatus[]> = {
  DRAFT: ["TESTED", "READY_FOR_TECHNICAL_REVIEW", "CANCELED"],
  TESTED: ["READY_FOR_TECHNICAL_REVIEW", "TECHNICAL_REVIEW", "REJECTED", "CANCELED"],
  READY_FOR_TECHNICAL_REVIEW: ["TECHNICAL_REVIEW", "APPROVED", "REJECTED", "CANCELED"],
  TECHNICAL_REVIEW: ["READY_FOR_TECHNICAL_REVIEW", "APPROVED", "REJECTED", "CANCELED"],
  APPROVED: ["TECHNICAL_REVIEW", "CONVERTED", "CANCELED"],
  REJECTED: ["TECHNICAL_REVIEW", "CANCELED"],
  CONVERTED: [],
  CANCELED: ["TECHNICAL_REVIEW"],
};

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

export function isOnboardingRequestStatus(value: unknown): value is OnboardingRequestStatus {
  return typeof value === "string" && ONBOARDING_REQUEST_STATUSES.includes(value as OnboardingRequestStatus);
}

export function canTransitionOnboardingRequestStatus(
  from: OnboardingRequestStatus,
  to: OnboardingRequestStatus,
): boolean {
  return from === to || ALLOWED_ONBOARDING_STATUS_TRANSITIONS[from].includes(to);
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

function knownSecretValues(input: Partial<CommercialOnboardingInput>): string[] {
  const normalized = normalizeOnboardingInput(input);
  return [
    normalized.posApiToken,
    normalized.revoClientToken,
    normalized.revoWebhookSecret,
    normalized.winerimApiToken,
  ].filter((value) => value.length >= 4);
}

export function redactKnownSecretValues(value: string, input: Partial<CommercialOnboardingInput>): string {
  let redacted = value;
  for (const secret of knownSecretValues(input)) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

export function buildOnboardingRequestPayload(
  input: Partial<CommercialOnboardingInput>,
  gates: OnboardingGate[],
): OnboardingRequestPayload {
  const normalizedInput = sanitizeOnboardingInput(input);
  const redactedGates = gates.map((gate) => ({
    ...gate,
    detail: redactKnownSecretValues(gate.detail, input),
    technicalDetail: gate.technicalDetail ? redactKnownSecretValues(gate.technicalDetail, input) : undefined,
  }));

  return {
    provider: normalizedInput.provider,
    locationName: normalizedInput.locationName,
    posBaseUrl: normalizedInput.posBaseUrl,
    normalizedInput,
    testGates: sanitizeOnboardingGates(redactedGates),
    testSummary: summarizeOnboardingGates(redactedGates),
  };
}
