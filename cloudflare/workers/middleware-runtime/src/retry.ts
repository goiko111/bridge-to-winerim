import { RuntimeEnvelopeV1, RuntimeRetryProfile } from "./contracts";

export type RuntimeFailureClass =
  | "POS_DOWN"
  | "POS_OVERLOADED"
  | "BUSINESS_ERROR"
  | "WINERIM_CONFLICT"
  | "TRANSIENT_UPSTREAM"
  | "UNKNOWN";

export type RuntimeFailureInput = {
  profile: RuntimeRetryProfile;
  httpStatus?: number;
  message?: string;
  retryableLine?: boolean;
};

export type RuntimeFailure = {
  class: RuntimeFailureClass;
  retryable: boolean;
  countsForCircuitBreaker: boolean;
  reason: string;
};

export type RuntimeQueueDisposition =
  | { action: "ack"; reason: "success" | "duplicate" }
  | { action: "retry"; delaySeconds: number; failure: RuntimeFailure }
  | { action: "terminal"; failure: RuntimeFailure; reason: "non_retryable" | "attempts_exhausted" };

const POS_DOWN_PATTERNS = [
  "connection refused",
  "no route to host",
  "connect error",
  "aborterror",
  "signal has been aborted",
  "network is unreachable",
  "dns error",
  "failed to lookup address",
  "tcp connect error",
  "timed out",
  "timeout",
  "connection reset",
];

const BUSINESS_ERROR_PATTERNS = [
  "business_error",
  "data error",
  "validation",
  "not found",
  "forbidden",
  "duplicate key",
  "duplicate_key",
  "duplicate family",
  "duplicate_family",
  "product already exists",
  "product_already_exists",
  "wine_inactive",
  "serve_by_glass_not_enabled",
  "missing_bottle_sale_price",
  "missing_glass_sale_price",
  "missing_magnum_sale_price",
];

export function classifyRuntimeFailure(input: RuntimeFailureInput): RuntimeFailure {
  const message = (input.message ?? "").toLowerCase();
  const status = input.httpStatus;

  if (input.profile === "WINERIM_MUTATION" && status === 409) {
    return {
      class: "WINERIM_CONFLICT",
      retryable: true,
      countsForCircuitBreaker: false,
      reason: "winerim_mutation_conflict",
    };
  }

  if ([400, 401, 403, 404, 422].includes(status ?? 0)) {
    return {
      class: "BUSINESS_ERROR",
      retryable: false,
      countsForCircuitBreaker: false,
      reason: "request_or_data_requires_correction",
    };
  }

  if (input.retryableLine === true) {
    return {
      class: "TRANSIENT_UPSTREAM",
      retryable: true,
      countsForCircuitBreaker: false,
      reason: "upstream_line_marked_retryable",
    };
  }

  if (POS_DOWN_PATTERNS.some((pattern) => message.includes(pattern)) || status === 408) {
    return {
      class: "POS_DOWN",
      retryable: true,
      countsForCircuitBreaker: input.profile === "POS_OUTBOUND",
      reason: "pos_unreachable",
    };
  }

  if (status === 429 || (status !== undefined && status >= 500 && status <= 504) ||
      message.includes("sql pool") || message.includes("too many requests") ||
      message.includes("rate limit")) {
    return {
      class: input.profile === "POS_OUTBOUND" ? "POS_OVERLOADED" : "TRANSIENT_UPSTREAM",
      retryable: true,
      countsForCircuitBreaker: input.profile === "POS_OUTBOUND",
      reason: "upstream_overloaded",
    };
  }

  if (status === 409 ||
      BUSINESS_ERROR_PATTERNS.some((pattern) => message.includes(pattern))) {
    return {
      class: "BUSINESS_ERROR",
      retryable: false,
      countsForCircuitBreaker: false,
      reason: "request_or_data_requires_correction",
    };
  }

  return {
    class: "UNKNOWN",
    retryable: true,
    countsForCircuitBreaker: false,
    reason: "unknown_failure_bounded_retry",
  };
}

export function retryDelaySeconds(profile: RuntimeRetryProfile, attempts: number): number {
  const normalizedAttempts = Math.max(1, Math.floor(attempts));
  if (profile === "WINERIM_MUTATION") return 1;
  if (profile === "POS_OUTBOUND") {
    return Math.min(60 * 60, Math.pow(2, normalizedAttempts) * 60);
  }
  return Math.min(5 * 60, 5 * Math.pow(2, normalizedAttempts - 1));
}

export function decideRuntimeQueueDisposition(input: {
  envelope: RuntimeEnvelopeV1;
  deliveryAttempts: number;
  failure?: RuntimeFailureInput;
  duplicate?: boolean;
}): RuntimeQueueDisposition {
  if (input.duplicate) return { action: "ack", reason: "duplicate" };
  if (!input.failure) return { action: "ack", reason: "success" };

  const failure = classifyRuntimeFailure({
    ...input.failure,
    profile: input.envelope.retryProfile,
  });
  if (!failure.retryable) {
    return { action: "terminal", failure, reason: "non_retryable" };
  }

  const attempts = Math.max(1, input.deliveryAttempts, input.envelope.attempt + 1);
  if (attempts >= input.envelope.maxAttempts) {
    return { action: "terminal", failure, reason: "attempts_exhausted" };
  }

  return {
    action: "retry",
    delaySeconds: retryDelaySeconds(input.envelope.retryProfile, attempts),
    failure,
  };
}
