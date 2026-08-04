// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
} from "../../middleware-api/src/db";
import { isRuntimeEnvelope } from "./contracts";
import {
  buildFleetScheduledRuntimeMessages,
  isEnvelopeInsideFleetGeneration,
  resolveActiveFleetScheduledScopes,
  resolveActiveFleetScheduledScopesWithDiagnostics,
  type FleetScopeDatabaseRow,
} from "./fleet";
import { sha256Hex } from "./idempotency";
import { buildScheduledRuntimeMessages } from "./scheduler";
import {
  runRuntimeScheduled,
  type MiddlewareRuntimeEnv,
  type RuntimeQueueProducer,
  type RuntimeQueueSendMessage,
  type RuntimeWorkerDependencies,
} from "./worker";

const CONNECTION_A = "11111111-1111-4111-8111-111111111111";
const CONNECTION_B = "22222222-2222-4222-8222-222222222222";
const SCHEDULED_TIME = Date.parse("2026-08-04T12:00:00.000Z");

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function fakeDatabase(
  route: (statement: { text: string; values: readonly unknown[] }) => QueryResult<Record<string, unknown>>,
): DatabaseAdapter {
  const query = async <Row extends Record<string, unknown>>(
    statement: { text: string; values: readonly unknown[] },
  ) => route(statement) as QueryResult<Row>;
  return {
    query,
    transaction: async (work) => work({ query } as DatabaseTransaction),
  } as DatabaseAdapter;
}

async function generation(connectionId: string, runId: string) {
  const agora = await sha256Hex(`fixture:${runId}:agora`);
  const winerim = await sha256Hex(`fixture:${runId}:winerim`);
  const credentialSetSha256 = await sha256Hex([
    "winerim-runtime-credential-set",
    "1",
    connectionId,
    runId,
    "key-v1",
    agora,
    winerim,
  ].join("|"));
  return { agora, winerim, credentialSetSha256 };
}

async function scopeRows(input: {
  connectionId: string;
  runId: string;
  enabled?: boolean;
  intraday?: boolean;
  openTickets?: boolean;
}): Promise<FleetScopeDatabaseRow[]> {
  const hashes = await generation(input.connectionId, input.runId);
  return (["agora", "winerim"] as const).map((kind) => ({
    connection_id: input.connectionId,
    run_id: input.runId,
    generation_mode: "bootstrap",
    deployment_manifest_sha256: "d".repeat(64),
    writer_fence_grant_sha256: "f".repeat(64),
    credential_set_sha256: hashes.credentialSetSha256,
    connection_enabled: input.enabled ?? true,
    circuit_breaker_paused_until: null,
    intraday_sales_sync_enabled: input.intraday ?? false,
    open_tickets_sync_enabled: input.openTickets ?? false,
    credential_kind: kind,
    credential_provider: "agora",
    key_version: "key-v1",
    attestation_sha256: hashes[kind],
  }));
}

