import type { RuntimeEnvelopeV1, RuntimeLane } from "./contracts";
import { isDeployableRuntimeCanaryConnectionId, runtimeLaneForJob } from "./contracts";
import { createRuntimeEnvelope, sha256Hex } from "./idempotency";
import {
  FIVE_MINUTE_CRON,
  isScheduledConnectionEligible,
  runtimeJobsForConnection,
  scheduledDelaySeconds,
  scheduledSlotIso,
  SCHEDULED_CATALOG_FORMATS,
  type ScheduledRuntimeJob,
  type RuntimeScheduledMessage,
} from "./scheduler";

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const FLEET_PRODUCER_MODE = "fleet-producer" as const;
export const FLEET_SCHEDULED_LANES = Object.freeze([
  "catalog",
  "sales-stock",
  "outbound-queue",
] as const satisfies readonly RuntimeLane[]);

export type FleetScheduledLane = typeof FLEET_SCHEDULED_LANES[number];

export type FleetScopeDatabaseRow = Readonly<{
  connection_id: unknown;
  run_id: unknown;
  generation_mode: unknown;
  deployment_manifest_sha256: unknown;
  writer_fence_grant_sha256: unknown;
  credential_set_sha256: unknown;
  connection_enabled: unknown;
  circuit_breaker_paused_until: unknown;
  intraday_sales_sync_enabled: unknown;
  open_tickets_sync_enabled: unknown;
  runtime_fleet_job_allowlist: unknown;
  credential_kind: unknown;
  credential_provider: unknown;
  key_version: unknown;
  attestation_sha256: unknown;
}>;

export type ActiveFleetScheduledScope = Readonly<{
  connectionId: string;
  runId: string;
  credentialSetSha256: string;
  generationMode: "bootstrap" | "rotate";
  deploymentManifestSha256: string;
  writerFenceGrantSha256: string;
  enabled: true;
  breakerPausedUntil: string | null;
  intradaySalesSyncEnabled: boolean;
  openTicketsSyncEnabled: boolean;
  runtimeFleetJobAllowlist: readonly ScheduledRuntimeJob[];
}>;

export type FleetScopeRejectionCode =
  | "RUNTIME_FLEET_SCOPE_INVALID"
  | "RUNTIME_FLEET_SCOPE_AMBIGUOUS"
  | "RUNTIME_FLEET_CREDENTIAL_AMBIGUOUS"
  | "RUNTIME_FLEET_GENERATION_INCOMPLETE"
  | "RUNTIME_FLEET_GENERATION_HASH_MISMATCH"
  | "RUNTIME_FLEET_SCOPE_RESOLUTION_FAILED";

export type FleetScopeRejection = Readonly<{
  connectionId: string | null;
  code: FleetScopeRejectionCode;
  rowCount: number;
  runIds: readonly string[];
}>;

export type FleetScopeResolution = Readonly<{
  scopes: readonly ActiveFleetScheduledScope[];
  rejections: readonly FleetScopeRejection[];
}>;

