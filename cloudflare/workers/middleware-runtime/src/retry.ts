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
  diagnostic?: RuntimeFailureDiagnosticInput;
};

export type RuntimeFailure = {
  class: RuntimeFailureClass;
  retryable: boolean;
  countsForCircuitBreaker: boolean;
  reason: string;
  httpStatus?: number;
  message?: string;
  diagnostic?: RuntimeFailureDiagnostic;
};

export type RuntimeFailureDiagnosticInput = {
  operation?: unknown;
  route?: unknown;
  httpStatus?: unknown;
  elapsedMs?: unknown;
  errorCode?: unknown;
  bodySample?: unknown;
};

export type RuntimeFailureDiagnostic = {
  operation?: string;
  route?: string;
  httpStatus?: number;
  elapsedMs?: number;
  errorCode?: string;
  bodySample?: string;
};

export type RuntimeQueueDisposition =
  | { action: "ack"; reason: "success" | "duplicate" }
  | { action: "retry"; delaySeconds: number; failure: RuntimeFailure }
  | { action: "terminal"; failure: RuntimeFailure; reason: "non_retryable" | "attempts_exhausted" };

const POS_DOWN_PATTERNS = [
  "http_timeout",
  "http_network_error",
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

function sanitizedFailureMessage(value: string | undefined): string | undefined {
  const normalized = (value ?? "")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|api[-_]?token|token|password|secret|api[-_]?key)\b\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

function sanitizedDiagnosticString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|api[-_]?token|token|password|secret|api[-_]?key)\b\s*[:=]\s*([^\s,;&]+)/gi, "$1=[REDACTED]")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function sanitizedDiagnosticStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function sanitizedDiagnosticElapsed(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 600_000
    ? Math.round(value)
    : undefined;
}

function failureDiagnosticDetail(value: RuntimeFailureDiagnosticInput | undefined): RuntimeFailureDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const diagnostic: RuntimeFailureDiagnostic = {
    ...(sanitizedDiagnosticString(value.operation, 80) ? { operation: sanitizedDiagnosticString(value.operation, 80) } : {}),
    ...(sanitizedDiagnosticString(value.route, 160) ? { route: sanitizedDiagnosticString(value.route, 160) } : {}),
    ...(sanitizedDiagnosticStatus(value.httpStatus) !== undefined ? { httpStatus: sanitizedDiagnosticStatus(value.httpStatus) } : {}),
    ...(sanitizedDiagnosticElapsed(value.elapsedMs) !== undefined ? { elapsedMs: sanitizedDiagnosticElapsed(value.elapsedMs) } : {}),
    ...(sanitizedDiagnosticString(value.errorCode, 80) ? { errorCode: sanitizedDiagnosticString(value.errorCode, 80) } : {}),
    ...(sanitizedDiagnosticString(value.bodySample, 256) ? { bodySample: sanitizedDiagnosticString(value.bodySample, 256) } : {}),
  };
  return Object.keys(diagnostic).length > 0 ? diagnostic : undefined;
}

function failureDiagnostics(input: RuntimeFailureInput): Pick<RuntimeFailure, "httpStatus" | "message" | "diagnostic"> {
  const diagnostic = failureDiagnosticDetail(input.diagnostic);
  return {
    ...(typeof input.httpStatus === "number" ? { httpStatus: input.httpStatus } : {}),
    ...(sanitizedFailureMessage(input.message) ? { message: sanitizedFailureMessage(input.message) } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export function classifyRuntimeFailure(input: RuntimeFailureInput): RuntimeFailure {
  const message = (input.message ?? "").toLowerCase();
  const status = input.httpStatus;
  const diagnostics = failureDiagnostics(input);
  const diagnosticErrorCode = typeof input.diagnostic?.errorCode === "string"
    ? input.diagnostic.errorCode.trim().toUpperCase()
    : "";

  if (diagnosticErrorCode === "RUNTIME_EXECUTOR_TIMEOUT"
    || diagnosticErrorCode === "RUNTIME_EXECUTOR_UNAVAILABLE"
    || message.includes("runtime_executor_timeout")
    || message.includes("runtime_executor_unavailable")) {
    return {
      class: "TRANSIENT_UPSTREAM",
      retryable: true,
      countsForCircuitBreaker: false,
      reason: diagnosticErrorCode === "RUNTIME_EXECUTOR_TIMEOUT"
        || message.includes("runtime_executor_timeout")
        ? "runtime_executor_timeout"
        : "runtime_executor_unavailable",
      ...diagnostics,
    };
  }

  if (input.profile === "WINERIM_MUTATION" && status === 409) {
    return {
      class: "WINERIM_CONFLICT",
      retryable: true,
      countsForCircuitBreaker: false,
      reason: "winerim_mutation_conflict",
      ...diagnostics,
    };
  }

  if ([400, 401, 403, 404, 422].includes(status ?? 0)) {
    return {
      class: "BUSINESS_ERROR",
      retryable: false,
      countsForCircuitBreaker: false,
      reason: "request_or_data_requires_correction",
      ...diagnostics,
    };
  }

  if (input.retryableLine === true) {
    return {
      class: "TRANSIENT_UPSTREAM",
      retryable: true,
      countsForCircuitBreaker: false,
      reason: "upstream_line_marked_retryable",
      ...diagnostics,
    };
  }

  if (POS_DOWN_PATTERNS.some((pattern) => message.includes(pattern)) || status === 408) {
    return {
      class: "POS_DOWN",
      retryable: true,
      countsForCircuitBreaker: input.profile === "POS_OUTBOUND",
      reason: "pos_unreachable",
      ...diagnostics,
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
      ...diagnostics,
    };
  }

  if (status === 409 ||
      BUSINESS_ERROR_PATTERNS.some((pattern) => message.includes(pattern))) {
    return {
      class: "BUSINESS_ERROR",
      retryable: false,
      countsForCircuitBreaker: false,
      reason: "request_or_data_requires_correction",
      ...diagnostics,
    };
  }

  return {
    class: "UNKNOWN",
    retryable: true,
    countsForCircuitBreaker: false,
    reason: "unknown_failure_bounded_retry",
    ...diagnostics,
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
