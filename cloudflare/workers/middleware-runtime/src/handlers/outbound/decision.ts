import { classifyRuntimeFailure, retryDelaySeconds } from "../../retry";
import { sanitizeOutboundText } from "./logging";
import type {
  OutboundExecutionResult,
  OutboundSupersededEvidence,
  OutboundTask,
  OutboundTaskDecision,
} from "./types";

export function isVerifiedSupersededEvidence(
  task: Pick<OutboundTask, "id" | "connectionId">,
  evidence: OutboundSupersededEvidence,
): boolean {
  return evidence.verified === true &&
    evidence.taskId === task.id &&
    evidence.connectionId === task.connectionId &&
    ["provider_readback", "provider_master", "tracking"].includes(evidence.source) &&
    Number.isFinite(Date.parse(evidence.observedAt));
}

export function decideOutboundTask(
  task: OutboundTask,
  result: OutboundExecutionResult,
  decidedAt: Date | string,
): OutboundTaskDecision {
  const now = decidedAt instanceof Date ? decidedAt : new Date(decidedAt);
  if (!Number.isFinite(now.getTime())) throw new Error("outbound_decision_time_invalid");

  if (result.kind === "success") {
    return {
      action: "complete",
      status: "SUCCESS",
      externalId: result.externalId,
      detail: result.detail ? sanitizeOutboundText(result.detail) : undefined,
    };
  }

  if (result.kind === "superseded") {
    if (!isVerifiedSupersededEvidence(task, result.evidence)) {
      return {
        action: "terminal",
        status: "BLOCKED",
        terminalReason: "INVALID_SUPERSEDED_EVIDENCE",
        lastError: "superseded_requires_exact_verified_readback",
      };
    }
    return {
      action: "complete",
      status: "SUCCESS",
      terminalReason: "SUPERSEDED_VERIFIED",
      detail: sanitizeOutboundText(result.evidence.detail ?? result.evidence.source),
    };
  }

  if (result.kind === "blocked") {
    return {
      action: "terminal",
      status: "BLOCKED",
      terminalReason: "DEPENDENCY_BLOCKED",
      lastError: sanitizeOutboundText(result.detail ?? result.reason),
    };
  }

  const failure = classifyRuntimeFailure({ ...result.failure, profile: "POS_OUTBOUND" });
  const lastError = sanitizeOutboundText(result.failure.message ?? failure.reason);
  if (!failure.retryable) {
    return {
      action: "terminal",
      status: "FAILED",
      terminalReason: "NON_RETRYABLE",
      lastError,
      failure,
    };
  }
  if (task.attempts >= task.maxAttempts) {
    return {
      action: "terminal",
      status: "FAILED",
      terminalReason: "ATTEMPTS_EXHAUSTED",
      lastError,
      failure,
    };
  }

  const delaySeconds = retryDelaySeconds("POS_OUTBOUND", task.attempts);
  return {
    action: "retry",
    status: "QUEUED",
    nextRetryAt: new Date(now.getTime() + delaySeconds * 1_000).toISOString(),
    failure,
    lastError,
  };
}