type MutableFleetScope = {
  connectionId: string;
  runId: string;
  credentialSetSha256: string;
  generationMode: "bootstrap" | "rotate";
  deploymentManifestSha256: string;
  writerFenceGrantSha256: string;
  enabled: boolean;
  breakerPausedUntil: string | null;
  intradaySalesSyncEnabled: boolean;
  openTicketsSyncEnabled: boolean;
  runtimeFleetJobAllowlist: ScheduledRuntimeJob[];
  credentials: Map<string, {
    provider: string;
    keyVersion: string;
    attestationSha256: string;
  }>;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function boolean(value: unknown): boolean {
  return value === true;
}

const SCHEDULED_JOB_ALLOWLIST = new Set<ScheduledRuntimeJob>([
  "catalog.fetch-winerim",
  "catalog.sync-master",
  "sales.auto-sync",
  "sales.sync-intraday",
  "sales.sync-open-tickets",
  "outbound.process",
]);

function runtimeFleetJobAllowlist(value: unknown): ScheduledRuntimeJob[] {
  if (!Array.isArray(value) || value.length === 0) {
    rejectFleetScope("RUNTIME_FLEET_SCOPE_INVALID");
  }
  const jobs = value.map((job) => text(job));
  if (
    new Set(jobs).size !== jobs.length
    || jobs.some((job) => !SCHEDULED_JOB_ALLOWLIST.has(job as ScheduledRuntimeJob))
  ) {
    rejectFleetScope("RUNTIME_FLEET_SCOPE_INVALID");
  }
  return jobs as ScheduledRuntimeJob[];
}

class FleetScopeResolutionError extends Error {
  constructor(readonly code: FleetScopeRejectionCode) {
    super(code);
    this.name = "FleetScopeResolutionError";
  }
}

function rejectFleetScope(code: FleetScopeRejectionCode): never {
  throw new FleetScopeResolutionError(code);
}

export function parseFleetScheduledLane(value: unknown): FleetScheduledLane | null {
  const normalized = text(value).toLowerCase();
  return FLEET_SCHEDULED_LANES.includes(normalized as FleetScheduledLane)
    ? normalized as FleetScheduledLane
    : null;
}

export function parseFleetScheduledLanes(value: unknown): readonly FleetScheduledLane[] {
  const lanes = String(value ?? "")
    .split(",")
    .map(parseFleetScheduledLane)
    .filter((lane): lane is FleetScheduledLane => !!lane);
  return Object.freeze([...new Set(lanes)]);
}

async function resolveConnectionFleetScope(
  rows: readonly FleetScopeDatabaseRow[],
): Promise<ActiveFleetScheduledScope | null> {
  let scope: MutableFleetScope | undefined;
  const activeRuns = new Set<string>();
  for (const row of rows) {
    const connectionId = text(row.connection_id);
    const runId = text(row.run_id);
    const generationMode = text(row.generation_mode).toLowerCase();
    const deploymentManifestSha256 = text(row.deployment_manifest_sha256).toLowerCase();
    const writerFenceGrantSha256 = text(row.writer_fence_grant_sha256).toLowerCase();
    const credentialSetSha256 = text(row.credential_set_sha256).toLowerCase();
    const jobAllowlist = runtimeFleetJobAllowlist(row.runtime_fleet_job_allowlist);
    if (
      !isDeployableRuntimeCanaryConnectionId(connectionId)
      || !RUN_ID_PATTERN.test(runId)
      || !["bootstrap", "rotate"].includes(generationMode)
      || !SHA256_PATTERN.test(deploymentManifestSha256)
      || !SHA256_PATTERN.test(writerFenceGrantSha256)
      || !SHA256_PATTERN.test(credentialSetSha256)
    ) rejectFleetScope("RUNTIME_FLEET_SCOPE_INVALID");

    activeRuns.add(runId);
    if (activeRuns.size !== 1) rejectFleetScope("RUNTIME_FLEET_SCOPE_AMBIGUOUS");

    const breakerPausedUntil = row.circuit_breaker_paused_until === null
      ? null
      : text(row.circuit_breaker_paused_until);
    const current = scope ?? {
      connectionId,
      runId,
      credentialSetSha256,
      generationMode: generationMode as "bootstrap" | "rotate",
      deploymentManifestSha256,
      writerFenceGrantSha256,
      enabled: boolean(row.connection_enabled),
      breakerPausedUntil,
      intradaySalesSyncEnabled: boolean(row.intraday_sales_sync_enabled),
      openTicketsSyncEnabled: boolean(row.open_tickets_sync_enabled),
      runtimeFleetJobAllowlist: jobAllowlist,
      credentials: new Map(),
    };
    if (
      current.connectionId !== connectionId
      || current.runId !== runId
      || current.credentialSetSha256 !== credentialSetSha256
      || current.generationMode !== generationMode
      || current.deploymentManifestSha256 !== deploymentManifestSha256
      || current.writerFenceGrantSha256 !== writerFenceGrantSha256
      || current.enabled !== boolean(row.connection_enabled)
      || current.breakerPausedUntil !== breakerPausedUntil
      || current.intradaySalesSyncEnabled !== boolean(row.intraday_sales_sync_enabled)
      || current.openTicketsSyncEnabled !== boolean(row.open_tickets_sync_enabled)
      || current.runtimeFleetJobAllowlist.join("\n") !== jobAllowlist.join("\n")
    ) rejectFleetScope("RUNTIME_FLEET_SCOPE_AMBIGUOUS");

    const kind = text(row.credential_kind);
    if (current.credentials.has(kind)) {
      rejectFleetScope("RUNTIME_FLEET_CREDENTIAL_AMBIGUOUS");
    }
    current.credentials.set(kind, {
      provider: text(row.credential_provider),
      keyVersion: text(row.key_version),
      attestationSha256: text(row.attestation_sha256).toLowerCase(),
    });
    scope = current;
  }

  if (!scope || !scope.enabled) return null;
  if (scope.credentials.size !== 2) {
    rejectFleetScope("RUNTIME_FLEET_GENERATION_INCOMPLETE");
  }
  const agora = scope.credentials.get("agora");
  const winerim = scope.credentials.get("winerim");
  if (
    !agora
    || !winerim
    || agora.provider !== "agora"
    || winerim.provider !== "agora"
    || !KEY_VERSION_PATTERN.test(agora.keyVersion)
    || winerim.keyVersion !== agora.keyVersion
    || !SHA256_PATTERN.test(agora.attestationSha256)
    || !SHA256_PATTERN.test(winerim.attestationSha256)
  ) rejectFleetScope("RUNTIME_FLEET_GENERATION_INCOMPLETE");
  const recomputed = await sha256Hex([
    "winerim-runtime-credential-set",
    "1",
    scope.connectionId,
    scope.runId,
    agora.keyVersion,
    agora.attestationSha256,
    winerim.attestationSha256,
  ].join("|"));
  if (recomputed !== scope.credentialSetSha256) {
    rejectFleetScope("RUNTIME_FLEET_GENERATION_HASH_MISMATCH");
  }
  return Object.freeze({
    connectionId: scope.connectionId,
    runId: scope.runId,
    credentialSetSha256: scope.credentialSetSha256,
    generationMode: scope.generationMode,
    deploymentManifestSha256: scope.deploymentManifestSha256,
    writerFenceGrantSha256: scope.writerFenceGrantSha256,
    enabled: true,
    breakerPausedUntil: scope.breakerPausedUntil,
    intradaySalesSyncEnabled: scope.intradaySalesSyncEnabled,
    openTicketsSyncEnabled: scope.openTicketsSyncEnabled,
    runtimeFleetJobAllowlist: Object.freeze([...scope.runtimeFleetJobAllowlist]),
  });
}

export async function resolveActiveFleetScheduledScopesWithDiagnostics(
  rows: readonly FleetScopeDatabaseRow[],
): Promise<FleetScopeResolution> {
  const groupedRows = new Map<string, {
    connectionId: string | null;
    rows: FleetScopeDatabaseRow[];
  }>();
  rows.forEach((row, index) => {
    const candidate = text(row.connection_id);
    const connectionId = isDeployableRuntimeCanaryConnectionId(candidate) ? candidate : null;
    const key = connectionId ?? `invalid-row-${index}`;
    const group = groupedRows.get(key) ?? { connectionId, rows: [] };
    group.rows.push(row);
    groupedRows.set(key, group);
  });

  const scopes: ActiveFleetScheduledScope[] = [];
  const rejections: FleetScopeRejection[] = [];
  for (const group of groupedRows.values()) {
    try {
      const resolved = await resolveConnectionFleetScope(group.rows);
      if (resolved) scopes.push(resolved);
    } catch (error) {
      const code = error instanceof FleetScopeResolutionError
        ? error.code
        : "RUNTIME_FLEET_SCOPE_RESOLUTION_FAILED";
      rejections.push(Object.freeze({
        connectionId: group.connectionId,
        code,
        rowCount: group.rows.length,
        runIds: Object.freeze([...new Set(group.rows.map((row) => text(row.run_id)).filter(Boolean))].sort()),
      }));
    }
  }

  return Object.freeze({
    scopes: Object.freeze(scopes.sort((left, right) => (
    left.connectionId.localeCompare(right.connectionId)
    ))),
    rejections: Object.freeze(rejections.sort((left, right) => (
      (left.connectionId ?? "").localeCompare(right.connectionId ?? "")
    ))),
  });
}

export async function resolveActiveFleetScheduledScopes(
  rows: readonly FleetScopeDatabaseRow[],
): Promise<readonly ActiveFleetScheduledScope[]> {
  const resolution = await resolveActiveFleetScheduledScopesWithDiagnostics(rows);
  for (const rejection of resolution.rejections) {
    console.warn(JSON.stringify({
      event: "runtime_fleet_scope_rejected",
      ...rejection,
    }));
  }
  return resolution.scopes;
}

export function fleetEnvelopeEventId(
  scope: Pick<ActiveFleetScheduledScope, "runId" | "credentialSetSha256">,
  messageId: string,
): string {
  return `fleet:${scope.runId}:${scope.credentialSetSha256}:${messageId}`;
}

export function isEnvelopeInsideFleetGeneration(
  envelope: RuntimeEnvelopeV1,
  lane: FleetScheduledLane,
): boolean {
  const scope = envelope.runtimeScope;
  return envelope.lane === lane
    && !!scope
    && RUN_ID_PATTERN.test(scope.runId)
    && SHA256_PATTERN.test(scope.credentialSetSha256)
    && envelope.source.kind === "queue"
    && envelope.source.eventId === fleetEnvelopeEventId(scope, envelope.messageId);
}

export async function buildFleetScheduledRuntimeMessages(input: {
  cron: string;
  scheduledTimeMs: number;
  lane: FleetScheduledLane;
  scopes: readonly ActiveFleetScheduledScope[];
  allowOneMinuteReconciliation?: boolean;
}): Promise<RuntimeScheduledMessage[]> {
  const oneMinuteReconciliation = input.cron === "* * * * *"
    && input.allowOneMinuteReconciliation === true
    && input.lane === "catalog";
  if (input.cron !== FIVE_MINUTE_CRON && !oneMinuteReconciliation) return [];
  const slot = oneMinuteReconciliation
    ? new Date(Math.floor(input.scheduledTimeMs / 60_000) * 60_000).toISOString()
    : scheduledSlotIso(input.scheduledTimeMs);
  const messages: RuntimeScheduledMessage[] = [];
  for (const scope of input.scopes) {
    if (!isScheduledConnectionEligible(scope, input.scheduledTimeMs)) continue;
    const jobAllowlist = Array.isArray(scope.runtimeFleetJobAllowlist)
      ? scope.runtimeFleetJobAllowlist
      : runtimeJobsForConnection(scope);
    const jobs = runtimeJobsForConnection(scope)
      .filter((job) => jobAllowlist.includes(job))
      .filter((job) => runtimeLaneForJob(job) === input.lane)
      ;
    for (const job of jobs) {
      const delaySeconds = scheduledDelaySeconds(
        scope.connectionId,
        job,
        oneMinuteReconciliation ? 60 : 300,
      );
      const availableAt = new Date(input.scheduledTimeMs + delaySeconds * 1000).toISOString();
      const envelope = await createRuntimeEnvelope({
        connectionId: scope.connectionId,
        job,
        dedupeScope: `fleet:${scope.runId}:${scope.credentialSetSha256}:cron:${slot}`,
        payload: job === "catalog.sync-master"
          ? { scheduled: true, formatTypes: [...SCHEDULED_CATALOG_FORMATS] }
          : { scheduled: true },
        createdAt: new Date(input.scheduledTimeMs).toISOString(),
        availableAt,
        source: {
          kind: "queue",
          eventId: `fleet-pending:${scope.runId}:${scope.credentialSetSha256}:${slot}`,
          scheduledSlot: slot,
          trigger: input.cron,
        },
      });
      const scopedEnvelope: RuntimeEnvelopeV1 = {
        ...envelope,
        runtimeScope: {
          runId: scope.runId,
          credentialSetSha256: scope.credentialSetSha256,
        },
        source: {
          ...envelope.source,
          eventId: fleetEnvelopeEventId(scope, envelope.messageId),
        },
      };
      messages.push({ envelope: scopedEnvelope, delaySeconds });
    }
  }
  return messages;
}
