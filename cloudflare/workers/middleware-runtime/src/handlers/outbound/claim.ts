import type { OutboundClaimPlan, OutboundTask } from "./types";

const MIN_CLAIM_LIMIT = 1;
const MAX_CLAIM_LIMIT = 100;

function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}_required`);
  return normalized;
}

export function buildOutboundClaimPlan(input: {
  connectionId: string;
  provider?: string;
  taskTypes: readonly string[];
  limit?: number;
  readyAt: Date | string;
}): OutboundClaimPlan {
  const taskTypes = [...new Set(input.taskTypes.map((value) => value.trim()).filter(Boolean))].sort();
  if (taskTypes.length === 0) throw new Error("outbound_task_types_required");

  const rawLimit = Number.isFinite(input.limit) ? Math.floor(input.limit as number) : 10;
  const limit = Math.min(MAX_CLAIM_LIMIT, Math.max(MIN_CLAIM_LIMIT, rawLimit));
  const readyAt = input.readyAt instanceof Date ? input.readyAt : new Date(input.readyAt);
  if (!Number.isFinite(readyAt.getTime())) throw new Error("outbound_ready_at_invalid");

  return {
    connectionId: requireIdentifier(input.connectionId, "connection_id"),
    provider: input.provider ? requireIdentifier(input.provider, "provider") : undefined,
    taskTypes,
    limit,
    readyAt: readyAt.toISOString(),
    fromStatus: "QUEUED",
    toStatus: "RUNNING",
    incrementAttempts: true,
    locking: "FOR_UPDATE_SKIP_LOCKED",
    orderBy: ["next_retry_at", "created_at", "id"],
  };
}

export function isClaimedTaskInScope(
  task: OutboundTask,
  scope: Pick<OutboundClaimPlan, "connectionId" | "provider" | "taskTypes">,
): boolean {
  return task.status === "RUNNING" &&
    task.connectionId === scope.connectionId &&
    (!scope.provider || task.provider === scope.provider) &&
    scope.taskTypes.includes(task.taskType) &&
    Number.isInteger(task.attempts) && task.attempts >= 1 &&
    Number.isInteger(task.maxAttempts) && task.maxAttempts >= 1;
}

export function outboundTaskIdempotencyKey(task: Pick<OutboundTask, "id" | "idempotencyKey">): string {
  const explicit = task.idempotencyKey?.trim();
  return explicit || `outbound-task:${task.id}`;
}
