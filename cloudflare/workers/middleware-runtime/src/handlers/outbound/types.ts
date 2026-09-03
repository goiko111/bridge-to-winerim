import type { JsonValue } from "../../contracts";
import type { RuntimeFailure, RuntimeFailureClass, RuntimeFailureInput } from "../../retry";

export type OutboundTaskStatus = "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "BLOCKED";

export type OutboundTask = {
  id: string;
  connectionId: string;
  provider: string;
  taskType: string;
  payload: JsonValue;
  status: "RUNNING";
  /** Attempts includes the atomic QUEUED -> RUNNING claim performed for this execution. */
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt?: string;
  idempotencyKey?: string;
  externalId?: string | null;
};

export type OutboundClaimPlan = {
  connectionId: string;
  provider?: string;
  taskTypes: readonly string[];
  limit: number;
  readyAt: string;
  fromStatus: "QUEUED";
  toStatus: "RUNNING";
  incrementAttempts: true;
  locking: "FOR_UPDATE_SKIP_LOCKED";
  orderBy: readonly ["next_retry_at", "created_at", "id"];
};

export type OutboundSupersededEvidence = {
  verified: true;
  taskId: string;
  connectionId: string;
  observedAt: string;
  source: "provider_readback" | "provider_master" | "tracking";
  detail?: string;
};

export type OutboundExecutionResult =
  | { kind: "success"; externalId?: string; detail?: string }
  | { kind: "failure"; failure: Omit<RuntimeFailureInput, "profile"> }
  | { kind: "blocked"; reason: string; detail?: string }
  | { kind: "superseded"; evidence: OutboundSupersededEvidence };

export type OutboundTaskDecision =
  | {
      action: "complete";
      status: "SUCCESS";
      externalId?: string;
      terminalReason?: "SUPERSEDED_VERIFIED";
      detail?: string;
    }
  | {
      action: "retry";
      status: "QUEUED";
      nextRetryAt: string;
      failure: RuntimeFailure;
      lastError: string;
    }
  | {
      action: "terminal";
      status: "FAILED" | "BLOCKED";
      terminalReason:
        | "NON_RETRYABLE"
        | "ATTEMPTS_EXHAUSTED"
        | "DEPENDENCY_BLOCKED"
        | "INVALID_SUPERSEDED_EVIDENCE";
      lastError: string;
      failure?: RuntimeFailure;
    }
  | {
      action: "defer";
      status: "QUEUED";
      nextRetryAt: string;
      reason: "BREAKER_OPEN" | "LIMITER_UNAVAILABLE";
      /** A task claimed but never executed must not consume an execution attempt. */
      restoreClaimedAttempt: true;
      lastError: string;
    };

export type OutboundBreakerState = {
  consecutiveFailures: number;
  pausedUntil: string | null;
  reason: string | null;
  revision?: string | number;
};

export type OutboundBreakerPolicy = {
  posDownThreshold: number;
  posDownPauseMs: number;
  posOverloadedThreshold: number;
  posOverloadedPauseMs: number;
};

export type OutboundBreakerEvent =
  | { kind: "success" }
  | { kind: "failure"; failureClass: RuntimeFailureClass };

export type OutboundBreakerTransition = {
  event: OutboundBreakerEvent;
  previous: OutboundBreakerState;
  next: OutboundBreakerState;
  changed: boolean;
  opened: boolean;
};

export type OutboundRateLimiterPlan = {
  algorithm: "sliding-window";
  scope: "provider_connection";
  maxRequests: 2;
  windowMs: 1_000;
  sharedAcrossIsolates: true;
  requiresAtomicReservation: true;
};

export type OutboundRateLimitRequest = {
  key: string;
  provider: string;
  connectionId: string;
  taskId: string;
  requestedAt: string;
  plan: OutboundRateLimiterPlan;
};

export type OutboundRateLimitPermit = {
  granted: true;
  waitedMs: number;
  reservedAt?: string;
};

export type OutboundExecutionContext = {
  idempotencyKey: string;
  attempt: number;
  maxAttempts: number;
};

export type OutboundExecutionLog = {
  event: "outbound.execution" | "outbound.batch.skipped" | "outbound.claim.invalid";
  at: string;
  connectionId: string;
  provider: string;
  outcome: string;
  taskId?: string;
  taskType?: string;
  attempt?: number;
  maxAttempts?: number;
  httpStatus?: number;
  failureClass?: RuntimeFailureClass;
  terminalReason?: string;
  nextRetryAt?: string;
  limiterWaitMs?: number;
  durationMs?: number;
  breakerFailures?: number;
  breakerPausedUntil?: string | null;
  error?: string;
  detail?: JsonValue;
};

export type OutboundPorts = {
  clock: {
    now(): Date;
  };
  tasks: {
    /** This operation must atomically claim rows according to the supplied locking plan. */
    claim(plan: OutboundClaimPlan): Promise<readonly OutboundTask[]>;
    transition(task: OutboundTask, decision: OutboundTaskDecision): Promise<void>;
  };
  breaker: {
    read(connectionId: string): Promise<OutboundBreakerState>;
    /** Implementations must apply this event atomically, not persist the caller's stale state. */
    record(input: {
      connectionId: string;
      occurredAt: string;
      event: OutboundBreakerEvent;
      policy: OutboundBreakerPolicy;
    }): Promise<OutboundBreakerState>;
  };
  limiter: {
    /** Resolve only after a globally coordinated permit has been reserved. */
    acquire(request: OutboundRateLimitRequest): Promise<OutboundRateLimitPermit>;
  };
  executor: {
    execute(task: OutboundTask, context: OutboundExecutionContext): Promise<OutboundExecutionResult>;
  };
  logger: {
    write(record: OutboundExecutionLog): Promise<void>;
  };
};

export type OutboundBatchInput = {
  connectionId: string;
  provider: string;
  taskTypes: readonly string[];
  limit?: number;
};

export type OutboundBatchSummary = {
  claimed: number;
  completed: number;
  superseded: number;
  retried: number;
  terminal: number;
  blocked: number;
  deferred: number;
  invalidClaims: number;
  skippedByBreaker: boolean;
};