describe("connection-scoped fleet producer", () => {
  it("publishes two active generations with immutable scope identity on one allowed lane", async () => {
    const scopes = await resolveActiveFleetScheduledScopes([
      ...await scopeRows({ connectionId: CONNECTION_B, runId: "run-fleet-b" }),
      ...await scopeRows({ connectionId: CONNECTION_A, runId: "run-fleet-a" }),
    ]);
    const messages = await buildFleetScheduledRuntimeMessages({
      cron: "*/5 * * * *",
      scheduledTimeMs: SCHEDULED_TIME,
      lane: "catalog",
      scopes,
    });

    expect(scopes.map((scope) => scope.connectionId)).toEqual([CONNECTION_A, CONNECTION_B]);
    expect(messages).toHaveLength(4);
    expect(new Set(messages.map(({ envelope }) => envelope.connectionId)))
      .toEqual(new Set([CONNECTION_A, CONNECTION_B]));
    expect(messages.every(({ envelope }) => (
      envelope.lane === "catalog"
      && envelope.runtimeScope !== undefined
      && isEnvelopeInsideFleetGeneration(envelope, "catalog")
    ))).toBe(true);
    expect(messages.every(({ envelope }) => envelope.source.eventId.includes(envelope.messageId)))
      .toBe(true);
  });

  it("quarantines one ambiguous connection without suppressing healthy connections", async () => {
    const resolution = await resolveActiveFleetScheduledScopesWithDiagnostics([
      ...await scopeRows({ connectionId: CONNECTION_A, runId: "run-fleet-a" }),
      ...await scopeRows({ connectionId: CONNECTION_A, runId: "run-fleet-b" }),
      ...await scopeRows({ connectionId: CONNECTION_B, runId: "run-fleet-ok" }),
    ]);

    expect(resolution.scopes.map(({ connectionId }) => connectionId)).toEqual([CONNECTION_B]);
    expect(resolution.rejections).toEqual([{
      connectionId: CONNECTION_A,
      code: "RUNTIME_FLEET_SCOPE_AMBIGUOUS",
      rowCount: 4,
      runIds: ["run-fleet-a", "run-fleet-b"],
    }]);
  });

  it("never publishes inert or incomplete active generations", async () => {
    const inert = await resolveActiveFleetScheduledScopes(
      await scopeRows({ connectionId: CONNECTION_A, runId: "run-inert-a", enabled: false }),
    );
    expect(inert).toEqual([]);

    const incomplete = await scopeRows({ connectionId: CONNECTION_B, runId: "run-incomplete-b" });
    const resolution = await resolveActiveFleetScheduledScopesWithDiagnostics(incomplete.slice(0, 1));
    expect(resolution.scopes).toEqual([]);
    expect(resolution.rejections).toEqual([{
      connectionId: CONNECTION_B,
      code: "RUNTIME_FLEET_GENERATION_INCOMPLETE",
      rowCount: 1,
      runIds: ["run-incomplete-b"],
    }]);
  });

  it("emits structured rejection telemetry and no messages for an invalid connection", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const invalid = await scopeRows({ connectionId: CONNECTION_A, runId: "run-invalid-a" });
    invalid[0] = { ...invalid[0], credential_set_sha256: "invalid" };
    const scopes = await resolveActiveFleetScheduledScopes([
      ...invalid,
      ...await scopeRows({ connectionId: CONNECTION_B, runId: "run-fleet-ok" }),
    ]);
    const messages = await buildFleetScheduledRuntimeMessages({
      cron: "*/5 * * * *",
      scheduledTimeMs: SCHEDULED_TIME,
      lane: "catalog",
      scopes,
    });

    expect(scopes.map(({ connectionId }) => connectionId)).toEqual([CONNECTION_B]);
    expect(messages.every(({ envelope }) => envelope.connectionId === CONNECTION_B)).toBe(true);
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0][0]))).toEqual({
      event: "runtime_fleet_scope_rejected",
      connectionId: CONNECTION_A,
      code: "RUNTIME_FLEET_SCOPE_INVALID",
      rowCount: 2,
      runIds: ["run-invalid-a"],
    });
  });

  it("loads only ACTIVE scopes and needs only the configured lane binding", async () => {
    const rows = [
      ...await scopeRows({ connectionId: CONNECTION_A, runId: "run-fleet-a" }),
      ...await scopeRows({ connectionId: CONNECTION_B, runId: "run-fleet-b" }),
    ];
    const database = fakeDatabase((statement) => {
      expect(statement.text).toContain("scope.status = 'ACTIVE'");
      expect(statement.text).toContain("scope.active = true");
      expect(statement.text).toContain("credentials.active = true");
      return result(rows as Record<string, unknown>[]);
    });
    const catalog = {
      sendBatch: vi.fn(async (_messages: RuntimeQueueSendMessage[]) => undefined),
    } satisfies RuntimeQueueProducer;
    const env: MiddlewareRuntimeEnv = {
      ENVIRONMENT: "rescue-production",
      RUNTIME_MODE: "fleet-producer",
      FLEET_RUNTIME_LANE: "catalog",
      RUNTIME_EXECUTION_ENABLED: "true",
      MIDDLEWARE_DB: { connectionString: "postgres://runtime.invalid/rescue" },
      RUNTIME_EXECUTOR: { fetch: vi.fn() },
      MIDDLEWARE_CATALOG_QUEUE: catalog,
    };
    const dependencies: Required<RuntimeWorkerDependencies> = {
      database: () => database,
      executor: () => ({ execute: vi.fn() }),
    };

    const dispatched = await runRuntimeScheduled(
      { cron: "*/5 * * * *", scheduledTime: SCHEDULED_TIME },
      env,
      dependencies,
    );

    expect(dispatched).toEqual({ status: "dispatched", connections: 2, messages: 4 });
    expect(catalog.sendBatch).toHaveBeenCalledOnce();
    const batch = vi.mocked(catalog.sendBatch).mock.calls[0][0];
    expect(batch).toHaveLength(4);
    expect(batch.every(({ body }) => body.lane === "catalog")).toBe(true);
  });

  it("preserves unscoped canary-compatible envelopes and never schedules rescue canary as fleet", async () => {
    const [legacy] = await buildScheduledRuntimeMessages({
      cron: "*/5 * * * *",
      scheduledTimeMs: SCHEDULED_TIME,
      connections: [{ connectionId: CONNECTION_A, enabled: true }],
    });
    expect(legacy.envelope.runtimeScope).toBeUndefined();
    expect(isRuntimeEnvelope(legacy.envelope)).toBe(true);

    const database = vi.fn(() => fakeDatabase(() => result()));
    const outcome = await runRuntimeScheduled(
      { cron: "*/5 * * * *", scheduledTime: SCHEDULED_TIME },
      {
        ENVIRONMENT: "rescue-production",
        RUNTIME_MODE: "exclusive-canary-consumer",
        RUNTIME_EXECUTION_ENABLED: "true",
      },
      { database, executor: () => ({ execute: vi.fn() }) },
    );
    expect(outcome).toEqual({
      status: "inactive",
      reason: "NOT_STAGING",
      connections: 0,
      messages: 0,
    });
    expect(database).not.toHaveBeenCalled();
  });
});
